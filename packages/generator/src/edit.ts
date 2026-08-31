import type { AppPlan } from "@any-app/protocol";
import { getClient, getModel, isReasoningModel, logUsage } from "./client";
import { createFenceStripper, stripTrailingFence } from "./fence-stripper";

const SLOT_EDIT_PROMPT = `You rewrite one region of an existing web app.

Output the new HTML for that region and nothing else. No markdown code fences, no commentary, no explanation.

Absolute rules — these are the same rules the region was written under:
- NEVER write a <style> element or a style attribute. The stylesheet already exists and is shown to you. Use its classes.
- Write only what goes INSIDE the region. Do not repeat the wrapping <div>.
- The region may include its own <script> for local behaviour. Shared state belongs to the shell script, which has already run.
- Change what the request asks for and keep everything else as it was. This is an edit, not a rewrite.`;

const CSS_EDIT_PROMPT = `You rewrite the stylesheet of an existing web app.

Output the complete new stylesheet and nothing else. No markdown code fences, no <style> tag, no commentary.

Absolute rules:
- Return the WHOLE stylesheet, not a fragment and not a diff. What you return replaces the current one entirely.
- Keep every selector that the existing markup depends on. Removing a class that the markup still uses will leave part of the app unstyled.
- Apply the requested change and leave everything else exactly as it was.
- Keep the layout responsive and legible on a phone.`;

async function complete(
  label: string,
  system: string,
  user: string,
  signal: AbortSignal | undefined,
  maxTokens: number,
): Promise<string> {
  const completion = await getClient().chat.completions.create(
    {
      model: getModel(),
      // See the matching comment in fill.ts and planner.ts: a reasoning model spends part
      // of this on hidden reasoning before writing the edit itself. An edit is one slot or
      // one stylesheet — smaller than a full fill pass — so this sits between the
      // planner's and fill's budgets rather than matching either.
      max_tokens: isReasoningModel() ? 48000 : maxTokens,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    },
    { signal },
  );

  logUsage(label, completion.usage);

  const raw = completion.choices[0]?.message?.content;
  if (!raw) throw new Error("edit returned no content");

  // The same fence handling as generation: models fence output despite being told not to.
  const strip = createFenceStripper();
  return stripTrailingFence(strip(raw)).trim();
}

/**
 * Removes any `<style>` block or `style="..."` attribute a slot edit wrote despite being
 * told not to. Confirmed live: asked to add a button to a slot, the model wrote a correct
 * button *and* a `<style>` block styling it — the prompt's rule is not self-enforcing.
 *
 * A `<style>` element inserted via `replaceChildren`/`innerHTML` still takes effect (unlike
 * a `<script>`, it needs no re-creation to run), so leaving it in would not even look
 * broken — it would just silently reintroduce the exact hazard the planner's CSS monopoly
 * exists to prevent: a class the CSS editor never sees and can't account for, and (once
 * Phase 4 parallelises fill) two slot calls free to invent conflicting rules for the same
 * class name. Stripping is the safe default; the slot keeps working off the existing
 * stylesheet's classes.
 */
function stripStyleTags(html: string, slotId: string): string {
  let out = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  out = out.replace(/\s+style\s*=\s*("[^"]*"|'[^']*')/gi, "");
  if (out !== html) {
    console.warn(`edit: slot "${slotId}" wrote a <style> element/attribute despite the rule against it — stripped`);
  }
  return out.trim();
}

export async function regenerateSlot(
  instruction: string,
  plan: AppPlan,
  slotId: string,
  currentContent: string,
  signal?: AbortSignal,
): Promise<string> {
  const spec = plan.slots.find((s) => s.id === slotId)?.spec ?? "";

  const html = await complete(
    "edit-slot",
    SLOT_EDIT_PROMPT,
    `The stylesheet you must write against:
<style>
${plan.css}
</style>

What this region is for: ${spec}

Its current contents:
${currentContent}

The change requested: ${instruction}`,
    signal,
    8000,
  );
  return stripStyleTags(html, slotId);
}

/** Unwraps a `<style>...</style>` tag the model wrote around the stylesheet despite being
 * told to return the bare CSS. Same "the rule isn't self-enforcing" lesson as
 * `stripStyleTags`, applied to the one tag this call is actually allowed to produce the
 * *contents* of, just not the wrapper. */
function unwrapStyleTag(css: string): string {
  const match = /^<style[^>]*>([\s\S]*)<\/style>$/i.exec(css.trim());
  if (!match) return css;
  console.warn("edit: css rewrite wrapped its output in a <style> tag despite the rule against it — unwrapped");
  return match[1]!.trim();
}

export async function regenerateCss(
  instruction: string,
  plan: AppPlan,
  signal?: AbortSignal,
): Promise<string> {
  const css = await complete(
    "edit-css",
    CSS_EDIT_PROMPT,
    `The shell markup this stylesheet has to style:
${plan.shell}

The regions inside it: ${plan.slots.map((s) => s.id).join(", ")}

The current stylesheet:
${plan.css}

The change requested: ${instruction}`,
    signal,
    8000,
  );
  return unwrapStyleTag(css);
}
