import Anthropic from "@anthropic-ai/sdk";
import type { Provider, ProviderCredential, ProviderRequest } from "./types";
import { RefusalError, TruncationError } from "./types";
import { logUsage } from "./usage";
import type { UsageInfo } from "./usage";
// Sent to every gateway, real Anthropic included (an unknown header is ignored).
import { conversationHeaders } from "./session";

/** system + context share one cached text block; the volatile instruction goes in messages. */
function systemFor(req: ProviderRequest) {
  const text = req.context ? `${req.system}\n\n${req.context}` : req.system;
  return [{ type: "text" as const, text, cache_control: { type: "ephemeral" as const } }];
}

/** Structural, loose type: only the fields confirmed against a live response. */
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
    // Undefined uses the SDK default (api.anthropic.com); may point at an Anthropic-shaped gateway.
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
        // Text deltas only: thinking_delta would write reasoning into the app.
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          sawContent = true;
          yield event.delta.text;
        }
      }

      // An aborted signal ends the stream silently; raise the abort so isAbortError guards fire.
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
      // Budget cut-off, not a refusal; checked before sawContent so it reads as truncation.
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
