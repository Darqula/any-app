import type OpenAI from "openai";
import type { AppPlan } from "@any-app/protocol";
import { getClient, getModel, isReasoningModel, logUsage } from "./client";
import { FILL_SYSTEM_PROMPT, fillUserPrompt } from "./fill-prompt";
import { RefusalError } from "./generate";

/** Streams the fill call's raw sectioned output. The caller transforms it. */
export async function* streamFill(
  prompt: string,
  plan: AppPlan,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const stream = await getClient().chat.completions.create(
    {
      model: getModel(),
      // See the matching comment in planner.ts: a reasoning model spends part of this
      // budget on hidden reasoning before writing any slot content. glm-5.3-flash never
      // converged here at any budget up to this provider's 131072 max (see
      // .docs/open-problems.md). longcat-2.0 converges comfortably — measured usage was
      // ~8500 tokens total (84% of it reasoning) — so 96000 is generous headroom, not a
      // tuned-to-the-limit value.
      max_tokens: isReasoningModel() ? 96000 : 16000,
      stream: true,
      // Without this, a streaming response never reports usage at all — the final chunk
      // (choices: [], usage: {...}) simply wouldn't be sent.
      stream_options: { include_usage: true },
      messages: [
        { role: "system", content: FILL_SYSTEM_PROMPT },
        { role: "user", content: fillUserPrompt(prompt, plan) },
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
    if (choice.finish_reason === "content_filter") {
      throw new RefusalError(choice.finish_reason);
    }
    const delta = choice.delta?.content;
    if (delta) {
      sawContent = true;
      yield delta;
    }
  }

  logUsage("fill", usage);
  if (!sawContent) throw new RefusalError("empty response");
}
