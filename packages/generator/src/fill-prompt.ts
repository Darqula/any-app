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
- Emit every requested region, in order, even if one is nearly empty.`;

export function fillUserPrompt(prompt: string, plan: AppPlan): string {
  const slots = plan.slots
    .map((s) => `===SLOT ${s.id}=== (about ${s.height}px tall)\n${s.spec}`)
    .join("\n\n");

  return `The app the user asked for:
${prompt}

The stylesheet you must write against:
<style>
${plan.css}
</style>

The shell your regions sit inside:
${plan.shell}

The shared script that has already run:
<script>
${plan.script}
</script>

Now write these regions, in this order:

${slots}`;
}
