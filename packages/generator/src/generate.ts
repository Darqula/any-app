import { SYSTEM_PROMPT } from "./system-prompt";
import { createFenceStripper } from "./fence-stripper";
import { resolve } from "./resolve";
import type { ProviderCredential } from "./providers/types";
import type { UsageInfo } from "./providers/usage";

export { RefusalError, TruncationError } from "./providers/types";

/**
 * Single-call path, the fallback when planning fails. Streams the HTML body without
 * the doctype. Reuses the fill role's provider, model and budget. `signal` stops the spend when the
 * viewer disconnects.
 */
export async function* streamApp(
  prompt: string,
  credential: ProviderCredential | null,
  signal?: AbortSignal,
  conversationId?: string,
  onUsage?: (usage: UsageInfo) => void,
): AsyncGenerator<string> {
  const stripFence = createFenceStripper();
  const { provider, model, maxTokens } = resolve("fill", credential);

  for await (const delta of provider.streamText(model, {
    system: SYSTEM_PROMPT,
    user: prompt,
    maxTokens,
    signal,
    label: "linear",
    conversationId,
    onUsage,
  })) {
    const text = stripFence(delta);
    if (text) yield text;
  }
}
