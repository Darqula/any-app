/**
 * Backend section F ("Provider-output contract", `.docs/tests-backend.md`) — string/DOM-level
 * checks over the persisted `plan`/`document`/`error` of one real generation, plus the raw
 * bytes of the live stream response (needed for F3's ordering half; see its comment below).
 *
 * These run against whatever a real model actually produced, so every check here is a
 * best-effort approximation of what the spec describes in prose — see each function's comment
 * for exactly where it is faithful and where it had to guess. `runner.ts` is what turns a
 * `CheckResult[]` into a pass rate; nothing here throws or asserts.
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

/**
 * F6's exact required shape (`packages/protocol/src/slots.ts`'s `PLACEHOLDER`). Anchored with
 * `^`/`$` per match via the `g` flag below only after being applied to one already-isolated
 * near-miss candidate, not to the whole shell — see `checkF6`.
 */
const EXACT_PLACEHOLDER = /^<div data-slot="[a-z][a-z0-9-]{0,30}"><\/div>$/;
/** Loose net for anything *trying* to be a slot placeholder, so near-misses are visible at
 * all — a strict-only scan would just silently not find them, since by construction anything
 * that fails the strict shape never became a `SlotSpec` in the first place. */
const NEAR_MISS_PLACEHOLDER = /<div[^>]*\bdata-slot\b[^>]*>(?:\s*<\/div>)?/gi;

/** F7's allowed external host. */
const ALLOWED_EXTERNAL_HOST = "cdnjs.cloudflare.com";
/** Any absolute http(s) URL sitting in a `src="..."` or `href="..."` attribute. Deliberately
 * attribute-scoped rather than a whole-document URL scan — see `checkF7`'s comment on why a
 * whole-document scan over-fires. */
const ATTR_URL = /\b(?:src|href)="(https?:\/\/[^"]+)"/gi;

/** CSS class selectors: `.name`, where `name` starts with `-`, a letter, or `_` and continues
 * with word characters/`-`. That first-character requirement is already what keeps a decimal
 * like `0.5rem`/`1.5em`/`.65` from being misread as a class — `.5` in `0.5rem` can't match
 * because a selector name may not start with a digit — so nothing upstream of the capture
 * group needs to police what precedes the `.` at all.
 *
 * An earlier version of this regex added a `(?<!` lookbehind (`.name` not preceded by a word
 * character) meant to reinforce that same decimal guard. It was redundant for that purpose —
 * the first-character requirement alone already excludes every decimal case — but it had a
 * real, unintended side effect: it also refused to credit the second and later class in a
 * *compound* selector. `.ctrl-btn.start{...}` has `.start` immediately preceded by `n`, a word
 * character, so the lookbehind silently dropped `start` from the defined set even though the
 * planner CSS plainly defines it. Measured on a real sweep's 20 saved documents: 12 of 27
 * total "undefined" offender occurrences were exactly this — a class that only ever appears as
 * the second+ part of a compound selector (`.counter-btn.minus`, `.mode-btn.active`,
 * `.ctrl-btn.start`/`.pause`/`.reset`, `.form-panel.hidden`, etc.) — misread as undefined
 * because of the lookbehind alone, not because the planner failed to define anything. Dropping
 * the lookbehind fixes all of them.
 *
 * Deliberately permissive about what follows the name — combinators, pseudo-classes, attribute
 * selectors, being the second+ class in a compound selector — since the goal is the set of
 * names the planner *declared*, not a full CSS parse. See `checkF8`'s comment for the real
 * limits of this approach. One that remains after this fix: a class name that appears only
 * inside a CSS comment or inside a string literal (e.g. a `content:"..."` value) is still
 * credited as "defined" by this loose a scan, same as before — this under-flags (accepts a
 * class that isn't really a live selector) rather than over-flags, which is the safe direction
 * for a check whose whole purpose is catching *undefined* classes, not extra ones. */
const CSS_CLASS_SELECTOR = /\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g;
/** Matches both quote styles for `class="..."`/`class='...'` — group 1 for double-quoted,
 * group 2 for single-quoted. Only ever run against content already passed through
 * `maskForClassScan`, which is what makes the single-quoted half safe to include (see that
 * function's comment). */
const CLASS_ATTR = /\bclass=(?:"([^"]*)"|'([^']*)')/gi;

/**
 * Blanks out `<script>...</script>` bodies and `<!-- ... -->` comments before F8's
 * `CLASS_ATTR` scan, replacing each with equal-length spaces so nothing downstream needs to
 * know offsets moved. The script half is the same fix, same technique, as `maskScripts` in
 * `packages/protocol/src/slots.ts` (written for the tolerant slot-placeholder matcher) — not
 * imported from there since it isn't exported, so this is a deliberate local duplicate rather
 * than a shared util.
 *
 * Scripts: slot content commonly builds markup by string concatenation
 * (`'<span class="badge ' + cls + '">'`), and without this mask `CLASS_ATTR`'s `[^"]*` runs
 * straight through the JS to the next literal quote, producing a bogus "class list" made of
 * JS tokens (`+`, `'`, a variable name) that can never appear in the CSS — see `checkF8`'s
 * "Known gaps" for the direct consequence of masking.
 *
 * Comments: the same species of false positive, just rarer in practice — a `class="..."`
 * fragment left inside an HTML comment (commented-out markup, or a model's own inline note)
 * is not live content and should not be scored as "used".
 *
 * Masking scripts before comments (rather than matching `<!--...-->` against the raw string)
 * is also what makes it safe to have `CLASS_ATTR` match single-quoted attributes too: the
 * mirror-image false positive — a double-quoted JS string that itself contains a literal
 * `class='...'` fragment (e.g. `html += "<span class='badge'>";`) — lives inside a
 * `<script>` element and is already blanked out by the first pass before the single-quote
 * half of `CLASS_ATTR` ever sees it.
 *
 * The script half falls back to end-of-string when there is no `</script>` at all (`<\/script
 * \s*>|$`), rather than requiring the closing tag and leaving an unterminated script
 * unmasked. This is not just a defensive fallback — it's the textually correct reading: per
 * HTML's own parsing rules an unclosed `<script>` consumes everything to end-of-input, so a
 * truncated fill (a real failure mode on this project — mid-generation timeouts happen) that
 * cuts a slot off partway through its own `<script>` would otherwise leave the tail of that
 * script unmasked and reintroduce exactly the false positive this function exists to remove.
 */
function maskForClassScan(content: string): string {
  const noScripts = content.replace(/<script\b[^>]*>[\s\S]*?(?:<\/script\s*>|$)/gi, (m) => " ".repeat(m.length));
  return noScripts.replace(/<!--[\s\S]*?-->/g, (m) => " ".repeat(m.length));
}

/** Server-owned classes (`SKELETON_CSS` in `packages/protocol/src/slots.ts`) that are always
 * available even though the planner never writes them into its own CSS. A slot referencing
 * `anyapp-slot-error` on purpose (unlikely, but not wrong) should not be flagged as undefined.
 * `hidden` joined this set alongside `SKELETON_CSS`'s own server-owned `.hidden{display:none}`
 * utility (`packages/protocol/src/slots.ts`), which is emitted whenever the planner's own CSS
 * doesn't already define `.hidden` itself — so from this checker's perspective `hidden` is
 * always available, exactly like `anyapp-skeleton`/`anyapp-slot-error`, regardless of whether
 * the planner CSS text happens to contain a `.hidden` rule. This is now belt-and-braces rather
 * than load-bearing for most real cases: once `CSS_CLASS_SELECTOR`'s lookbehind bug was fixed
 * (see that regex's comment), the one saved generation that used `hidden` turned out to define
 * `.form-panel.hidden` itself as a compound selector — the checker just couldn't see it before.
 * `hidden` stays in this set regardless, for the apps that genuinely rely on the server utility
 * and never define `.hidden` in their own CSS at all. */
const ALWAYS_DEFINED_CLASSES = new Set(["anyapp-skeleton", "anyapp-slot-error", "hidden"]);

/** F1: no `<style>` element in any slot's filled content — the coherence rule (CSS belongs
 * only to the planner's single stylesheet; a slot writing its own means the fan-out or the
 * sequential fill call broke that rule). */
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
 * F3: "emits a section for every slot in the plan, in order."
 *
 * Split into two independently-scored halves, because the spec's "in order" only means one
 * thing under sequential fill (Phase 3.5: one completion writes `===SLOT id===` sections
 * itself, and the model is told to emit them in the given order) and means something
 * different — arguably nothing — under parallel fill (Phase 4: each slot is its own isolated
 * call with no header at all, and slots are expected to *complete* out of order; that is the
 * feature, not a defect. `renderDocument` always re-serialises in plan order regardless of
 * mode, so the *persisted* document can never answer the ordering question either way — only
 * the raw bytes actually written to the wire during generation can, which is why this needs
 * `rawStreamBody` rather than `plan`/`document` alone.
 *
 *   - coverage: every plan slot has non-empty, non-placeholder content. Applies to both
 *     modes — this is the "for every slot" half.
 *   - order: only scored under sequential mode, by extracting the `swap("id")` call sequence
 *     from the live stream and comparing it to plan order. Skipped (not failed) under
 *     parallel mode, since out-of-order completion there is correct behaviour, not a quality
 *     signal — scoring it would just be measuring how the scheduler happened to interleave
 *     five HTTP calls.
 *
 * Overall F3 passes only when both apply and both hold — a generation with full coverage but
 * scrambled sequential order is still a real F3 failure (a model that ignored "emit every
 * requested region, in order" from `fill-prompt.ts`).
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

/** F4: plan output parses without a `PlanError`. Approximated as "a structured `FilledApp`
 * plan is present at all" — if `parsePlan` threw, `internal.ts` falls back to the Phase 1
 * linear path (`markComplete`, no `plan` column), so the *absence* of a valid plan on a
 * `complete` row is the only externally-observable trace of a `PlanError` this sweep has
 * access to (it does not import `packages/generator` to call `parsePlan` directly — that
 * would test parsing against text this sweep already has, not against what actually shipped). */
function checkF4(planRaw: unknown): CheckResult {
  return ok("F4", "Plan output parses without a PlanError", isFilledApp(planRaw));
}

/** F5: slot count between 2 and 6 (inclusive), per `PLANNER_PROMPT`'s "use between 2 and 6
 * slots." */
function checkF5(plan: FilledApp): CheckResult {
  const n = plan.slots.length;
  return ok("F5", "Slot count is between 2 and 6", n >= 2 && n <= 6, `slot count: ${n}`);
}

/** F6: every placeholder matches the exact required shape. Scans the raw `shell` text (not
 * the parsed `slots` array — a placeholder that failed the strict shape was never turned into
 * a `SlotSpec` at all, so checking only the parsed output could never find one) for anything
 * that looks like an attempted placeholder, then requires each candidate to match the strict
 * shape exactly. A candidate that is itself just the strict shape trivially passes; the check
 * exists for the ones that don't (an added attribute, inner whitespace, a self-closing form,
 * a non-lowercase id). */
function checkF6(plan: FilledApp): CheckResult {
  const candidates = plan.shell.match(NEAR_MISS_PLACEHOLDER) ?? [];
  const offenders = candidates.filter((c) => !EXACT_PLACEHOLDER.test(c));
  return ok(
    "F6",
    "Every placeholder matches the exact required shape",
    offenders.length === 0,
    offenders.length ? `near-miss placeholder(s): ${offenders.slice(0, 5).join(" | ")}` : undefined,
  );
}

/**
 * F7: external references only from cdnjs.cloudflare.com. Scoped to `src="..."`/`href="..."`
 * attribute values (real load-bearing references) rather than every `https://` substring in
 * the document — a generated app is free to *mention* another URL as visible text (a weather
 * widget's placeholder data crediting "data via example.com", say) without that being a
 * "reference" in the sense this case means. That scoping is also the known gap: an inline
 * `fetch("https://...")` inside a slot's own `<script>` is neither a `src` nor an `href` and
 * would not be caught here, even though it is exactly the kind of external reference this
 * case exists to forbid. Runs over the whole persisted `document`, per the spec ("any
 * generated document"), independent of whether the plan parsed — this is the one F case still
 * meaningful on a linear-fallback document.
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
 * F8: "Class names used in slot content" are "Defined in the planner CSS — catches the
 * 'content appears unstyled' failure before a human sees it" (`.docs/tests-backend.md`).
 *
 * **Scored at element granularity, not token granularity.** An element (one `class="..."`/
 * `class='...'` attribute) fails F8 only when *none* of its class tokens is defined in the
 * planner CSS (counting `ALWAYS_DEFINED_CLASSES`) — i.e. only when the element is provably
 * unstyled by the planner's stylesheet. An element with at least one defined class token does
 * not fail F8, no matter what else rides along on the same attribute.
 *
 * This was deliberately narrowed from an earlier token-level version that failed a slot if
 * *any* class token anywhere was undefined, regardless of whether the element carrying it also
 * had a defined class. That broader reading does not match the spec's own stated purpose: an
 * element carrying one class the planner CSS genuinely never defines anywhere — e.g.
 * `class="tab js-tab-hook"` where `js-tab-hook` is purely a JS selector hook
 * (`document.querySelector('.js-tab-hook')`) and never appears in the CSS, compound selector or
 * otherwise — is still a *styled* element (`tab` is defined), and nothing about it "appears
 * unstyled" to a human looking at it. Scoring that as an F8 failure was flagging exactly the
 * case the spec's own justification says F8 is not about. The genuine "content appears
 * unstyled" defect — an element with *no* defined class at all (`class="stat-value"` where
 * `stat-value` is never in the planner CSS, in any form) — still fails F8 under this
 * element-level reading, unchanged. Token-level undefined modifiers did not disappear: they
 * moved to `F8_MODIFIER_DIAGNOSTIC_ID` below, which is informational and explicitly not part of
 * this pass rate — see that function's comment for why they're still worth tracking in
 * principle, and for what actually remains in that bucket once `CSS_CLASS_SELECTOR`'s own bug
 * (below) is accounted for.
 *
 * Worth being honest about the history here: the motivating real-world examples first used to
 * justify this narrowing (`class="counter-btn minus"`, `class="mode-btn active"`, and similar,
 * from a real sweep's 20 saved documents) turned out to be a *different* bug, not evidence for
 * this one. `CSS_CLASS_SELECTOR` used to carry a lookbehind that silently failed to credit the
 * second and later class in a compound selector (`.counter-btn.minus{}` never registered
 * `minus` as defined) — so `minus`/`active`/`start`/etc. in those examples were always actually
 * defined, just invisible to the buggy scan. See that regex's comment for the fix and the
 * measurement. The element-vs-token distinction this function makes is still the correct
 * reading of the spec on its own terms (a class that is *never* defined, compound or otherwise,
 * really is just a selector hook on an otherwise-styled element) — it just turns out to matter
 * far less often in practice than the original (buggy-regex-driven) analysis suggested, once the
 * regex bug that was inflating the "used but undefined" set is fixed.
 *
 * To be unmistakable: this narrowing is an alignment with the spec's stated purpose, not a
 * relaxation to make the number look better. It changes which failures F8 *counts*, not
 * whether the underlying "no defined class" defect is detected — that defect still fails F8
 * exactly as before. What no longer fails is a case the spec's own justification never
 * described as a defect in the first place.
 *
 * Extracts class *selectors* from `plan.css` via a permissive regex (not a real CSS parser —
 * see `CSS_CLASS_SELECTOR`'s comment) and class *usages* from each slot's static
 * `class="..."`/`class='...'` attributes (after masking out `<script>` bodies and `<!-- -->`
 * comments — see `maskForClassScan`), via the shared `scanClassAttrUsages` helper below.
 *
 * Known gaps, worth being explicit about rather than implying coverage this does not have:
 *   - Only static `class="..."`/`class='...'` attributes present in the initial HTML are
 *     checked. A class added later via `classList.add(...)` in a slot's own `<script>` —
 *     extremely common for "active"/"selected"/"open" style toggling in exactly the
 *     interactive apps this sweep asks for — is invisible to a string-level check and is not
 *     counted as "used" either way. A true measurement needs the rendered DOM's class list at
 *     various interaction states, which is out of scope for a doc-level check (the frontend
 *     checks in `checks-rendered.ts` never assert on class names at all).
 *   - Relatedly, a class name that exists only *inside* a slot's own `<script>` — built up by
 *     string concatenation or template literals into markup the script injects at runtime
 *     (`html += '<span class="badge ' + cls + '">'`) — is deliberately not counted as "used"
 *     either, now that script bodies are masked out before the scan. Before this mask existed
 *     that pattern was scored as used-but-undefined almost every time (the regex ran off the
 *     end of the JS string into the next literal quote, producing a "class list" made of JS
 *     tokens like `+`/`'`/a variable name — never real class names, and never a real failure).
 *     Masking trades that reliable false positive for a rarer false negative: a script that
 *     builds a *genuinely* undefined class name into markup at runtime is now silently not
 *     checked in either direction, the same blind spot `classList.add(...)` already has.
 *   - Content inside an HTML comment is masked the same way and for the same reason — a
 *     `class="..."` fragment sitting in commented-out markup is not live content and is
 *     simply not counted as "used", either direction.
 *   - The CSS selector regex does not understand nesting, `@media` blocks, or that a class
 *     mentioned only inside a *CSS* comment still counts as "defined" by this loose a scan
 *     (this is about `plan.css`, a separate scan from the slot-content masking above). It will
 *     under-flag (accept a class that only appears in a dead comment) far more often than it
 *     over-flags.
 *   - Utility classes the model invents but never uses anywhere are not checked at all — this
 *     case only ever fires in the "used but never defined" direction, which is the direction
 *     that actually causes the "content appears unstyled" symptom the case exists to catch.
 *   - An element with an empty `class=""` attribute (zero tokens) is not scored either way —
 *     there is nothing to judge "defined" or "undefined", and it was never scored before this
 *     narrowing either.
 */

/** One `class="..."`/`class='...'` attribute occurrence found in a slot's (masked) content,
 * plus how its tokens resolved against the planner's defined-class set. Shared by `checkF8`
 * and the modifier diagnostic below so the CSS/content scan only happens once per plan. */
interface ClassAttrUsage {
  slotId: string;
  /** The full matched attribute text, e.g. `class="stat-value positive"` — kept verbatim
   * (not just the token list) because a bare token list stopped being enough to convey the
   * finding once the check moved from token-level to element-level: naming the whole
   * attribute is what lets a reader see the element's full class list, not just its
   * undefined pieces. */
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

/**
 * Id for the non-spec diagnostic split out of F8's old token-level behavior (see `checkF8`'s
 * comment above for the full rationale). Deliberately shaped nothing like `F<n>` — it must
 * never be mistaken for one of the spec's F1-F8 cases by anyone scanning ids in a table or in
 * `report.ts`'s `DOC_CASE_IDS`. It is *not* added to `DOC_CASE_IDS`: that list is what drives
 * the spec pass-rate table and the attemptError fallback in `report.ts`, and this diagnostic is
 * reported separately there, on purpose.
 */
export const F8_MODIFIER_DIAGNOSTIC_ID = "DIAG:undefined-modifier";

/**
 * Non-spec diagnostic: an element that *passes* F8 (it has at least one defined class) but
 * also carries at least one undefined "modifier" token on the same attribute — e.g.
 * `class="tab js-tab-hook"` where `tab` is defined and `js-tab-hook` never appears in the
 * planner CSS in any form, compound selector included. This is deliberately never folded into
 * F8's own pass/fail — the spec's "content appears unstyled" justification does not describe
 * this as a defect, and F8 above no longer scores it.
 *
 * In principle it is still worth tracking on its own: an undefined modifier *could* be a
 * state-toggle class (`.active`, `.selected`, `.open`) that the model's own script adds via
 * `classList.add(...)` at runtime, expecting the planner CSS to style that state, where the
 * planner CSS simply never defined it. `.active` on a tab that never visually looks selected
 * would be a real, if milder, defect than "unstyled" — the element renders fine at rest, but a
 * state change a user triggers has no visible effect.
 *
 * In practice, on the one real sweep measured so far (20 saved documents), this bucket fires on
 * **nothing at all** once `CSS_CLASS_SELECTOR`'s compound-selector bug is fixed (see that
 * regex's comment) — every real "undefined modifier" this project has seen so far
 * (`counter-btn minus`, `mode-btn active`, `ctrl-btn start`/`pause`/`reset`, `note-item active`,
 * `form-panel hidden`) was the planner defining the modifier as a compound selector
 * (`.counter-btn.minus{}`), which the fixed regex now credits correctly. That is a genuinely
 * good result, not a sign this diagnostic has nothing to check — a real "state-toggle class the
 * planner forgot to style" defect would still show up here if a model ever produced one; this
 * project's models simply have not, so far, on this prompt set. See `checks-doc.ts`'s handling
 * in `runDocChecks`/`report.ts`'s dedicated diagnostics table for how it stays visible (an
 * always-100%-pass row, not silently dropped) rather than disappearing from the report.
 *
 * Never let this move the spec's F8 pass rate. Report it as its own line, clearly marked as a
 * diagnostic — see `report.ts`'s handling of `F8_MODIFIER_DIAGNOSTIC_ID` for how it stays out
 * of the F1-F8 table.
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
 * Runs the whole of section F over one generation. `rawStreamBody` is the literal bytes this
 * sweep received while driving the generation (see `runner.ts`) — used only by F3's order
 * half. `fillMode` is the `LLM_FILL_MODE` the server that produced this row was started with.
 */
export function runDocChecks(row: GenerationRow, rawStreamBody: string, fillMode: string): CheckResult[] {
  const results: CheckResult[] = [];

  if (row.status !== "complete" || !row.document) {
    // A generation that never completed has nothing to check but F7, and even that only if
    // some document text exists at all (a fully-failed generation can still have a partial
    // shell written before the failure — internal.ts writes the shell before fill runs).
    const reason = `generation did not complete (status: ${row.status}${row.error ? `, error: ${row.error}` : ""})`;
    for (const id of ["F1", "F2", "F3", "F4", "F5", "F6", "F8"]) results.push(skip(id, id, reason));
    results.push(skip(F8_MODIFIER_DIAGNOSTIC_ID, F8_MODIFIER_DIAGNOSTIC_ID, reason));
    results.push(
      row.document ? checkF7(row.document) : skip("F7", "F7", reason),
    );
    return results;
  }

  results.push(checkF4(row.plan));
  results.push(checkF7(row.document));

  if (!isFilledApp(row.plan)) {
    const reason = "no structured plan persisted — parsePlan likely threw (PlanError), row went through the linear fallback";
    for (const id of ["F1", "F2", "F3", "F5", "F6", "F8"]) results.push(skip(id, id, reason));
    results.push(skip(F8_MODIFIER_DIAGNOSTIC_ID, F8_MODIFIER_DIAGNOSTIC_ID, reason));
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
  const defined = new Set<string>();
  for (const m of plan.css.matchAll(CSS_CLASS_SELECTOR)) defined.add(m[1]!);
  const usages = scanClassAttrUsages(plan, defined);
  results.push(checkF8(usages));
  results.push(checkF8ModifierDiagnostic(usages));

  return results;
}
