import type { AppPlan, SlotSpec } from "@any-app/protocol";
import { slotErrorPlaceholder } from "@any-app/protocol";
import { appContext } from "./fill-prompt";
import { SLOT_FILL_PROMPT } from "./fill-slot-prompt";
import { fillSlot } from "./fill-slot";
import { asCompleted, limitConcurrency } from "./fan-out";
import { resolve } from "./resolve";
import type { ProviderCredential } from "./providers/types";
import type { Provider } from "./providers/types";
import { isAbortError } from "./client";
import { safeMessage } from "./scrub";
import { RefusalError, TruncationError } from "./providers/types";
import type { UsageInfo } from "./providers/usage";

export interface SlotResult {
  slot: SlotSpec;
  html: string;
  failed: boolean;
}

/**
 * Writes the shared cache prefix before the fan-out so slots can read it; only the write matters.
 * Failure is harmless (slots run uncached). The sleep after is deliberate and also runs when the call
 * threw: the expected maxTokens:1 outcome (empty or truncated) still warms the cache.
 */
async function prewarm(
  provider: Provider,
  model: string,
  plan: AppPlan,
  secrets: string[],
  signal?: AbortSignal,
  conversationId?: string,
): Promise<void> {
  try {
    await provider.completeText(model, {
      system: SLOT_FILL_PROMPT,
      context: appContext(plan),
      user: "ok",
      maxTokens: 1,
      signal,
      label: "prewarm",
      conversationId,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof RefusalError || error instanceof TruncationError) {
      console.log(`cache pre-warm: ${safeMessage(error, secrets)} (expected on a reasoning model — the cache write still happens)`);
    } else {
      console.warn("cache pre-warm failed, continuing uncached:", safeMessage(error, secrets));
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
}

/** One slot, one retry (a fixed backoff on 429). Two failures degrade to a placeholder, never a rejection. */
async function fillSlotWithRetry(
  provider: Provider,
  model: string,
  maxTokens: number,
  prompt: string,
  plan: AppPlan,
  slot: SlotSpec,
  secrets: string[],
  signal?: AbortSignal,
  conversationId?: string,
  onUsage?: (usage: UsageInfo) => void,
): Promise<SlotResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fillSlot(provider, model, maxTokens, prompt, plan, slot, signal, conversationId, onUsage);
      if (html) return { slot, html, failed: false };
    } catch (error) {
      if (isAbortError(error)) throw error;
      const status = (error as { status?: number }).status;
      if (attempt === 0 && status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (attempt === 0) continue;
      console.warn(`slot "${slot.id}" failed twice:`, safeMessage(error, secrets));
    }
  }
  return { slot, html: slotErrorPlaceholder(slot.id), failed: true };
}

/** Fills every slot concurrently and yields each in completion order. Throws only on abort. */
export async function* fillAllSlots(
  prompt: string,
  plan: AppPlan,
  credential: ProviderCredential | null,
  concurrency: number,
  signal?: AbortSignal,
  // The generation id, shared with the pre-warm so every call hits one cache entry.
  conversationId?: string,
  onUsage?: (usage: UsageInfo) => void,
): AsyncGenerator<SlotResult> {
  const { provider, model, secrets } = resolve("fill", credential);
  // Not resolve()'s budget: LLM_FILL_MAX_TOKENS is the sequential whole-document budget.
  const maxTokens = Number(process.env.LLM_FILL_SLOT_MAX_TOKENS ?? 8000);

  // The pre-warm costs a round trip; below three slots it does not pay for itself.
  if (plan.slots.length >= 3) {
    await prewarm(provider, model, plan, secrets, signal, conversationId);
  }

  const limit = limitConcurrency(concurrency);
  const tasks = plan.slots.map((slot) =>
    limit(() =>
      fillSlotWithRetry(provider, model, maxTokens, prompt, plan, slot, secrets, signal, conversationId, onUsage),
    ),
  );

  yield* asCompleted(tasks);
}
