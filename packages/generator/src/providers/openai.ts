import OpenAI from "openai";
import type { Provider, ProviderCredential, ProviderRequest } from "./types";
import { RefusalError, TruncationError } from "./types";
import { logUsage } from "./usage";
import type { UsageInfo } from "./usage";
import { conversationHeaders } from "./session";

function messagesFor(req: ProviderRequest) {
  // OpenAI-compatible caching is automatic on a long-enough shared prefix — there are no
  // explicit breakpoints to place. Keeping the stable half in the system message and the
  // volatile half in the user message is what makes that prefix stable.
  const system = req.context ? `${req.system}\n\n${req.context}` : req.system;
  return [
    { role: "system" as const, content: system },
    { role: "user" as const, content: req.user },
  ];
}

function usageFrom(usage: OpenAI.CompletionUsage | null | undefined): UsageInfo | null {
  if (!usage) return null;
  return {
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
    // OpenAI's own automatic prompt-caching signal — no breakpoint to place, unlike
    // Anthropic, but still worth surfacing: this is the only way to tell whether the
    // "automatic on a long-enough shared prefix" caching mentioned above is actually
    // happening on a given provider/gateway, rather than assuming it from the doc comment.
    // `cache_write_tokens` is not in the SDK's own type (an extension this gateway adds on
    // top of the standard `prompt_tokens_details` shape) — read structurally rather than
    // widening the imported type for one field.
    cacheReadTokens: usage.prompt_tokens_details?.cached_tokens,
    cacheWriteTokens: (
      usage.prompt_tokens_details as { cache_write_tokens?: number } | undefined
    )?.cache_write_tokens,
  };
}

export function createOpenAIProvider(credential: ProviderCredential): Provider {
  const client = new OpenAI({
    apiKey: credential.apiKey,
    baseURL: credential.baseUrl || undefined,
  });

  return {
    id: "openai",

    async *streamText(model, req) {
      const stream = await client.chat.completions.create(
        {
          model,
          // `max_tokens` is the broadly compatible field. OpenAI's own newer reasoning
          // models reject it and require `max_completion_tokens` — see .env.example.
          max_tokens: req.maxTokens,
          stream: true,
          // Without this, a streaming response never reports usage at all — the final
          // chunk (choices: [], usage: {...}) simply wouldn't be sent.
          stream_options: { include_usage: true },
          messages: messagesFor(req),
        },
        { signal: req.signal, headers: conversationHeaders(req.conversationId) },
      );

      let sawContent = false;
      // Set, not thrown, the moment we see it (testing-review.md S14) — thrown only after
      // the loop, alongside the abort check below. Throwing the instant `finish_reason:
      // "length"` is seen would skip the usage chunk that (per the comment just above this
      // loop) arrives afterward with an empty `choices` array, losing `logUsage` for exactly
      // the responses whose token accounting matters most for diagnosing this. It would also
      // race the abort check below in the wrong direction: an aborted call whose last visible
      // chunk happens to carry `finish_reason: "length"` must still surface as the abort (see
      // that comment), not as a truncation.
      let truncated = false;
      let usage: OpenAI.CompletionUsage | null | undefined;
      for await (const event of stream) {
        // The usage-bearing chunk has an empty `choices` array, so this has to be checked
        // before the `if (!choice) continue` below skips past it entirely.
        if (event.usage) usage = event.usage;

        const choice = event.choices?.[0];
        if (!choice) continue;
        if (choice.finish_reason === "content_filter") {
          throw new RefusalError("content_filter");
        }
        if (choice.finish_reason === "length") {
          truncated = true;
        }
        const delta = choice.delta?.content;
        if (delta) {
          sawContent = true;
          yield delta;
        }
      }
      // An aborted signal ends this SDK's stream iterator as a silent, non-throwing
      // `return` — unlike `completeText` below, whose non-streaming call really does throw
      // `APIUserAbortError`. Left alone, the loop above just stops early and every caller
      // reads a truncated response as a complete one: `internal.ts` persisted a half-written
      // document as `complete` when a viewer closed the tab mid-fill (testing-review.md S8),
      // and its `catch (isAbortError) -> resetForRetry` guard — written for exactly this
      // case — could never fire, because nothing threw. Raising the SDK's own abort error
      // here makes the streaming path match the non-streaming one, so `isAbortError`
      // (client.ts) recognises it and every existing guard works as already documented.
      //
      // Must come BEFORE the `sawContent`/`truncated` checks: an abort landing before the
      // first delta would otherwise surface as `RefusalError("empty response")`, which the
      // studio reports to the user as the model having declined the request — an abort must
      // win over both of the other post-loop checks, not just the sawContent one.
      if (req.signal?.aborted) throw new OpenAI.APIUserAbortError();
      // Logged before either the truncation or the empty-content check below can throw, so
      // usage is recorded for both of those outcomes too, not only a clean completion — the
      // check order here is abort, then usage, then truncation, then empty-content (S14).
      logUsage(req.label, "openai", usageFrom(usage));
      // Checked before `sawContent`: a response truncated right at the start (no visible
      // text at all yet) must surface as "we cut it off", not "the model declined" — those
      // call for different follow-ups (retry with a bigger budget vs. don't retry at all).
      if (truncated) throw new TruncationError(req.maxTokens);
      if (!sawContent) throw new RefusalError("empty response", "empty");
    },

    async completeText(model, req) {
      const completion = await client.chat.completions.create(
        {
          model,
          max_tokens: req.maxTokens,
          messages: messagesFor(req),
        },
        { signal: req.signal, headers: conversationHeaders(req.conversationId) },
      );
      logUsage(req.label, "openai", usageFrom(completion.usage));
      const choice = completion.choices[0];
      if (choice?.finish_reason === "content_filter") {
        throw new RefusalError("content_filter");
      }
      // See the matching streamText check (testing-review.md S14): a budget cutoff is worth
      // retrying with more tokens, a refusal is not, so this must not collapse into
      // `RefusalError("empty response")` below when the truncation also happened to leave no
      // usable text.
      if (choice?.finish_reason === "length") {
        throw new TruncationError(req.maxTokens);
      }
      const text = choice?.message?.content;
      if (!text) throw new RefusalError("empty response", "empty");
      return text;
    },

    async validate(model, signal) {
      // No generation is in scope for a bare credential-validation ping — this always uses
      // the process-stable fallback id (see conversationHeaders' doc comment), never a fresh
      // one per call.
      await client.chat.completions.create(
        { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
        { signal, headers: conversationHeaders(undefined) },
      );
    },
  };
}

export function isOpenAIAbort(error: unknown): boolean {
  return error instanceof OpenAI.APIUserAbortError;
}
