import type { AppPlan } from "@any-app/protocol";

/**
 * Pairs with planner-prompt's SHELL rule: the placeholder already carries the region's class,
 * so this call must not wrap it again. Change both together.
 */
export const FILL_SYSTEM_PROMPT = `You write the content of individual regions of a web app whose layout and stylesheet already exist.

Output format — reply with one section per region, in the order given, each header alone on its own line:

===SLOT some-id===
<the HTML for that region>

Absolute rules:
- Write HTML only. Never write markdown code fences and never write commentary.
- NEVER write a <style> element or a style attribute. The stylesheet already exists and is shown to you. Use its classes. If something needs a style that is not there, choose the closest class that is.
- The region element already exists and already carries the region's class(es) — write only its children. Never enclose your output in a single wrapper element (its own class would double up with the one already on the region).
- A region may include its own <script> for behaviour local to that region. It will execute when the region lands. Shared state belongs to the shell script, which has already run.
- Use realistic, specific placeholder content. Never lorem ipsum.
- Emit every requested region, in order, even if one is nearly empty.
- If this app has collections, read and write them through \`anyapp.data\`, which already exists on the page. Never write your own fetch() to /data, and never invent a collection that was not listed.
- Every anyapp.data call is async and can fail. Render something reasonable while it is pending and something honest if it rejects. Never leave a permanent spinner.
- anyapp.data.list returns the newest rows first, at most 100, and filters only by exact equality on top-level keys. Do the rest in JavaScript.
- anyapp.data.update merges shallowly, one level deep. Patching {tags: [...]} replaces the whole tags array/object, it does not merge inside it. To change one nested field, read the record, edit the field in JavaScript, then send the whole top-level property back.`;

/**
 * The part of an app that never changes, for ProviderRequest.context. Kept narrow (no slot list) so
 * the pre-warm and every parallel slot call share one byte-identical cache prefix.
 * Edits build their own context and do not share it.
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

/** Sequential fill's stable half: appContext plus every region. Not shared with parallel calls. */
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
