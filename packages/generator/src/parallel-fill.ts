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
import { RefusalError } from "./providers/types";

export interface SlotResult {
  slot: SlotSpec;
  html: string;
  failed: boolean;
}

/**
 * Populates the prompt cache for this app's shared prefix before the fan-out begins.
 *
 * Without this, N concurrent calls all start before any of them has finished, so none of
 * them can read a cache the first one has not written yet — every slot pays full input
 * price and the cache-hit rate sits at zero with nothing obviously wrong. Confirmed live
 * (see open-problems.md) that this gateway's caching is real once the shared prefix is
 * large enough, so this is protecting a genuine saving, not a hypothetical one.
 *
 * The response is discarded; only the cache write matters. A failed pre-warm is not a
 * failed generation — worst case the slots run uncached, which is exactly today's cost.
 *
 * The short sleep after is not decorative. Confirmed live: a batch of slot calls fired the
 * instant the pre-warm's HTTP response lands sees a 0% cache-hit rate on this gateway — the
 * write has not propagated yet, even though a *sequential* follow-up call (naturally
 * delayed by its own round trip) sees it every time. A pause narrows the race rather than
 * closes it — even with a 1s delay, live testing saw only one of four concurrent calls
 * hit — but a nonzero hit rate beats a guaranteed zero one, and this gateway does not offer
 * a stronger read-your-writes guarantee to wait on instead.
 *
 * The sleep runs even when the call above threw — deliberately, not an oversight. On this
 * project's reasoning-heavy model, that throw is normally `RefusalError("empty response")`
 * (a `maxTokens: 1` budget leaves no room for visible text once reasoning has run) — every
 * real pre-warm attempt during Phase 4 testing hit exactly this. Confirmed directly against
 * the gateway that this still writes to cache: a `max_tokens: 1` call that returned empty
 * content was immediately followed by a real cache hit on the next call. Skipping the sleep
 * on this — the normal case here, not an edge case — would undo pre-warm's whole point for
 * the model this project actually runs. It only skips on abort, where there is nothing left
 * to wait for.
 *
 * That normal-case `RefusalError` is logged separately from a genuine failure, not folded
 * into one "pre-warm failed" line — an empty response is the *expected* outcome here and
 * still warms the cache, so a line that says "failed" on the success path is exactly the
 * wrong thing to read while debugging a real cache miss.
 */
async function prewarm(
  provider: Provider,
  model: string,
  plan: AppPlan,
  secrets: string[],
  signal?: AbortSignal,
): Promise<void> {
  try {
    await provider.completeText(model, {
      system: SLOT_FILL_PROMPT,
      context: appContext(plan),
      user: "ok",
      maxTokens: 1,
      signal,
      label: "prewarm",
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (error instanceof RefusalError) {
      console.log(`cache pre-warm: ${safeMessage(error, secrets)} (expected on a reasoning model — the cache write still happens)`);
    } else {
      console.warn("cache pre-warm failed, continuing uncached:", safeMessage(error, secrets));
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
}

/**
 * One slot, with one retry. A 429 gets a single fixed backoff and a second try (bursting N
 * slot calls at once is exactly the shape that trips a rate limit); anything else gets one
 * immediate retry. Two failures in a row degrade to a placeholder rather than reject — see
 * `slotErrorPlaceholder` and `asCompleted`'s "tasks must never reject (except on abort)"
 * contract.
 */
async function fillSlotWithRetry(
  provider: Provider,
  model: string,
  maxTokens: number,
  prompt: string,
  plan: AppPlan,
  slot: SlotSpec,
  secrets: string[],
  signal?: AbortSignal,
): Promise<SlotResult> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const html = await fillSlot(provider, model, maxTokens, prompt, plan, slot, signal);
      if (html) return { slot, html, failed: false };
    } catch (error) {
      if (isAbortError(error)) throw error; // an abort is not a retryable failure
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

/**
 * Runs the fan-out: pre-warms the shared cache prefix, then fills every slot concurrently
 * (bounded by `concurrency`), yielding each result the moment it's ready — completion
 * order, not plan order. A failed slot yields a placeholder result rather than throwing;
 * the generator itself only throws on abort, which is deliberate (see `fillSlotWithRetry`)
 * and propagates to the caller so the whole request can be reset for retry.
 */
export async function* fillAllSlots(
  prompt: string,
  plan: AppPlan,
  credential: ProviderCredential | null,
  concurrency: number,
  signal?: AbortSignal,
): AsyncGenerator<SlotResult> {
  const { provider, model, secrets } = resolve("fill", credential);
  // Deliberately not `resolve()`'s own maxTokens: LLM_FILL_MAX_TOKENS is the sequential
  // (whole-document) budget. Reusing it here for a per-region budget is the single-variable
  // problem review-phase-4.md's F3 flagged — it made a controlled sequential-vs-parallel
  // comparison impossible, because the one variable that has to be held constant is the one
  // that silently changes meaning between the two arms. A separate variable, defaulting to
  // the plan's own non-reasoning-model suggestion, keeps both modes independently correct.
  const maxTokens = Number(process.env.LLM_FILL_SLOT_MAX_TOKENS ?? 8000);

  // The pre-warm is a whole extra round trip. Below three slots there usually isn't enough
  // parallel work left for it to pay for itself — the plan called this out as the gate to
  // add if measurement showed it was needed, and Phase 4's own measurement (the fan-out
  // being slower than sequential on this model) is exactly that signal.
  if (plan.slots.length >= 3) {
    await prewarm(provider, model, plan, secrets, signal);
  }

  const limit = limitConcurrency(concurrency);
  const tasks = plan.slots.map((slot) =>
    limit(() => fillSlotWithRetry(provider, model, maxTokens, prompt, plan, slot, secrets, signal)),
  );

  yield* asCompleted(tasks);
}
