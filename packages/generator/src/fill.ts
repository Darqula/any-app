import type { AppPlan } from "@any-app/protocol";
import { getClient, getModel, isReasoningModel } from "./client";
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
      // budget on hidden reasoning before writing any slot content. 32000 was not enough
      // for glm-5.3-flash on a multi-slot fill prompt — it burned the whole budget on
      // reasoning and returned zero content. 96000 is untested headroom, not a measured
      // minimum; if this is still not enough, the model likely cannot converge on this
      // task shape at all rather than merely needing a bigger number.
      max_tokens: isReasoningModel() ? 96000 : 16000,
      stream: true,
      messages: [
        { role: "system", content: FILL_SYSTEM_PROMPT },
        { role: "user", content: fillUserPrompt(prompt, plan) },
      ],
    },
    { signal },
  );

  let sawContent = false;
  for await (const event of stream) {
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

  if (!sawContent) throw new RefusalError("empty response");
}
