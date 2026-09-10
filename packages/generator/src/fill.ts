import type { AppPlan } from "@any-app/protocol";
import { resolve } from "./resolve";
import type { ProviderCredential } from "./providers/types";
import type { UsageInfo } from "./providers/usage";
import { FILL_SYSTEM_PROMPT, fillContext, fillUserPrompt } from "./fill-prompt";

/** Streams the fill call's raw sectioned output. The caller transforms it. */
export async function* streamFill(
  prompt: string,
  plan: AppPlan,
  credential: ProviderCredential | null,
  signal?: AbortSignal,
  // See planApp's matching parameter — the generation id, shared across the whole app's
  // conversation.
  conversationId?: string,
  // Phase 6 step 8 — see planApp's matching parameter.
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
