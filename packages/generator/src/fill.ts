import type { AppPlan } from "@any-app/protocol";
import { resolve } from "./resolve.ts";
import type { ProviderCredential } from "./providers/types.ts";
import type { UsageInfo } from "./providers/usage.ts";
import { FILL_SYSTEM_PROMPT, fillContext, fillUserPrompt } from "./fill-prompt.ts";

/** Streams the fill call's raw sectioned output. The caller transforms it. */
export async function* streamFill(
  prompt: string,
  plan: AppPlan,
  credential: ProviderCredential | null,
  signal?: AbortSignal,
  conversationId?: string,
  onUsage?: (usage: UsageInfo) => void,
): AsyncGenerator<string> {
  const { provider, model, maxTokens } = resolve("fill", credential);

  yield* provider.streamText(model, {
    system: FILL_SYSTEM_PROMPT,
    context: fillContext(plan),
    user: fillUserPrompt(prompt),
    maxTokens,
    signal,
    label: "fill",
    conversationId,
    onUsage,
  });
}
