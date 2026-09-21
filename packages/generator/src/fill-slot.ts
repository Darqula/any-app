import type { AppPlan, SlotSpec } from "@any-app/protocol";
import { appContext } from "./fill-prompt";
import { SLOT_FILL_PROMPT } from "./fill-slot-prompt";
import { createFenceStripper, stripTrailingFence } from "./fence-stripper";
import type { Provider } from "./providers/types";
import type { UsageInfo } from "./providers/usage";

export function slotRoster(plan: AppPlan, self: string): string {
  return plan.slots
    .map((s) => `- ${s.id}${s.id === self ? " (yours)" : ""}: ${s.spec}`)
    .join("\n");
}

/**
 * Streams and buffers: a long region can outrun a non-streaming timeout, and a <template> must be
 * contiguous in the response.
 */
export async function fillSlot(
  provider: Provider,
  model: string,
  maxTokens: number,
  prompt: string,
  plan: AppPlan,
  slot: SlotSpec,
  signal?: AbortSignal,
  // The generation id; appended last so existing call sites keep compiling.
  conversationId?: string,
  onUsage?: (usage: UsageInfo) => void,
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
    onUsage,
  })) {
    raw += chunk;
  }

  const strip = createFenceStripper();
  return stripTrailingFence(strip(raw)).trim();
}
