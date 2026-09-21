import OpenAI from "openai";
import type { Provider, ProviderCredential, ProviderRequest } from "./types";
import { RefusalError, TruncationError } from "./types";
import { logUsage } from "./usage";
import type { UsageInfo } from "./usage";
import { conversationHeaders } from "./session";

function messagesFor(req: ProviderRequest) {
  // Caching is automatic on a stable prefix: stable half in system, volatile half in user.
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
    // cached_tokens is the only sign that automatic caching works. cache_write_tokens is a gateway
    // extension outside the SDK type, so it is read structurally.
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
      // Remember the truncation and throw after the loop: throwing here would lose the trailing usage
      // chunk and would beat the abort check.
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
      // An aborted signal ends the stream silently; raise the abort so isAbortError guards fire.
      // Must precede the sawContent/truncated checks.
      if (req.signal?.aborted) throw new OpenAI.APIUserAbortError();
      // Order matters: abort, usage, truncation, empty content. onUsage sits beside logUsage so
      // failed and truncated calls are still counted.
      const info = usageFrom(usage);
      logUsage(req.label, "openai", info);
      if (info) req.onUsage?.(info);
      // Before sawContent: an early cut-off is "truncated", not "declined".
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
      const info = usageFrom(completion.usage);
      logUsage(req.label, "openai", info);
      if (info) req.onUsage?.(info);
      const choice = completion.choices[0];
      if (choice?.finish_reason === "content_filter") {
        throw new RefusalError("content_filter");
      }
      // Budget cut-off: worth retrying with more tokens, unlike a refusal.
      if (choice?.finish_reason === "length") {
        throw new TruncationError(req.maxTokens);
      }
      const text = choice?.message?.content;
      if (!text) throw new RefusalError("empty response", "empty");
      return text;
    },

    async validate(model, signal) {
      // No generation in scope: uses the process-stable fallback conversation id.
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
