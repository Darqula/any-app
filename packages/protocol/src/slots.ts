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

export interface AppPlan {
  title: string;
  css: string;
  /** Body markup containing `<div data-slot="id"></div>` placeholders. */
  shell: string;
  /** Shared state and delegated listeners. Runs before any slot lands. */
  script: string;
  slots: SlotSpec[];
  /** Empty for most apps. Older rows lack the key (getFilledApp defaults it). */
  collections: CollectionSpec[];
}

export interface FilledApp extends AppPlan {
  content: Record<string, string>;
}

export const SLOT_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

/** Shared by the planner, records and fill prompts so the names they accept never drift apart. */
export const COLLECTION_PATTERN = /^[a-z][a-z0-9_]{0,30}$/;

/**
 * Tolerant placeholder scan: any tag, any attribute order/quoting, empty or self-closing, never with content.
 * Groups: 1 tag, 2 attribute blob, 3 id (double-quoted), 4 id (single-quoted).
 */
const ATTR =
  '[a-z][a-z0-9:-]*(?:\\s*=\\s*(?:"[^"]*"|\'[^\']*\'|[^\\s"\'=<>`]+))?';
const DS = 'data-slot\\s*=\\s*(?:"([a-z][a-z0-9-]{0,30})"|\'([a-z][a-z0-9-]{0,30})\')';
const OPEN = "<([a-z][a-z0-9]*)((?:\\s+" + ATTR + ")*?\\s+" + DS + "(?:\\s+" + ATTR + ")*)\\s*";
const PLACEHOLDER_PATTERN = OPEN + "(?:\\/>|>\\s*<\\/\\1\\s*>)";

const DATA_SLOT_ATTR = /data-slot\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;

/** One attribute, quoted, unquoted or boolean. Groups: 1 name, 2 "…", 3 '…', 4 unquoted. */
const GENERIC_ATTR = /([a-zA-Z][a-zA-Z0-9:-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Blanks <script> bodies with equal-length spaces so match indexes stay valid. */
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

/** Tolerant scan over the script-masked shell; skips already-rendered output (id="slot-…"). */
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
    // A boolean attribute has no value; it is stored as "" and re-emitted as hidden="".
    attrs.push({ name: m[1]!, value: m[2] ?? m[3] ?? m[4] ?? "" });
  }
  return attrs;
}

/**
 * Ids in a data-slot attribute the scan did not accept as a complete placeholder
 * (content inside, mismatched close tag, bad quote). parsePlan fails loudly on these.
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

/** Void elements never open or close a nesting level. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source",
  "track", "wbr",
]);

type TagToken = { end: number; name: string; closing: boolean; selfClosing: boolean };

/**
 * Reads the tag at s[start] === '<', honouring quoted values. Returns null when it is not a tag
 * at all, "unterminated" when no closing '>' arrives.
 */
function readTag(s: string, start: number): TagToken | "unterminated" | null {
  let i = start + 1;
  let closing = false;
  if (s[i] === "/") {
    closing = true;
    i++;
  }
  const nameStart = i;
  while (i < s.length && /[a-zA-Z0-9]/.test(s[i]!)) i++;
  if (i === nameStart) return null;
  const name = s.slice(nameStart, i).toLowerCase();

  let inQuote: string | null = null;
  while (i < s.length) {
    const ch = s[i];
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      i++;
      continue;
    }
    if (ch === ">") {
      const selfClosing = s[i - 1] === "/";
      return { end: i, name, closing, selfClosing };
    }
    i++;
  }
  return "unterminated";
}

/**
 * Close tag matching the same-named element opened just before contentStart (nesting of that
 * tag name only). Returns null when it cannot tell: no close tag, or an unterminated
 * comment/script/style body or attribute quote.
 */
function findMatchingClose(
  shell: string,
  tagName: string,
  contentStart: number,
): { contentEnd: number; closeEnd: number; closeText: string } | null {
  const lower = tagName.toLowerCase();
  let i = contentStart;
  const n = shell.length;
  let depth = 1;
  while (i < n) {
    const lt = shell.indexOf("<", i);
    if (lt === -1) return null;

    if (shell.startsWith("<!--", lt)) {
      const end = shell.indexOf("-->", lt + 4);
      if (end === -1) return null;
      i = end + 3;
      continue;
    }

    const tag = readTag(shell, lt);
    if (tag === "unterminated") return null;
    if (tag === null) {
      i = lt + 1; // stray '<' in text — not a tag, keep scanning
      continue;
    }
    const { end, name, closing, selfClosing } = tag;

    if (name === "script" || name === "style") {
      if (closing || selfClosing) {
        i = end + 1;
        continue;
      }
      const rest = shell.slice(end + 1);
      const bodyMatch = new RegExp(`<\\/${name}\\s*>`, "i").exec(rest);
      if (!bodyMatch) return null; // unterminated script/style body
      i = end + 1 + bodyMatch.index + bodyMatch[0].length;
      continue;
    }

    if (name === lower) {
      if (selfClosing || VOID_ELEMENTS.has(name)) {
        i = end + 1;
        continue;
      }
      if (closing) {
        depth--;
        if (depth === 0) {
          return { contentEnd: lt, closeEnd: end + 1, closeText: shell.slice(lt, end + 1) };
        }
        i = end + 1;
        continue;
      }
      depth++;
      i = end + 1;
      continue;
    }

    i = end + 1;
  }
  return null;
}

/**
 * Blanks comments and script/style bodies so a data-slot-shaped string inside them is not
 * mistaken for a nested slot.
 */
function maskNonMarkupForNestedSlotCheck(html: string): string {
  let out = html.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => " ".repeat(m.length));
  out = out.replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (m) => " ".repeat(m.length));
  return out;
}

export interface StrippedPlaceholder {
  id: string;
  removed: string;
}

/**
 * Strips content out of a data-slot element the scan rejected, so a placeholder body does not
 * fail the whole plan (swap() overwrites it anyway). A safety net, not the primary fix.
 * Leaves void, self-closing, unmatched and nested-slot cases for parsePlan to reject. Idempotent.
 */
export function sanitizePlaceholders(shell: string): { shell: string; stripped: StrippedPlaceholder[] } {
  const masked = maskScripts(shell);
  const matchedSpans = scanPlaceholders(shell).map((m) => [m.index, m.index + m.length] as const);
  const isInsideMatch = (i: number) => matchedSpans.some(([start, end]) => i >= start && i < end);

  // Opening tag only, with an optional trailing "/" so self-closing occurrences are skipped.
  const openTagPattern = OPEN + "(\\/)?>";
  const re = new RegExp(openTagPattern, "gi");
  const replacements: { start: number; end: number; text: string }[] = [];
  const stripped: StrippedPlaceholder[] = [];

  let m: RegExpExecArray | null;
  while ((m = re.exec(masked))) {
    const full = m[0];
    if (/id\s*=\s*["']slot-/i.test(full)) continue; // our own rendered output — never touch
    if (isInsideMatch(m.index)) continue; // already a complete, valid empty placeholder
    if (m[5]) continue; // self-closing — no content to strip

    const tag = m[1]!;
    const id = (m[3] ?? m[4])!;
    if (VOID_ELEMENTS.has(tag.toLowerCase())) continue; // no legal body to strip

    const openEnd = m.index + full.length;
    const close = findMatchingClose(shell, tag, openEnd);
    if (!close) continue; // boundaries not unambiguous — leave for PlanError

    const content = shell.slice(openEnd, close.contentEnd);

    const maskedContent = maskNonMarkupForNestedSlotCheck(content);
    DATA_SLOT_ATTR.lastIndex = 0;
    if (DATA_SLOT_ATTR.test(maskedContent)) continue; // nested data-slot — keep failing loudly

    const openText = shell.slice(m.index, openEnd);
    replacements.push({ start: m.index, end: close.closeEnd, text: openText + close.closeText });
    stripped.push({ id, removed: content });
  }

  if (replacements.length === 0) return { shell, stripped: [] };

  let out = "";
  let last = 0;
  for (const r of replacements) {
    out += shell.slice(last, r.start);
    out += r.text;
    last = r.end;
  }
  out += shell.slice(last);
  return { shell: out, stripped };
}

/** Server-owned so loading states look the same in every app. */
export const SKELETON_CSS = `
.anyapp-skeleton{position:relative;overflow:hidden;border-radius:8px;background:color-mix(in srgb,currentColor 8%,transparent)}
.anyapp-skeleton::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,color-mix(in srgb,currentColor 10%,transparent),transparent);animation:anyapp-shimmer 1.2s infinite}
@keyframes anyapp-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
.anyapp-slot-error{padding:16px;border:1px dashed color-mix(in srgb,currentColor 25%,transparent);border-radius:8px;opacity:.65;font:14px system-ui,sans-serif}
`.trim();

/**
 * Class selectors in a stylesheet. No lookbehind: it would miss the second class of a
 * compound selector such as .a.hidden.
 */
const CSS_CLASS_SELECTOR = /\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g;

/**
 * True when some compound selector carries .hidden as its only class (".hidden", ".a .hidden",
 * ".a, .hidden"; not ".a.hidden"). A different question from CSS_CLASS_SELECTOR's — do not merge.
 */
function hasStandaloneHiddenSelector(css: string): boolean {
  // Drop declaration blocks so value text (url(x.hidden.png), .65) is not scanned as selectors.
  const selectorsOnly = css.replace(/\{[^{}]*\}/g, " ");
  // Drop parenthesised arguments (:not(.foo)) so they are not read as classes on the same element.
  const withoutParens = selectorsOnly.replace(/\([^()]*\)/g, "");
  const units = withoutParens.split(/[\s,>+~]+/).filter(Boolean);
  for (const unit of units) {
    const classes = new Set<string>();
    CSS_CLASS_SELECTOR.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = CSS_CLASS_SELECTOR.exec(unit))) classes.add(m[1]!);
    if (classes.size === 1 && classes.has("hidden")) return true;
  }
  return false;
}

/**
 * .hidden{display:none} fallback, only when the planner defines no standalone .hidden.
 * Must be emitted after the planner stylesheet so it wins on source order alone.
 */
export function utilityCss(planCss: string): string {
  if (hasStandaloneHiddenSelector(planCss)) return "";
  return ".hidden{display:none}";
}

const SLOT_ERROR_MARKER = 'class="anyapp-slot-error"';

/** Stored as a slot's content when generation fails, so the document stays complete. */
export function slotErrorPlaceholder(id: string): string {
  return `<p ${SLOT_ERROR_MARKER}>This section could not be generated. Ask for a change to "${id}" to try again.</p>`;
}

/** True when a region holds the failed-fill placeholder; an edit of it is really a fill. */
export function isSlotErrorPlaceholder(html: string): boolean {
  return html.includes(SLOT_ERROR_MARKER);
}

/**
 * Keeps the model's tag and attributes: min-height is merged into style, anyapp-skeleton into
 * class, and id/data-slot are forced to ours.
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

/** Replaces each placeholder with a sized skeleton. Unknown ids get height 0 rather than throwing. */
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
 * The single definition of a generated app's document. The live stream emits exactly this,
 * incrementally, so a replay matches what was watched.
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
