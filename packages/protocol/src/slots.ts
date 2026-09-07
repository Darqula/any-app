/** One region of the app, generated separately from the shell that contains it. */
export interface SlotSpec {
  /** Lowercase kebab id, unique within the app. Used in DOM ids and stream markers. */
  id: string;
  /** Skeleton height in CSS pixels, so the layout does not shift when content lands. */
  height: number;
  /** One line telling the fill call what belongs here. */
  spec: string;
}

/** One collection the app's data API exposes, from the planner's optional DATA section. */
export interface CollectionSpec {
  name: string;
  description: string;
}

/** Everything the planner call produces. */
export interface AppPlan {
  title: string;
  css: string;
  /** Body markup containing `<div data-slot="id"></div>` placeholders. */
  shell: string;
  /** Shared state and delegated listeners. Runs before any slot lands. */
  script: string;
  slots: SlotSpec[];
  /**
   * Collections this app's data API exposes. Empty for most apps — a static app should not
   * carry a data-API token it never uses (see `dataRuntime`). A row written before Phase 5
   * has no `collections` key at all; `getFilledApp` (store/generations.ts) defaults it to
   * `[]` on read, the same way a field added to a persisted JSONB shape always needs a
   * migration of *reads*, not just of writers.
   */
  collections: CollectionSpec[];
}

/** A plan plus the filled content of each slot, keyed by slot id. */
export interface FilledApp extends AppPlan {
  content: Record<string, string>;
}

export const SLOT_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

/**
 * Shared by the planner (parsing the DATA section), `packages/records` (validating a
 * collection name on every data-API request), and the fill prompts (naming collections in
 * context). One definition so the three never drift apart — a name the planner accepts but
 * the data API rejects would be a collection nothing can ever write to.
 */
export const COLLECTION_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

/**
 * Tolerant placeholder scan.
 *
 * The planner prompt asks for `<div data-slot="id"></div>` exactly, but the model routinely
 * writes `<div class="panel" data-slot="chart"></div>` (a styling hook for its own CSS) or
 * `<span data-slot="last-updated"></span>` — a byte-exact regex missed those entirely,
 * measured at 28% of real generations losing the whole shell/slots architecture to the
 * linear fallback (`shell contains no slot placeholders`), plus silent partial drops when
 * only some placeholders in a shell matched. See `.docs/open-problems.md`'s "Phase 6
 * pre-flight" section.
 *
 * Any tag name, any attributes in any order (in either quote style), self-closing or
 * open/close with only whitespace between — but never non-whitespace content, which is
 * genuinely ambiguous and not something a regex can safely treat as an empty placeholder.
 * Groups: 1 = tag, 2 = attribute blob, 3 = id (double-quoted), 4 = id (single-quoted).
 */
const ATTR = '[a-z-]+\\s*=\\s*(?:"[^"]*"|\'[^\']*\')';
const DS = 'data-slot\\s*=\\s*(?:"([a-z][a-z0-9-]{0,30})"|\'([a-z][a-z0-9-]{0,30})\')';
const OPEN = "<([a-z][a-z0-9]*)((?:\\s+" + ATTR + ")*?\\s+" + DS + "(?:\\s+" + ATTR + ")*)\\s*";
const PLACEHOLDER_PATTERN = OPEN + "(?:\\/>|>\\s*<\\/\\1\\s*>)";

/** One `data-slot="id"` attribute occurrence, in the form the generic attribute scan finds it. */
const DATA_SLOT_ATTR = /data-slot\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** A generic `name="value"`/`name='value'` attribute, used to pull attributes out of a match's blob. */
const GENERIC_ATTR = /([a-zA-Z-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/**
 * Blanks out `<script>...</script>` bodies (replacing with equal-length spaces, so every
 * other match's index stays valid against the original string). The shell legitimately
 * contains scripts, and a model writing `el.innerHTML = '<div data-slot="x"></div>'` must
 * not have that string rewritten as if it were a real placeholder.
 */
function maskScripts(shell: string): string {
  return shell.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => " ".repeat(m.length));
}

interface PlaceholderMatch {
  index: number;
  length: number;
  tag: string;
  attrs: string;
  id: string;
}

/**
 * Runs the tolerant scan against `shell`, script-masked, skipping any match that is our own
 * previously-rendered output (contains `id="slot-…"`, either quote style) — since S12,
 * `renderSkeletons` emits `data-slot` itself, and without this guard a rendered document
 * would re-scan as if it were an unfilled shell. Both `renderSkeletons` and `slotIdsInShell`
 * go through this one function so they can never disagree about what counts as a placeholder.
 */
function scanPlaceholders(shell: string): PlaceholderMatch[] {
  const masked = maskScripts(shell);
  const re = new RegExp(PLACEHOLDER_PATTERN, "gi");
  const out: PlaceholderMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const full = m[0];
    if (/id\s*=\s*["']slot-/i.test(full)) continue;
    const id = (m[3] ?? m[4])!;
    out.push({ index: m.index, length: full.length, tag: m[1]!, attrs: m[2] ?? "", id });
  }
  return out;
}

function parseAttrs(blob: string): Array<{ name: string; value: string }> {
  const attrs: Array<{ name: string; value: string }> = [];
  GENERIC_ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = GENERIC_ATTR.exec(blob))) {
    attrs.push({ name: m[1]!, value: m[2] ?? m[3] ?? "" });
  }
  return attrs;
}

/**
 * Ids named by a `data-slot="..."` attribute somewhere in the (script-masked) shell that the
 * tolerant scan above did NOT recognize as a complete placeholder — e.g. real content inside
 * the element, a mismatched closing tag, or a malformed quote. Used by `parsePlan` to fail
 * loudly with `PlanError` instead of silently dropping the region (see `.docs/open-problems.md`).
 */
export function unmatchedSlotAttributes(shell: string): string[] {
  const masked = maskScripts(shell);
  const matchedSpans = scanPlaceholders(shell).map((m) => [m.index, m.index + m.length] as const);
  const isInsideMatch = (i: number) => matchedSpans.some(([start, end]) => i >= start && i < end);
  const out: string[] = [];
  DATA_SLOT_ATTR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DATA_SLOT_ATTR.exec(masked))) {
    if (isInsideMatch(m.index)) continue;
    const raw = (m[1] ?? m[2] ?? "").trim();
    out.push(raw || "(unparseable)");
  }
  return out;
}

/**
 * Server-owned skeleton styling. Deliberately not left to the planner: skeletons should
 * look identical across every generated app, and a planner that invents its own each time
 * makes loading states one more thing that varies for no reason.
 */
export const SKELETON_CSS = `
.anyapp-skeleton{position:relative;overflow:hidden;border-radius:8px;background:color-mix(in srgb,currentColor 8%,transparent)}
.anyapp-skeleton::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,currentColor 10%,transparent),transparent);animation:anyapp-shimmer 1.2s infinite}
@keyframes anyapp-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.anyapp-slot-error{padding:16px;border:1px dashed color-mix(in srgb,currentColor 25%,transparent);border-radius:8px;opacity:.65;font:14px system-ui,sans-serif}
`.trim();

/**
 * CSS class selectors appearing in a stylesheet: a `.` followed by a name that starts with a
 * letter, `_`, or `-`. No lookbehind excluding a preceding word character — a decimal like
 * `0.5` or `.65` is already excluded by the capture group alone, since the character right
 * after the `.` there is a digit, which the group's first character class rejects. A
 * lookbehind would additionally (and wrongly) reject the second class of a genuine compound
 * selector — `.form-panel.hidden` — since `.hidden` there is preceded by the word character
 * `l`. That was a real bug caught during review: it made `utilityCss` below blind to a
 * planner that legitimately defined `.hidden` as part of a compound selector, which is
 * exactly the "clobber a planner's own opinion" failure mode `utilityCss`'s doc comment says
 * must be avoided. `tests/quality/checks-doc.ts` keeps its own separate copy of a
 * similarly-named regex for its own class-usage scan (tests cannot reach into production
 * internals not exported for it) — that copy is not this one and is not affected by this fix.
 */
const CSS_CLASS_SELECTOR = /\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g;

/**
 * A `.hidden{display:none}` fallback, returned only when the planner's own stylesheet does not
 * already define a `.hidden` class selector; an empty string otherwise. Real cause: the fill
 * call is told "never write a `<style>` element or a style attribute" and to use the planner's
 * classes, but the planner writes the stylesheet before any region's actual states (toggled
 * panels, active tabs, positive/negative values) are known — so slot content routinely emits
 * `class="confirmation-panel hidden"` with no `.hidden` rule anywhere. `.hidden` is the one
 * state class safe to guess a fallback for, because "hidden" has exactly one reasonable
 * meaning; `.active`/`.selected`/`.positive` do not, and must not get guessed styling here.
 *
 * Callers MUST place the returned rule in a `<style>` emitted AFTER `<style id="anyapp-css">`
 * — see `renderShellHead` — so that when it fires it wins ties on source order alone. Two
 * simpler designs were rejected:
 *  - Folding a plain `.hidden{display:none}` into `SKELETON_CSS` (emitted BEFORE the planner
 *    stylesheet) loses to any later planner rule of equal specificity — a planner-written
 *    `.confirmation-panel{display:block}` would beat an earlier `.hidden`, which is exactly
 *    the observed bug (a JS-toggled success panel stuck permanently visible).
 *  - Using `!important` to force the rule to win regardless of order would clobber a planner
 *    that legitimately defined `.hidden` itself (e.g. `visibility:hidden` plus a transition) —
 *    we cannot tell that apart from an accident, so we must not override it.
 * Emitting last, and only in the planner's silence, avoids both failure modes without
 * guessing at styling the planner never asked for.
 */
export function utilityCss(planCss: string): string {
  CSS_CLASS_SELECTOR.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = CSS_CLASS_SELECTOR.exec(planCss))) {
    if (m[1] === "hidden") return "";
  }
  return ".hidden{display:none}";
}

const SLOT_ERROR_MARKER = 'class="anyapp-slot-error"';

/** Stored as a slot's content when generation fails, so the document stays complete. */
export function slotErrorPlaceholder(id: string): string {
  return `<p ${SLOT_ERROR_MARKER}>This section could not be generated. Ask for a change to "${id}" to try again.</p>`;
}

/**
 * True when a slot's stored content is the placeholder above, not real content. An edit
 * request against a placeholder is a fill, not an edit — there is nothing to preserve, and
 * `SLOT_EDIT_PROMPT`'s "this is an edit, not a rewrite" rule would otherwise have the model
 * dutifully keep the apology paragraph intact. See edits.ts.
 */
export function isSlotErrorPlaceholder(html: string): boolean {
  return html.includes(SLOT_ERROR_MARKER);
}

/**
 * Renders one matched placeholder as a sized skeleton, keeping the model's tag and
 * attributes rather than discarding them — the model's own stylesheet targets classes it
 * put on the placeholder (e.g. `class="panel"`), so replacing the element wholesale silently
 * broke that styling even when the old exact-match regex succeeded.
 *
 * Merges rather than clobbers: an existing `style` gets `min-height:<height>px` appended, an
 * existing `class` gets `anyapp-skeleton` appended, and `id`/`data-slot` are always forced to
 * our own `id="slot-<id>"` / `data-slot="<id>"` (S12 — see the comment on
 * `unmatchedSlotAttributes`'s sibling scan above) regardless of what the model wrote there.
 */
function renderSkeletonElement(m: PlaceholderMatch, height: number): string {
  const attrs = parseAttrs(m.attrs);
  let classValue: string | null = null;
  let styleValue: string | null = null;
  const rest: string[] = [];
  for (const a of attrs) {
    const lname = a.name.toLowerCase();
    if (lname === "id" || lname === "data-slot") continue;
    if (lname === "class") {
      classValue = a.value;
      continue;
    }
    if (lname === "style") {
      styleValue = a.value;
      continue;
    }
    rest.push(`${a.name}="${a.value}"`);
  }
  const trimmedClass = classValue?.trim() ?? "";
  const mergedClass = trimmedClass ? `${trimmedClass} anyapp-skeleton` : "anyapp-skeleton";
  const trimmedStyle = styleValue?.trim() ?? "";
  const styleSep = trimmedStyle && !trimmedStyle.endsWith(";") ? "; " : "";
  const mergedStyle = trimmedStyle ? `${trimmedStyle}${styleSep}min-height:${height}px` : `min-height:${height}px`;
  const parts = [`id="slot-${m.id}"`, `data-slot="${m.id}"`, ...rest, `class="${mergedClass}"`, `style="${mergedStyle}"`];
  return `<${m.tag} ${parts.join(" ")}></${m.tag}>`;
}

/**
 * Replaces each slot placeholder with a sized skeleton the browser can paint immediately.
 * Unknown slot ids are left with height 0 rather than throwing — a plan with one stray
 * placeholder should still render. See `unmatchedSlotAttributes` above for why the scan is
 * tolerant of shape and `renderSkeletonElement` for why the model's own element is kept
 * rather than replaced.
 */
export function renderSkeletons(shell: string, slots: SlotSpec[]): string {
  const byId = new Map(slots.map((s) => [s.id, s]));
  const matches = scanPlaceholders(shell);
  if (matches.length === 0) return shell;
  let out = "";
  let last = 0;
  for (const m of matches) {
    out += shell.slice(last, m.index);
    const slot = byId.get(m.id);
    const height = slot ? slot.height : 0;
    out += renderSkeletonElement(m, height);
    last = m.index + m.length;
  }
  out += shell.slice(last);
  return out;
}

/** The list of slot ids actually referenced by the shell, in document order. */
export function slotIdsInShell(shell: string): string[] {
  return scanPlaceholders(shell).map((m) => m.id);
}

/** Opening tag for a slot's content block. Shared with the streaming emitter. */
export function slotOpen(id: string): string {
  return `<template id="c-${id}">`;
}

/** Closing tag plus the swap call that moves the content into place. */
export function slotClose(id: string): string {
  return `</template><script>swap(${JSON.stringify(id)})</script>\n`;
}

/**
 * The one and only definition of a generated app's document.
 *
 * The live generation stream is an *incremental emission of exactly this* — same shell,
 * same templates, same swap calls, same ordering — which is what keeps a replayed app
 * behaving identically to one being watched as it generates. Editing re-renders through
 * here too, so an edited app is structurally the same kind of document as a fresh one.
 */
export function renderDocument(
  filled: FilledApp,
  renderHead: (plan: AppPlan) => string,
  tail: string,
): string {
  let out = renderHead(filled);
  for (const slot of filled.slots) {
    out += slotOpen(slot.id) + (filled.content[slot.id] ?? "") + slotClose(slot.id);
  }
  return out + tail;
}

/** Runtime shape check for a `plan` column written by an older build. */
export function isFilledApp(value: unknown): value is FilledApp {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.title === "string" &&
    typeof v.css === "string" &&
    typeof v.shell === "string" &&
    typeof v.script === "string" &&
    Array.isArray(v.slots) &&
    typeof v.content === "object" &&
    v.content !== null
  );
}
