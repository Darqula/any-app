import type { AppPlan } from "@any-app/protocol";

export const FILL_SYSTEM_PROMPT = `You write the content of individual regions of a web app whose layout and stylesheet already exist.

Output format — reply with one section per region, in the order given, each header alone on its own line:

===SLOT some-id===
<the HTML for that region>

Absolute rules:
- Write HTML only. Never write markdown code fences and never write commentary.
- NEVER write a <style> element or a style attribute. The stylesheet already exists and is shown to you. Use its classes. If something needs a style that is not there, choose the closest class that is.
- Write only what goes INSIDE the region. Do not repeat the wrapping <div>.
- A region may include its own <script> for behaviour local to that region. It will execute when the region lands. Shared state belongs to the shell script, which has already run.
- Use realistic, specific placeholder content. Never lorem ipsum.
- Emit every requested region, in order, even if one is nearly empty.
- If this app has collections, read and write them through \`anyapp.data\`, which already exists on the page. Never write your own fetch() to /data, and never invent a collection that was not listed.
- Every anyapp.data call is async and can fail. Render something reasonable while it is pending and something honest if it rejects. Never leave a permanent spinner.
- anyapp.data.list returns the newest rows first, at most 100, and filters only by exact equality on top-level keys. Do the rest in JavaScript.
- anyapp.data.update merges shallowly, one level deep. Patching {tags: [...]} replaces the whole tags array/object, it does not merge inside it. To change one nested field, read the record, edit the field in JavaScript, then send the whole top-level property back.`;

/**
 * The part of an app that never changes for the lifetime of that app: the stylesheet, the
 * shell, and the shared script. Belongs in `ProviderRequest.context`, not `user`, so a cache
 * breakpoint (Anthropic) or a stable prefix (OpenAI-compatible) can actually land on it.
 *
 * This is also what Phase 4's per-slot calls and cache pre-warm use directly (see
 * `fill-slot.ts`) — it is deliberately the *narrowest* stable unit, with no per-call
 * additions (like a slot list), so that the pre-warm and every parallel slot call share the
 * exact same byte-identical prefix and therefore the exact same cache entry. That guarantee
 * stops there, though: `regenerateSlot`/`regenerateCss` (edit.ts) build their own context
 * strings and never call this function, so an edit is not part of that shared-prefix set —
 * and `fillContext` below adds the slot list *after* this text, which only extends a shared
 * OpenAI-compatible prefix; on the Anthropic path there is no cache breakpoint at this
 * function's own boundary, so a sequential fill's single combined block does not read
 * whatever a pre-warm alone wrote.
 */
export function appContext(plan: AppPlan): string {
  const data =
    plan.collections.length > 0
      ? `\n\nThis app's data-API collections — read and write them through \`anyapp.data\`, which already exists on the page. Never invent a collection not listed here:\n${plan.collections.map((c) => `- ${c.name}: ${c.description}`).join("\n")}`
      : "";

  return `The stylesheet you must write against:
<style>
${plan.css}
</style>

The shell your regions sit inside:
${plan.shell}

The shared script that has already run:
<script>
${plan.script}
</script>${data}`;
}

/**
 * The sequential (Phase 3.5) fill call's stable half: `appContext` plus the full slot list,
 * since one call writes every region and needs to see all of them up front. Kept distinct
 * from `appContext` itself — the parallel path's per-slot calls (Phase 4) share only the
 * narrower `appContext`, since a slot list naming every region would differ in emphasis
 * (whose region is "yours") across calls and break the shared prefix instead of protecting it.
 */
export function fillContext(plan: AppPlan): string {
  const slots = plan.slots
    .map((s) => `===SLOT ${s.id}=== (about ${s.height}px tall)\n${s.spec}`)
    .join("\n\n");

  return `${appContext(plan)}

The regions to write, in this order:

${slots}`;
}

export function fillUserPrompt(prompt: string): string {
  return `The app the user asked for:
${prompt}

Write each region listed above, in order, per the rules above.`;
}
