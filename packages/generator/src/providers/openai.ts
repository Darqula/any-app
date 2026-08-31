import OpenAI from "openai";
import type { Provider, ProviderCredential, ProviderRequest } from "./types";
import { RefusalError } from "./types";
import { logUsage } from "./usage";
import type { UsageInfo } from "./usage";

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
        { signal: req.signal },
      );

      let sawContent = false;
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
        const delta = choice.delta?.content;
        if (delta) {
          sawContent = true;
          yield delta;
        }
      }
      logUsage(req.label, "openai", usageFrom(usage));
      if (!sawContent) throw new RefusalError("empty response");
    },

    async completeText(model, req) {
      const completion = await client.chat.completions.create(
        {
          model,
          max_tokens: req.maxTokens,
          messages: messagesFor(req),
        },
        { signal: req.signal },
      );
      logUsage(req.label, "openai", usageFrom(completion.usage));
      const choice = completion.choices[0];
      if (choice?.finish_reason === "content_filter") {
        throw new RefusalError("content_filter");
      }
      const text = choice?.message?.content;
      if (!text) throw new RefusalError("empty response");
      return text;
    },

    async validate(model, signal) {
      await client.chat.completions.create(
        { model, max_tokens: 1, messages: [{ role: "user", content: "hi" }] },
        { signal },
      );
    },
  };
}

export function isOpenAIAbort(error: unknown): boolean {
  return error instanceof OpenAI.APIUserAbortError;
}
