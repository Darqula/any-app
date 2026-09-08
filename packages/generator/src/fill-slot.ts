import type { AppPlan, SlotSpec } from "@any-app/protocol";
import { appContext } from "./fill-prompt";
import { SLOT_FILL_PROMPT } from "./fill-slot-prompt";
import { createFenceStripper, stripTrailingFence } from "./fence-stripper";
import type { Provider } from "./providers/types";

export function slotRoster(plan: AppPlan, self: string): string {
  return plan.slots
    .map((s) => `- ${s.id}${s.id === self ? " (yours)" : ""}: ${s.spec}`)
    .join("\n");
}

/**
 * Streams internally and buffers, rather than returning a plain completion. Two reasons:
 * a long region can outrun a non-streaming request timeout, and buffering is required
 * anyway — a <template> has to be contiguous in the response, so a slot cannot be emitted
 * until it is whole.
 */
export async function fillSlot(
  provider: Provider,
  model: string,
  maxTokens: number,
  prompt: string,
  plan: AppPlan,
  slot: SlotSpec,
  signal?: AbortSignal,
  // The generation id — see planner.ts's planApp for the full doc comment. Appended last
  // (after `signal`), and optional, so existing positional call sites that stop at `signal`
  // (or earlier) keep compiling unchanged.
  conversationId?: string,
): Promise<string> {
  let raw = "";
  for await (const chunk of provider.streamText(model, {
    system: SLOT_FILL_PROMPT,
    context: appContext(plan),
    user: `The app the user asked for:
${prompt}

All regions of this app:
${slotRoster(plan, slot.id)}

Write the "${slot.id}" region. It is about ${slot.height}px tall.
What belongs in it: ${slot.spec}`,
    maxTokens,
    signal,
    label: `fill:${slot.id}`,
    conversationId,
  })) {
    raw += chunk;
  }

  const strip = createFenceStripper();
  return stripTrailingFence(strip(raw)).trim();
}
