/**
 * Section F (provider-output contract): string/DOM-level checks over one generation's persisted plan, document and error, plus the raw
 * stream bytes for F3's order half. Best-effort approximations; nothing throws or asserts (runner.ts turns results into rates).
 */
import { isFilledApp, isSlotErrorPlaceholder } from "@any-app/protocol";
import type { FilledApp } from "@any-app/protocol";

export type CheckStatus = "pass" | "fail" | "skip";

export interface CheckResult {
  id: string;
  label: string;
  status: CheckStatus;
  detail?: string;
}

export interface GenerationRow {
  status: string;
  document: string | null;
  plan: unknown;
  error: string | null;
}

function ok(id: string, label: string, pass: boolean, detail?: string): CheckResult {
  return { id, label, status: pass ? "pass" : "fail", detail };
}

function skip(id: string, label: string, reason: string): CheckResult {
  return { id, label, status: "skip", detail: reason };
}

/** F6 scan constants. Self-contained on purpose: a check that calls the production scanner passes by construction. */

/** Any opening or self-closing tag, capturing the name and the attribute text; never a closing tag. So <section data-slot> is examined too. */
const F6_OPEN_TAG = /<([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;

/** One data-slot attribute (any quote style or bare), capturing ANY value so an invalid id is reported, not missed. */
const F6_DATA_SLOT_VALUE = /\bdata-slot\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]*))/i;

/** The required id shape, mirrored from SLOT_ID_PATTERN as a literal (a constant, not scanning logic). */
const F6_ID_PATTERN = /^[a-z][a-z0-9-]{0,30}$/;

const ALLOWED_EXTERNAL_HOST = "cdnjs.cloudflare.com";
/** Absolute http(s) URLs in src/href only: a whole-document scan over-fires on URLs mentioned as text. */
const ATTR_URL = /\b(?:src|href)="(https?:\/\/[^"]+)"/gi;

/**
 * Class selectors. No lookbehind: the first-character rule already excludes decimals, and a lookbehind hid the second class of a
 * compound selector (`.ctrl-btn.start`), which produced 12 of 27 false "undefined" offenders on the 20 saved documents.
 * Permissive on purpose: it collects declared names, not a CSS parse. A class only inside a CSS comment or string still counts as defined.
 */
export const CSS_CLASS_SELECTOR = /\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g;
/** class="..." or class='...' (groups 1 and 2). Only run on content already masked by maskForClassScan. */
const CLASS_ATTR = /\bclass=(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Blanks <script> bodies and <!-- --> comments with equal-length spaces before the class scan, so JS strings and commented-out markup are
 * not scored as used. Scripts go first, which makes matching single-quoted attributes safe; an unclosed <script> runs to the end of
 * input, as HTML does (truncated fills).
 */
export function maskForClassScan(content: string): string {
  const noScripts = content.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, (m) => " ".repeat(m.length));
  return noScripts.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
}

/** Classes that always exist: server-owned skeleton/error classes and `hidden` (the server emits a .hidden utility when the planner has none). */
const ALWAYS_DEFINED_CLASSES = new Set(["anyapp-skeleton", "anyapp-slot-error", "hidden"]);

/** The set of classes the planner stylesheet defines, shared with the S13 probe. Does not include ALWAYS_DEFINED_CLASSES. */
export function definedClassesFromCss(css: string): Set<string> {
  const defined = new Set<string>();
  for (const m of css.matchAll(CSS_CLASS_SELECTOR)) defined.add(m[1]!);
  return defined;
}

/** F1: no <style> in any slot's content: CSS belongs only to the planner's single stylesheet. */
function checkF1(plan: FilledApp): CheckResult {
  const offenders = plan.slots.filter((s) => /<style[\s>]/i.test(plan.content[s.id] ?? ""));
  return ok(
    "F1",
    "Fill output contains no <style> element",
    offenders.length === 0,
    offenders.length ? `slot(s) with a <style> element: ${offenders.map((s) => s.id).join(", ")}` : undefined,
  );
}

/** F2: no markdown fence in any slot's filled content. */
function checkF2(plan: FilledApp): CheckResult {
  const offenders = plan.slots.filter((s) => (plan.content[s.id] ?? "").includes("```"));
  return ok(
    "F2",
    "Fill output contains no markdown fence",
    offenders.length === 0,
    offenders.length ? `slot(s) with a fence: ${offenders.map((s) => s.id).join(", ")}` : undefined,
  );
}

/**
 * F3: every slot has content, in order. Coverage applies to both fill modes. Order is scored only under sequential fill (from the swap()
 * sequence in the raw stream) and skipped under parallel, where out-of-order completion is correct. Passes only when both applicable halves hold.
 */
function checkF3(plan: FilledApp, rawStreamBody: string, fillMode: string): CheckResult {
  const missing = plan.slots.filter((s) => {
    const content = plan.content[s.id];
    return !content || !content.trim() || isSlotErrorPlaceholder(content);
  });
  const coverage = missing.length === 0;

  if (fillMode !== "sequential") {
    return ok(
      "F3",
      "Fill output emits a section for every slot, in order",
      coverage,
      coverage
        ? "coverage only — order not scored under parallel mode (out-of-order completion is expected there, not a defect; see checks-doc.ts)"
        : `missing/placeholder slot(s): ${missing.map((s) => s.id).join(", ")}`,
    );
  }

  const emittedOrder: string[] = [];
  const seen = new Set<string>();
  for (const m of rawStreamBody.matchAll(/swap\("([^"]+)"\)/g)) {
    const id = m[1]!;
    if (plan.slots.some((s) => s.id === id) && !seen.has(id)) {
      seen.add(id);
      emittedOrder.push(id);
    }
  }
  const expectedOrder = plan.slots.map((s) => s.id);
  const orderOk = emittedOrder.join("|") === expectedOrder.join("|");

  const pass = coverage && orderOk;
  let detail: string | undefined;
  if (!coverage) detail = `missing/placeholder slot(s): ${missing.map((s) => s.id).join(", ")}`;
  else if (!orderOk) detail = `expected order [${expectedOrder.join(", ")}], emitted [${emittedOrder.join(", ")}]`;
  return ok("F3", "Fill output emits a section for every slot, in order", pass, detail);
}

/**
 * F4: the plan parses. Approximated as "a structured plan exists": a PlanError sends the route to the linear path, which stores none.
 * plannerFailureReason (the live PlanError message) only fills `detail`; parsePlan is never called here.
 */
function checkF4(planRaw: unknown, plannerFailureReason?: string): CheckResult {
  const pass = isFilledApp(planRaw);
  return ok("F4", "Plan output parses without a PlanError", pass, pass ? undefined : plannerFailureReason);
}

/** F5: slot count between 2 and 6 (inclusive), per `PLANNER_PROMPT`'s "use between 2 and 6
 * slots." */
function checkF5(plan: FilledApp): CheckResult {
  const n = plan.slots.length;
  return ok("F5", "Slot count is between 2 and 6", n >= 2 && n <= 6, `slot count: ${n}`);
}

/**
 * F6: invariants on every data-slot element in the persisted, already-sanitised shell: valid id, unique, empty; any tag or attributes allowed.
 * The emptiness check is an invariant guard: model behaviour shows up in the studio log line "stripped-placeholder-content".
 * A self-closing placeholder passes.
 */
function findDataSlotContentEnd(masked: string, tagName: string, contentStart: number): number | null {
  const lower = tagName.toLowerCase();
  if (VOID_ELEMENTS.has(lower)) return contentStart; // no legal body to be non-empty
  // Fresh regex per call, so it does not share lastIndex with the outer scan.
  const tagScan = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;
  tagScan.lastIndex = contentStart;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tagScan.exec(masked))) {
    const closing = m[1] === "/";
    const name = m[2]!.toLowerCase();
    if (name !== lower) continue;
    const selfClosing = /\/\s*$/.test(m[3]!) || VOID_ELEMENTS.has(name);
    if (closing) {
      depth--;
      if (depth === 0) return m.index;
    } else if (!selfClosing) {
      depth++;
    }
    // a self-closing same-name tag nested inside doesn't open a new depth level
  }
  return null; // no matching close found before end of string — ambiguous
}

function checkF6(plan: FilledApp): CheckResult {
  const masked = maskForClassScan(plan.shell);
  const offenders: string[] = [];
  const seenIds = new Map<string, number>();

  F6_OPEN_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = F6_OPEN_TAG.exec(masked))) {
    const tag = m[1]!;
    const attrs = m[2]!;
    const dsMatch = F6_DATA_SLOT_VALUE.exec(attrs);
    if (!dsMatch) continue; // not a data-slot element at all — any tag/attrs otherwise is fine

    const rawId = (dsMatch[1] ?? dsMatch[2] ?? dsMatch[3] ?? "").trim();
    if (!F6_ID_PATTERN.test(rawId)) {
      offenders.push(`invalid data-slot id "${rawId || "(empty)"}" on <${tag}>`);
      continue; // malformed id — don't also chase content/duplicate checks for it
    }

    seenIds.set(rawId, (seenIds.get(rawId) ?? 0) + 1);

    const selfClosing = /\/\s*$/.test(attrs);
    if (!selfClosing) {
      const contentStart = m.index + m[0]!.length;
      const closeIndex = findDataSlotContentEnd(masked, tag, contentStart);
      if (closeIndex === null) {
        offenders.push(`"${rawId}": no matching </${tag}> found`);
      } else {
        const inner = masked.slice(contentStart, closeIndex);
        if (inner.trim() !== "") {
          offenders.push(`"${rawId}": non-empty content (${inner.trim().length} char(s))`);
        }
      }
    }
  }

  for (const [id, count] of seenIds) {
    if (count > 1) offenders.push(`duplicate data-slot id "${id}" (${count}x)`);
  }

  return ok(
    "F6",
    "Every data-slot element has a valid, unique id and is empty",
    offenders.length === 0,
    offenders.length ? offenders.slice(0, 5).join(" | ") : undefined,
  );
}

/**
 * F7: external references only from cdnjs.cloudflare.com, scoped to src/href. An inline fetch("https://...") in a slot script is a known gap.
 * Runs on the whole document, so it still means something on a linear-fallback one.
 */
function checkF7(document: string): CheckResult {
  const offenders = new Set<string>();
  for (const m of document.matchAll(ATTR_URL)) {
    const url = m[1]!;
    try {
      if (new URL(url).host !== ALLOWED_EXTERNAL_HOST) offenders.add(url);
    } catch {
      offenders.add(url);
    }
  }
  return ok(
    "F7",
    "External references only from cdnjs.cloudflare.com",
    offenders.size === 0,
    offenders.size ? `disallowed reference(s): ${[...offenders].slice(0, 5).join(", ")}` : undefined,
  );
}

/**
 * F8: class names used in slot content are defined in the planner CSS. Scored per element: it fails only when NONE of its classes is defined
 * (a JS-hook class on an otherwise styled element is fine). Known gaps: classes added at runtime (classList.add, string-built markup) and
 * non-static ones are invisible; comments and scripts are masked.
 */

/** One class attribute found in a slot's masked content, with how its tokens resolved. Shared by checkF8 and its modifier diagnostic. */
interface ClassAttrUsage {
  slotId: string;
  /** The full attribute text, so a reader sees the element's whole class list. */
  classAttr: string;
  tokens: string[];
  undefinedTokens: string[];
  hasDefinedToken: boolean;
}

function scanClassAttrUsages(plan: FilledApp, defined: Set<string>): ClassAttrUsage[] {
  const usages: ClassAttrUsage[] = [];
  for (const slot of plan.slots) {
    const content = maskForClassScan(plan.content[slot.id] ?? "");
    for (const m of content.matchAll(CLASS_ATTR)) {
      const classList = m[1] ?? m[2] ?? "";
      const tokens = classList.split(/\s+/).filter(Boolean);
      if (tokens.length === 0) continue; // class="" — nothing to judge either way
      const undefinedTokens = tokens.filter((c) => !defined.has(c) && !ALWAYS_DEFINED_CLASSES.has(c));
      usages.push({
        slotId: slot.id,
        classAttr: m[0]!,
        tokens,
        undefinedTokens,
        hasDefinedToken: undefinedTokens.length < tokens.length,
      });
    }
  }
  return usages;
}

/** Id of the non-spec diagnostic split out of F8's old token-level behaviour. Not F<n>-shaped, and not in DOC_CASE_IDS. */
export const F8_MODIFIER_DIAGNOSTIC_ID = "DIAG:undefined-modifier";

/**
 * Diagnostic: an element passes F8 but carries an undefined modifier token (e.g. a state class its script toggles). Never counted in F8's rate;
 * it fired on nothing once the compound-selector bug was fixed.
 */
function checkF8ModifierDiagnostic(usages: ClassAttrUsage[]): CheckResult {
  const offenders = usages.filter((u) => u.hasDefinedToken && u.undefinedTokens.length > 0);
  const pass = offenders.length === 0;
  const detail = pass
    ? undefined
    : offenders
        .map((u) => `${u.slotId}: ${u.classAttr} (undefined modifier(s): ${u.undefinedTokens.join(", ")})`)
        .join(" | ");
  return ok(
    F8_MODIFIER_DIAGNOSTIC_ID,
    "[diagnostic, not spec F8] styled element also carries an undefined modifier class",
    pass,
    detail,
  );
}

function checkF8(usages: ClassAttrUsage[]): CheckResult {
  const offenders = usages.filter((u) => !u.hasDefinedToken);
  const pass = offenders.length === 0;
  const detail = pass
    ? undefined
    : offenders.map((u) => `${u.slotId}: ${u.classAttr}`).join(" | ");
  return ok(
    "F8",
    "Elements in slot content have at least one class defined in the planner CSS",
    pass,
    detail,
  );
}

/**
 * S13 diagnostics: [data-slot="x"] is the skeleton wrapper, while fill often wraps its content in an element carrying the region's class,
 * so a script selector and a CSS rule can hit different elements. Reported separately, never in F1-F8.
 */

/** Void elements have no close tag or children, so depth returns to 0 without waiting for one. */
const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** One open or close tag (group 1 `/`, 2 name, 3 attributes). Only run on masked content. */
const TOP_LEVEL_TAG = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)\b([^>]*)>/g;

export interface TopLevelScan {
  /** Count of element nodes at depth 0 — direct children of the scanned fragment. */
  elementCount: number;
  /** True when depth 0 holds non-whitespace text: a stray top-level text node is not a clean single root. */
  hasNonWhitespaceText: boolean;
  firstElementTag: string | null;
  firstElementAttrs: string | null;
}

/**
 * Walks masked markup tracking depth to see what sits at the top level of a slot's content. A permissive scan, not a parser:
 * no nesting validation, no <template> handling; a rare misparse shows in `detail`.
 */
export function scanTopLevel(masked: string): TopLevelScan {
  let depth = 0;
  let lastIndex = 0;
  let elementCount = 0;
  let hasNonWhitespaceText = false;
  let firstElementTag: string | null = null;
  let firstElementAttrs: string | null = null;

  TOP_LEVEL_TAG.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOP_LEVEL_TAG.exec(masked))) {
    const full = m[0]!;
    const closing = m[1]!;
    const tagName = m[2]!;
    const attrs = m[3]!;
    const textBefore = masked.slice(lastIndex, m.index);
    if (depth === 0 && textBefore.trim() !== "") hasNonWhitespaceText = true;
    lastIndex = m.index + full.length;

    const lname = tagName.toLowerCase();
    const selfClosing = /\/\s*$/.test(attrs) || VOID_ELEMENTS.has(lname);

    if (!closing) {
      if (depth === 0) {
        elementCount++;
        if (elementCount === 1) {
          firstElementTag = lname;
          firstElementAttrs = attrs;
        }
      }
      if (!selfClosing) depth++;
    } else if (depth > 0) {
      depth--;
    }
  }
  const tail = masked.slice(lastIndex);
  if (depth === 0 && tail.trim() !== "") hasNonWhitespaceText = true;

  return { elementCount, hasNonWhitespaceText, firstElementTag, firstElementAttrs };
}

/** Single (non-global) class matcher for one isolated tag; CLASS_ATTR is the global one. */
const SINGLE_CLASS_ATTR = /\bclass=(?:"([^"]*)"|'([^']*)')/;

export function extractClassTokens(attrsOrTag: string): string[] {
  const m = SINGLE_CLASS_ATTR.exec(attrsOrTag);
  if (!m) return [];
  const classList = m[1] ?? m[2] ?? "";
  return classList.split(/\s+/).filter(Boolean);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Class tokens on one slot's placeholder in the raw shell (before skeleton rendering merges classes). Tolerant of tag and attribute shape. */
export function placeholderClassTokens(shell: string, slotId: string): string[] {
  const re = new RegExp(
    `<[a-zA-Z][a-zA-Z0-9-]*\\b[^>]*\\bdata-slot=(?:"${escapeRegExp(slotId)}"|'${escapeRegExp(slotId)}')[^>]*>`,
    "i",
  );
  const m = re.exec(shell);
  if (!m) return [];
  return extractClassTokens(m[0]);
}

/** Per-slot verdict shared by both S13 diagnostics below, computed once per plan (same
 * "share one scan" reasoning as `scanClassAttrUsages` above). */
export interface SlotRootInfo {
  slotId: string;
  /** True when the slot's (masked) content is exactly one top-level element and nothing else
   * at depth 0 — see `scanTopLevel`. */
  singleRoot: boolean;
  rootTag: string | null;
  rootClasses: string[];
  /** True when `rootClasses` contains at least one class the planner CSS actually defines
   * (`defined`, the same set F8 builds from `CSS_CLASS_SELECTOR`). */
  rootHasDefinedClass: boolean;
}

export function analyzeSlotRoots(plan: FilledApp, defined: Set<string>): SlotRootInfo[] {
  return plan.slots.map((slot) => {
    const masked = maskForClassScan(plan.content[slot.id] ?? "");
    const scan = scanTopLevel(masked);
    const singleRoot = scan.elementCount === 1 && !scan.hasNonWhitespaceText;
    const rootClasses = singleRoot && scan.firstElementAttrs != null ? extractClassTokens(scan.firstElementAttrs) : [];
    return {
      slotId: slot.id,
      singleRoot,
      rootTag: scan.firstElementTag,
      rootClasses,
      rootHasDefinedClass: rootClasses.some((c) => defined.has(c)),
    };
  });
}

/** Id of the "fill wrapped its content in one semantic root" diagnostic. Not F<n>-shaped. */
export const F_WRAPPED_ROOT_DIAGNOSTIC_ID = "DIAG:fill-wrapped-root";

/**
 * Non-spec (S13): slots whose fill content is one top-level element carrying at least one planner-defined class. Not a bug alone; the setup
 * for S13. A fragment, a classless root, or only undefined classes does not count.
 */
/** The single definition of "wrapped root", reused by the probe so it cannot drift. */
export function wrappedRootOffenders(roots: SlotRootInfo[]): SlotRootInfo[] {
  return roots.filter((r) => r.singleRoot && r.rootHasDefinedClass);
}

function checkWrappedRootDiagnostic(roots: SlotRootInfo[]): CheckResult {
  const offenders = wrappedRootOffenders(roots);
  const pass = offenders.length === 0;
  const detail = pass
    ? undefined
    : offenders.map((r) => `${r.slotId}: <${r.rootTag} class="${r.rootClasses.join(" ")}">`).join(" | ");
  return ok(
    F_WRAPPED_ROOT_DIAGNOSTIC_ID,
    "[diagnostic, S13] fill call wrapped its content in a single semantic root",
    pass,
    detail,
  );
}

/** Id of the "same class on placeholder and wrapped root" diagnostic. */
export const F_DOUBLED_CLASS_DIAGNOSTIC_ID = "DIAG:doubled-region-class";

/**
 * Non-spec (S13): the same class on the shell placeholder and on the fill's wrapped root. Fires zero times today; a tripwire for a prompt that
 * puts the region's class on the placeholder, which would land it twice, nested.
 */
function checkDoubledClassDiagnostic(plan: FilledApp, roots: SlotRootInfo[]): CheckResult {
  const offenders: string[] = [];
  for (const r of roots) {
    if (!r.singleRoot || r.rootClasses.length === 0) continue;
    const placeholderClasses = placeholderClassTokens(plan.shell, r.slotId);
    const shared = r.rootClasses.filter((c) => placeholderClasses.includes(c));
    if (shared.length) offenders.push(`${r.slotId}: ${shared.join(", ")}`);
  }
  const pass = offenders.length === 0;
  return ok(
    F_DOUBLED_CLASS_DIAGNOSTIC_ID,
    "[diagnostic, S13] same class on both the shell placeholder and the fill content's root",
    pass,
    pass ? undefined : offenders.join(" | "),
  );
}

/**
 * Runs all of section F over one generation. rawStreamBody feeds only F3's order half; fillMode is the server's LLM_FILL_MODE;
 * plannerFailureReason is the live PlanError message read back from the capture.
 */
export function runDocChecks(
  row: GenerationRow,
  rawStreamBody: string,
  fillMode: string,
  plannerFailureReason?: string,
): CheckResult[] {
  const results: CheckResult[] = [];

  if (row.status !== "complete" || !row.document) {
    // A generation that never completed has only F7 to check, if any document text exists (the shell is written before fill).
    const reason = `generation did not complete (status: ${row.status}${row.error ? `, error: ${row.error}` : ""})`;
    for (const id of ["F1", "F2", "F3", "F4", "F5", "F6", "F8"]) results.push(skip(id, id, reason));
    results.push(skip(F8_MODIFIER_DIAGNOSTIC_ID, F8_MODIFIER_DIAGNOSTIC_ID, reason));
    results.push(skip(F_WRAPPED_ROOT_DIAGNOSTIC_ID, F_WRAPPED_ROOT_DIAGNOSTIC_ID, reason));
    results.push(skip(F_DOUBLED_CLASS_DIAGNOSTIC_ID, F_DOUBLED_CLASS_DIAGNOSTIC_ID, reason));
    results.push(
      row.document ? checkF7(row.document) : skip("F7", "F7", reason),
    );
    return results;
  }

  results.push(checkF4(row.plan, plannerFailureReason));
  results.push(checkF7(row.document));

  if (!isFilledApp(row.plan)) {
    const reason = "no structured plan persisted — parsePlan likely threw (PlanError), row went through the linear fallback";
    for (const id of ["F1", "F2", "F3", "F5", "F6", "F8"]) results.push(skip(id, id, reason));
    results.push(skip(F8_MODIFIER_DIAGNOSTIC_ID, F8_MODIFIER_DIAGNOSTIC_ID, reason));
    results.push(skip(F_WRAPPED_ROOT_DIAGNOSTIC_ID, F_WRAPPED_ROOT_DIAGNOSTIC_ID, reason));
    results.push(skip(F_DOUBLED_CLASS_DIAGNOSTIC_ID, F_DOUBLED_CLASS_DIAGNOSTIC_ID, reason));
    return results;
  }

  const plan = row.plan;
  results.push(checkF1(plan));
  results.push(checkF2(plan));
  results.push(checkF3(plan, rawStreamBody, fillMode));
  results.push(checkF5(plan));
  results.push(checkF6(plan));

  // F8 and its non-spec modifier diagnostic share one scan of the CSS + slot content — see
  // `scanClassAttrUsages`'s comment — so it only runs once per plan rather than twice.
  const defined = definedClassesFromCss(plan.css);
  const usages = scanClassAttrUsages(plan, defined);
  results.push(checkF8(usages));
  results.push(checkF8ModifierDiagnostic(usages));

  // The S13 diagnostics share F8's `defined` set and one scan of each slot's top level.
  const roots = analyzeSlotRoots(plan, defined);
  results.push(checkWrappedRootDiagnostic(roots));
  results.push(checkDoubledClassDiagnostic(plan, roots));

  return results;
}
