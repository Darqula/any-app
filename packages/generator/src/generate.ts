import type OpenAI from "openai";
import { SYSTEM_PROMPT } from "./system-prompt";
import { createFenceStripper } from "./fence-stripper";
import { getClient, getModel, isReasoningModel, logUsage } from "./client";

export class RefusalError extends Error {
  constructor(public readonly reason: string | null) {
    super(`The model declined this request (${reason ?? "unknown reason"}).`);
    this.name = "RefusalError";
  }
}

/**
 * Streams the HTML body of a generated app, chunk by chunk.
 * Does not include the doctype — the caller writes that first.
 *
 * `signal`, when given, aborts the underlying request — used so a viewer disconnecting
 * stops the call instead of paying for a generation nobody is watching.
 */
export async function* streamApp(
  prompt: string,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const stripFence = createFenceStripper();

  const stream = await getClient().chat.completions.create(
    {
      model: getModel(),
      // `max_tokens` is the broadly-compatible field name (vLLM, llama.cpp, OpenRouter,
      // most gateways). OpenAI's own newer reasoning models reject it and require
      // `max_completion_tokens` instead — pointing OPENAI_BASE_URL at one of those
      // returns a 400. See .env.example.
      //
      // A *compatible* reasoning model (one that does accept max_tokens) still spends part
      // of this budget on hidden reasoning before writing any HTML — see isReasoningModel().
      // Matches fill.ts's budget; see the comment there for the measured usage this is
      // based on (this is the linear/fallback path, not the primary one, so it hasn't been
      // separately measured, but the task shape is the same order of size as fill's).
      max_tokens: isReasoningModel() ? 96000 : 16000,
      stream: true,
      // Without this, a streaming response never reports usage at all — the final chunk
      // (choices: [], usage: {...}) simply wouldn't be sent.
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    },
    { signal },
  );

  let sawContent = false;
  let usage: OpenAI.CompletionUsage | null | undefined;

  for await (const event of stream) {
    // The usage-bearing chunk has an empty `choices` array, so this has to be checked
    // before the `if (!choice) continue` below skips past it entirely.
    if (event.usage) usage = event.usage;

    const choice = event.choices?.[0];
    if (!choice) continue;

    // Compatible providers signal a refusal/moderation block through
    // finish_reason rather than an HTTP error, so it has to be checked here
    // rather than caught as an exception.
    if (choice.finish_reason === "content_filter") {
      throw new RefusalError(choice.finish_reason);
    }

    const delta = choice.delta?.content;
    if (delta) {
      sawContent = true;
      const text = stripFence(delta);
      if (text) yield text;
    }
  }

  logUsage("linear", usage);
  if (!sawContent) {
    throw new RefusalError("empty response");
  }
}
