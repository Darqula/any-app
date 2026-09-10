import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderCredential, ProviderRequest } from "./types";
import { RefusalError, TruncationError } from "./types";
import { logUsage } from "./usage";
import type { UsageInfo } from "./usage";
// Applied here too, not just in openai.ts: `ANTHROPIC_BASE_URL` is confirmed able to point
// at this exact "zen" gateway's Anthropic-shaped endpoint (`/zen/go/v1/messages` — see
// CLAUDE.md and open-problems.md's Phase 3.5 findings), which shares the same "Console Go"
// routing layer the 2026-09-07 400 names — there is no reason to expect that layer's session
// requirement to apply to one of its two endpoints and not the other. Harmless against real
// api.anthropic.com either way: an extra custom header there is simply ignored.
import { conversationHeaders } from "./session";

/**
 * The system prompt and the per-app context go in `system` as a single text block carrying
 * a cache breakpoint; the volatile instruction goes in `messages`. That places the
 * breakpoint exactly at the boundary between what repeats and what does not — which is the
 * whole reason this adapter exists rather than routing through the OpenAI-compatible shim.
 */
function systemFor(req: ProviderRequest) {
  const text = req.context ? `${req.system}\n\n${req.context}` : req.system;
  return [{ type: "text" as const, text, cache_control: { type: "ephemeral" as const } }];
}

/** Loosely typed on purpose — the SDK's own usage shape is matched structurally here
 * rather than importing its exact exported type name, since the fields read are the ones
 * confirmed live against a real Messages-API response. */
interface AnthropicUsageShape {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

function usageFrom(usage: AnthropicUsageShape | undefined): UsageInfo | null {
  if (!usage) return null;
  return {
    promptTokens: usage.input_tokens,
    completionTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? undefined,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? undefined,
  };
}

export function createAnthropicProvider(credential: ProviderCredential): Provider {
  const client = new Anthropic({
    apiKey: credential.apiKey,
    // Undefined falls through to the SDK's own default (api.anthropic.com). Confirmed live
    // this can also be pointed at a third-party gateway that speaks the real Anthropic
    // Messages API wire format — see the doc comment on ProviderCredential.baseUrl.
    baseURL: credential.baseUrl || undefined,
  });

  return {
    id: "anthropic",

    async *streamText(model, req) {
      const stream = client.messages.stream(
        {
          model,
          max_tokens: req.maxTokens,
          system: systemFor(req),
          messages: [{ role: "user", content: req.user }],
        },
        { signal: req.signal, headers: conversationHeaders(req.conversationId) },
      );

      let sawContent = false;
      for await (const event of stream) {
        // Only text deltas. `thinking_delta` events also arrive on models with adaptive
        // thinking, and emitting those into the document would write reasoning into the
        // generated app.
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          sawContent = true;
          yield event.delta.text;
        }
      }

      // See the matching comment in providers/openai.ts (testing-review.md S8): an aborted
      // signal ends this SDK's stream iterator as a silent, non-throwing `return`, so
      // without this every caller would read a truncated response as a complete one and the
      // `isAbortError` guards downstream could never fire. Raised before `finalMessage()`
      // too — that would otherwise reject or report a partial message for an aborted stream.
      if (req.signal?.aborted) throw new Anthropic.APIUserAbortError();

      // A refusal is HTTP 200 with `stop_reason: "refusal"` and no usable content, so it
      // has to be checked rather than caught.
      const final = await stream.finalMessage();
      const info = usageFrom(final.usage);
      logUsage(req.label, "anthropic", info);
      if (info) req.onUsage?.(info);
      if (final.stop_reason === "refusal") {
        throw new RefusalError(final.stop_details?.category ?? "refusal");
      }
      // testing-review.md S14: `stop_reason: "max_tokens"` means the response was cut off by
      // the budget, not declined — a distinct error from RefusalError, because only this one
      // is worth retrying with more tokens. Checked before `sawContent` for the same reason
      // as openai.ts: a cutoff with no visible text yet must read as "we cut it off", not "the
      // model declined".
      if (final.stop_reason === "max_tokens") {
        throw new TruncationError(req.maxTokens);
      }
      if (!sawContent) throw new RefusalError("empty response", "empty");
    },

    async completeText(model, req) {
      const message = await client.messages.create(
        {
          model,
          max_tokens: req.maxTokens,
          system: systemFor(req),
          messages: [{ role: "user", content: req.user }],
        },
        { signal: req.signal, headers: conversationHeaders(req.conversationId) },
      );

      const info = usageFrom(message.usage);
      logUsage(req.label, "anthropic", info);
      if (info) req.onUsage?.(info);
      if (message.stop_reason === "refusal") {
        throw new RefusalError(message.stop_details?.category ?? "refusal");
      }
      // See the matching streamText check above (testing-review.md S14).
      if (message.stop_reason === "max_tokens") {
        throw new TruncationError(req.maxTokens);
      }
      const text = message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (!text) throw new RefusalError("empty response", "empty");
      return text;
    },

    async validate(model, signal) {
      // Same as openai.ts's validate(): no generation in scope, so this always uses the
      // process-stable fallback id.
      await client.messages.create(
        { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
        { signal, headers: conversationHeaders(undefined) },
      );
    },
  };
}

export function isAnthropicAbort(error: unknown): boolean {
  return error instanceof Anthropic.APIUserAbortError;
}
