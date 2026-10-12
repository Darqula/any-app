import { SYSTEM_PROMPT } from "./system-prompt.ts";
import { createFenceStripper } from "./fence-stripper.ts";
import { resolve } from "./resolve.ts";
import type { ProviderCredential } from "./providers/types.ts";
import type { UsageInfo } from "./providers/usage.ts";

export { RefusalError, TruncationError } from "./providers/types.ts";

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
