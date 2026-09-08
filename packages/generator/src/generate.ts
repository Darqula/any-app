import { SYSTEM_PROMPT } from "./system-prompt";
import { createFenceStripper } from "./fence-stripper";
import { resolve } from "./resolve";
import type { ProviderCredential } from "./providers/types";

export { RefusalError, TruncationError } from "./providers/types";

/**
 * Streams the HTML body of a generated app, chunk by chunk.
 * Does not include the doctype — the caller writes that first.
 *
 * This is Phase 1's single-call path, kept as the fallback for when planning fails. It
 * reuses the "fill" role's provider/model/budget rather than having its own — the task
 * shape (write a whole document's worth of HTML in one call) is the same order of size as
 * fill's, and it would otherwise need its own `LLM_LINEAR_*` env vars for a path that only
 * runs when something else has already gone wrong.
 *
 * `signal`, when given, aborts the underlying request — used so a viewer disconnecting
 * stops the call instead of paying for a generation nobody is watching.
 */
export async function* streamApp(
  prompt: string,
  credential: ProviderCredential | null,
  signal?: AbortSignal,
  // See planApp's matching parameter — the generation id, shared across the whole app's
  // conversation.
  conversationId?: string,
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
  })) {
    const text = stripFence(delta);
    if (text) yield text;
  }
}
