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

/** CSS class selectors: `.name` not immediately preceded by a word character (so `0.5` in a
 * numeric value is never mistaken for a class) and not followed by a digit-starting run
 * (decimals). Deliberately permissive about what follows — combinators, pseudo-classes,
 * attribute selectors — since the goal is the set of names the planner *declared*, not a full
 * CSS parse. See `checkF8`'s comment for the real limits of this approach. */
const CSS_CLASS_SELECTOR = /(?<![\w.])\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g;
const CLASS_ATTR = /\bclass="([^"]*)"/gi;

/** Server-owned classes (`SKELETON_CSS` in `packages/protocol/src/slots.ts`) that are always
 * available even though the planner never writes them into its own CSS. A slot referencing
 * `anyapp-slot-error` on purpose (unlikely, but not wrong) should not be flagged as undefined. */
const ALWAYS_DEFINED_CLASSES = new Set(["anyapp-skeleton", "anyapp-slot-error"]);

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
 * F8: class names used in slot content are defined in the planner CSS. Extracts class
 * *selectors* from `plan.css` via a permissive regex (not a real CSS parser — see
 * `CSS_CLASS_SELECTOR`'s comment) and class *usages* from each slot's static `class="..."`
 * attributes, then checks the used set is a subset of the defined set (plus the two
 * server-owned skeleton/error classes, which are legitimately always available).
 *
 * Known gaps, worth being explicit about rather than implying coverage this does not have:
 *   - Only static `class="..."` attributes present in the initial HTML are checked. A class
 *     added later via `classList.add(...)` in a slot's own `<script>` — extremely common for
 *     "active"/"selected"/"open" style toggling in exactly the interactive apps this sweep
 *     asks for — is invisible to a string-level check and is not counted as "used" either way.
 *     A true measurement needs the rendered DOM's class list at various interaction states,
 *     which is out of scope for a doc-level check (the frontend checks in `checks-rendered.ts`
 *     never assert on class names at all).
 *   - The CSS selector regex does not understand nesting, `@media` blocks, or that a class
 *     mentioned only inside a comment still counts as "defined" by this loose a scan. It will
 *     under-flag (accept a class that only appears in a dead comment) far more often than it
 *     over-flags.
 *   - Utility classes the model invents but never uses anywhere are not checked at all — this
 *     case only ever fires in the "used but never defined" direction, which is the direction
 *     that actually causes the "content appears unstyled" symptom the case exists to catch.
 */
function checkF8(plan: FilledApp): CheckResult {
  const defined = new Set<string>();
  for (const m of plan.css.matchAll(CSS_CLASS_SELECTOR)) defined.add(m[1]!);

  const offendersBySlot = new Map<string, Set<string>>();
  for (const slot of plan.slots) {
    const content = plan.content[slot.id] ?? "";
    const used = new Set<string>();
    for (const m of content.matchAll(CLASS_ATTR)) {
      for (const cls of m[1]!.split(/\s+/).filter(Boolean)) used.add(cls);
    }
    const missing = [...used].filter((c) => !defined.has(c) && !ALWAYS_DEFINED_CLASSES.has(c));
    if (missing.length) offendersBySlot.set(slot.id, new Set(missing));
  }

  const pass = offendersBySlot.size === 0;
  const detail = pass
    ? undefined
    : [...offendersBySlot.entries()].map(([id, cls]) => `${id}: ${[...cls].join(",")}`).join(" | ");
  return ok("F8", "Class names used in slot content are defined in the planner CSS", pass, detail);
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
    return results;
  }

  const plan = row.plan;
  results.push(checkF1(plan));
  results.push(checkF2(plan));
  results.push(checkF3(plan, rawStreamBody, fillMode));
  results.push(checkF5(plan));
  results.push(checkF6(plan));
  results.push(checkF8(plan));
  return results;
}
