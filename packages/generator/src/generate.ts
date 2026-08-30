import { SYSTEM_PROMPT } from "./system-prompt";
import { createFenceStripper } from "./fence-stripper";
import { getClient, getModel, isReasoningModel } from "./client";

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
      // Raised alongside fill.ts's budget after 32000 proved insufficient there.
      max_tokens: isReasoningModel() ? 96000 : 16000,
      stream: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: prompt },
      ],
    },
    { signal },
  );

  let sawContent = false;

  for await (const event of stream) {
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

  if (!sawContent) {
    throw new RefusalError("empty response");
  }
}
