import type { AppPlan } from "@any-app/protocol";
import { resolve } from "./resolve";
import type { ProviderCredential } from "./providers/types";
import type { UsageInfo } from "./providers/usage";
import { createFenceStripper, stripTrailingFence } from "./fence-stripper";
import { slotIdsInShell, unmatchedSlotAttributes, sanitizePlaceholders } from "@any-app/protocol";

const SLOT_EDIT_PROMPT = `You rewrite one region of an existing web app.

Output the new HTML for that region and nothing else. No markdown code fences, no commentary, no explanation.

Absolute rules — these are the same rules the region was written under:
- NEVER write a <style> element or a style attribute. The stylesheet already exists and is shown to you. Use its classes.
- Write only what goes INSIDE the region. Do not repeat the wrapping <div>.
- The region may include its own <script> for local behaviour. Shared state belongs to the shell script, which has already run.
- Change what the request asks for and keep everything else as it was. This is an edit, not a rewrite.`;

/**
 * The last two rules are the other half of edit-router.ts's 2026-09-21 fix (see the note above
 * its prompt). Even routed correctly, a stylesheet call can still be handed a request it cannot
 * satisfy — the dropdown's explicit "Styling" choice bypasses the router entirely. Told to
 * "apply the requested change", the model invented rules for a control that did not exist
 * (body.dark-theme, :root[data-theme="light"], "applied by the theme switch") and spent ~11k
 * completion tokens doing it. Returning the stylesheet unchanged is the escape hatch:
 * edits.ts recognises an identical result and tells the user the truth instead of reporting an
 * update that changed nothing visible.
 */
const CSS_EDIT_PROMPT = `You rewrite the stylesheet of an existing web app.

Output the complete new stylesheet and nothing else. No markdown code fences, no <style> tag, no commentary.

Absolute rules:
- Return the WHOLE stylesheet, not a fragment and not a diff. What you return replaces the current one entirely.
- Keep every selector that the existing markup depends on. Removing a class that the markup still uses will leave part of the app unstyled.
- Apply the requested change and leave everything else exactly as it was.
- Keep the layout responsive and legible on a phone.
- Only style what already exists. You are shown the shell markup and the region names, not what is inside each region, so reuse the class names the current stylesheet already defines. Never write rules for a control, element or state that the request asks to be ADDED — a stylesheet cannot create one, and rules for something that does not exist do nothing.
- If the request is mainly about adding or changing a control, feature or behaviour (a switch, a button, a new section, something that should happen when the user does something), a stylesheet is the wrong tool. In that case change nothing: return the current stylesheet exactly as it is, character for character.`;

/**
 * Rewrites the frame — the fixed markup around the regions. Added 2026-09-21: it was the one
 * part of an app no edit could reach (see edit-router.ts), so a request like "remove the
 * caption under the heading" silently did nothing. The placeholder rule is the same contract
 * planner-prompt.ts states for the original frame, and `checkShellEdit` enforces it after the
 * fact, because a frame that loses or duplicates a placeholder loses or duplicates a region.
 */
const SHELL_EDIT_PROMPT = `You rewrite the frame of an existing web app: the fixed page markup around its regions — headings, captions, footer lines, wrappers.

Output the complete new frame HTML and nothing else. No markdown code fences, no commentary, no <html> or <body> wrapper.

Absolute rules:
- Return the WHOLE frame, not a fragment and not a diff. What you return replaces the current frame entirely.
- Every region placeholder — an element with a data-slot="..." attribute — MUST stay, exactly once each, with the same data-slot value and completely empty. Do not rename, duplicate, remove or fill them. The regions' content lives elsewhere.
- NEVER write a <style> element or a style attribute, and never a <script>. The stylesheet already exists and is shown to you. Use its classes.
- Apply the requested change and leave everything else exactly as it was, including the class names and ids that the stylesheet and scripts rely on.
- Removing something means deleting its element entirely, not blanking its text.`;

async function complete(
  label: string,
  system: string,
  context: string,
  user: string,
  credential: ProviderCredential | null,
  signal: AbortSignal | undefined,
  conversationId: string | undefined,
  onUsage: ((usage: UsageInfo) => void) | undefined,
): Promise<string> {
  const { provider, model, maxTokens } = resolve("edit", credential);

  const raw = await provider.completeText(model, {
    system,
    context,
    user,
    maxTokens,
    signal,
    label,
    conversationId,
    onUsage,
  });

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
  credential: ProviderCredential | null,
  signal?: AbortSignal,
  // The generation id — see planApp's matching parameter.
  conversationId?: string,
  // Phase 6 step 8 — see planApp's matching parameter.
  onUsage?: (usage: UsageInfo) => void,
): Promise<string> {
  const spec = plan.slots.find((s) => s.id === slotId)?.spec ?? "";

  // The stylesheet and this slot's spec are stable across repeated edits to the same slot
  // in one session — that's the half worth a cache breakpoint. The current contents and
  // the instruction change on every call, so they stay in `user`.
  const html = await complete(
    "edit-slot",
    SLOT_EDIT_PROMPT,
    `The stylesheet you must write against:
<style>
${plan.css}
</style>

What this region is for: ${spec}`,
    `Its current contents:
${currentContent}

The change requested: ${instruction}`,
    credential,
    signal,
    conversationId,
    onUsage,
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

/**
 * Validates and normalises a rewritten frame against the app's regions. Content inside a
 * placeholder is stripped deterministically first (the same net `parsePlan` uses for the
 * original frame), then the region ids must match the plan's exactly — each once. Returns the
 * usable frame, or a reason it cannot be used; nothing is saved on a problem.
 */
export function checkShellEdit(
  plan: AppPlan,
  raw: string,
): { ok: true; shell: string } | { ok: false; problem: string } {
  const withoutStyles = raw.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "").trim();
  const { shell } = sanitizePlaceholders(withoutStyles);
  const found = slotIdsInShell(shell);
  const expected = plan.slots.map((s) => s.id);
  const missing = expected.filter((id) => !found.includes(id));
  const duplicated = found.filter((id, i) => found.indexOf(id) !== i);
  const unknown = found.filter((id) => !expected.includes(id));
  const malformed = unmatchedSlotAttributes(shell);
  if (missing.length || duplicated.length || unknown.length || malformed.length) {
    const parts = [
      missing.length ? `lost ${missing.join(", ")}` : "",
      duplicated.length ? `duplicated ${[...new Set(duplicated)].join(", ")}` : "",
      unknown.length ? `invented ${unknown.join(", ")}` : "",
      malformed.length ? `broke ${malformed.join(", ")}` : "",
    ].filter(Boolean);
    return {
      ok: false,
      problem: `That rewrite damaged the page's regions (${parts.join("; ")}), so it was discarded. Try rephrasing, or try again.`,
    };
  }
  return { ok: true, shell };
}

export async function regenerateShell(
  instruction: string,
  plan: AppPlan,
  credential: ProviderCredential | null,
  signal?: AbortSignal,
  // The generation id — see planApp's matching parameter.
  conversationId?: string,
  // Phase 6 step 8 — see planApp's matching parameter.
  onUsage?: (usage: UsageInfo) => void,
): Promise<string> {
  // The stylesheet and region list are the stable, cacheable half; the current frame changes
  // with every successful shell edit, so it stays in `user` next to the instruction.
  return complete(
    "edit-shell",
    SHELL_EDIT_PROMPT,
    `The stylesheet the frame is styled by:
<style>
${plan.css}
</style>

The regions that sit inside it: ${plan.slots.map((s) => s.id).join(", ")}`,
    `The current frame:
${plan.shell}

The change requested: ${instruction}`,
    credential,
    signal,
    conversationId,
    onUsage,
  );
}

export async function regenerateCss(
  instruction: string,
  plan: AppPlan,
  credential: ProviderCredential | null,
  signal?: AbortSignal,
  // The generation id — see planApp's matching parameter.
  conversationId?: string,
  // Phase 6 step 8 — see planApp's matching parameter.
  onUsage?: (usage: UsageInfo) => void,
): Promise<string> {
  // The shell and region list are stable across repeated CSS edits in one session; the
  // stylesheet itself is what's being rewritten (and differs after every successful call),
  // so it stays in `user` alongside the instruction rather than in the cached half.
  const css = await complete(
    "edit-css",
    CSS_EDIT_PROMPT,
    `The shell markup this stylesheet has to style:
${plan.shell}

The regions inside it: ${plan.slots.map((s) => s.id).join(", ")}`,
    `The current stylesheet:
${plan.css}

The change requested: ${instruction}`,
    credential,
    signal,
    conversationId,
    onUsage,
  );
  return unwrapStyleTag(css);
}
