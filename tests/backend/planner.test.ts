/**
 * A4 — parsePlan.
 * Spec: .docs/tests-backend.md section A4. Target: packages/generator/src/planner.ts.
 *
 * `parsePlan` was module-private (no `export`) and unreachable from any import path — see
 * S4 in .docs/testing-review.md. Fixed by adding `export`; visibility only, no behaviour
 * change. These cases were already hand-verified against `parsePlan`'s actual behaviour via
 * a throwaway probe when they were written skipped, so uncommenting them is not a guess —
 * confirmed green against the fix below.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan } from "../../packages/generator/src/planner";
import { PlanError } from "../../packages/generator/src/planner";
import type { PlanDiagnostic } from "../../packages/generator/src/planner";

test("A4.1 — well-formed plan: AppPlan with slots in shell order, not SLOTS order", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="b"></div><div data-slot="a"></div>\n' +
    "===SLOTS===\na|200|First\nb|300|Second\n";
  const plan = parsePlan(raw);
  assert.deepEqual(plan.slots.map((s) => s.id), ["b", "a"]); // shell order, not SLOTS order
});

test("A4.2 — slot in SHELL missing from SLOTS: included with default height 200 and a default spec", () => {
  // Mirrors A4.3 exactly (one slot too many there, one slot too few here) rather than an
  // entirely-empty SLOTS section — see testing-review.md S5 for why: a totally-empty SLOTS
  // body is indistinguishable from a response truncated right after the marker, and a
  // fixture that happens to trigger that reading is not what this case is meant to cover.
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"></div><div data-slot="b"></div>\n===SLOTS===\na|300|Spec for A\n';
  const plan = parsePlan(raw);
  assert.deepEqual(plan.slots, [
    { id: "a", height: 300, spec: "Spec for A" },
    { id: "b", height: 200, spec: "Content for this region." },
  ]);
});

test("A4.3 — slot in SLOTS missing from SHELL: dropped, the shell is the source of truth", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"></div>\n===SLOTS===\na|200|A\nb|200|B\n';
  const plan = parsePlan(raw);
  assert.deepEqual(plan.slots.map((s) => s.id), ["a"]); // "b" never rendered, so dropped
});

test('A4.4 — invalid slot id ("Timer", "1x", 40 chars): skipped, no throw', () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="foo"></div>\n===SLOTS===\n' +
    "Timer|200|Bad\n1x|200|Bad\n" + "a".repeat(40) + "|200|Bad\nfoo|300|Good\n";
  const plan = parsePlan(raw); // must not throw
  assert.deepEqual(plan.slots, [{ id: "foo", height: 300, spec: "Good" }]);
});

test("A4.5 — height abc / 5 / 99999: becomes 200 / clamped to 40 / clamped to 2000", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"></div><div data-slot="b"></div><div data-slot="c"></div>\n' +
    "===SLOTS===\na|abc|A\nb|5|B\nc|99999|C\n";
  const plan = parsePlan(raw);
  const byId = Object.fromEntries(plan.slots.map((s) => [s.id, s.height]));
  assert.deepEqual(byId, { a: 200, b: 40, c: 2000 });
});

test("A4.6 — TITLE or CSS missing: PlanError naming the sections it did find", () => {
  const raw = '===SHELL===\n<div data-slot="a"></div>\n===SLOTS===\na|200|A\n';
  assert.throws(() => parsePlan(raw), (err: unknown) => {
    return err instanceof PlanError && /SHELL/.test(err.message) && /SLOTS/.test(err.message);
  });
});

test("A4.7 — shell with zero placeholders: PlanError", () => {
  const raw = "===TITLE===\nMy App\n===CSS===\nbody{}\n===SHELL===\n<div>no slots here</div>\n===SLOTS===\n";
  assert.throws(() => parsePlan(raw), PlanError);
});

test("A4.7b — placeholder with a styling class (the real-world shape that used to be missed entirely): parses fine", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div class="panel" data-slot="chart"></div>\n===SLOTS===\nchart|200|Chart\n';
  const plan = parsePlan(raw); // must not throw — this is exactly the case the fix targets
  assert.deepEqual(plan.slots.map((s) => s.id), ["chart"]);
});

test("A4.7c — non-div placeholder (<span>) parses fine", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<span data-slot="last-updated"></span>\n===SLOTS===\nlast-updated|20|Timestamp\n';
  const plan = parsePlan(raw);
  assert.deepEqual(plan.slots.map((s) => s.id), ["last-updated"]);
});

test("A4.7d — a data-slot element with real content inside it: sanitized and kept, NOT rejected (deterministic safety net)", () => {
  // REVERSAL, deliberate: this used to be guard 3's PlanError case — the tolerant scan
  // correctly does not match this as a complete placeholder, but rejecting the whole plan
  // over it discarded the entire shell/slots architecture for content that was always going
  // to be overwritten by the fill call anyway. sanitizePlaceholders (slots.ts) now strips
  // "<p>x</p>" deterministically before the unmatched-attribute check runs, so this parses
  // fine — see slots.ts's doc comment on sanitizePlaceholders for the full argument, and
  // A4.15/A4.16 below for the narrower cases that must still throw.
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"></div><div data-slot="chart"><p>x</p></div>\n===SLOTS===\na|200|A\nchart|200|Chart\n';
  const plan = parsePlan(raw); // must NOT throw
  assert.deepEqual(plan.slots.map((s) => s.id), ["a", "chart"]);
  assert.ok(!plan.shell.includes("<p>x</p>"), "the stripped content must not survive into the returned plan");
  assert.ok(plan.shell.includes('<div data-slot="chart"></div>'), "the element itself is kept, just emptied");
});

test("A4.13 — parsePlan returns the SANITIZED shell, not the raw one, when content was stripped", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a" class="card">stale content</div>\n===SLOTS===\na|200|A\n';
  const plan = parsePlan(raw);
  assert.equal(plan.shell, '<div data-slot="a" class="card"></div>');
});

test("A4.14 — onDiagnostic fires with the right id and removed text when content is stripped", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="chart">Loading chart...</div>\n===SLOTS===\nchart|200|Chart\n';
  const diagnostics: PlanDiagnostic[] = [];
  parsePlan(raw, (d) => diagnostics.push(d));
  assert.deepEqual(diagnostics, [
    { kind: "stripped-placeholder-content", id: "chart", removed: "Loading chart..." },
  ]);
});

test("A4.14b — onDiagnostic omitted: parsePlan behaves exactly as with a callback, minus the call (no throw)", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a">x</div>\n===SLOTS===\na|200|A\n';
  const plan = parsePlan(raw); // no second argument at all — must not throw
  assert.equal(plan.shell, '<div data-slot="a"></div>');
});

test("A4.15 — nested data-slot element inside content: PlanError survives (a different, worse problem than guard 3)", () => {
  // The stripper deliberately refuses to touch this case (slots.ts's sanitizePlaceholders
  // doc comment) — silently deleting the outer element would also delete the distinct "b"
  // region nested inside it, which is not something the fill call was ever going to
  // overwrite back into existence. Must keep failing loudly.
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"><div data-slot="b"></div>text</div>\n===SLOTS===\na|200|A\nb|200|B\n';
  assert.throws(
    () => parsePlan(raw),
    (err: unknown) => err instanceof PlanError && /a/.test(err.message),
  );
});

test("A4.16 — unterminated data-slot element (no matching close tag before end of input): PlanError survives", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a">no closing tag here\n===SLOTS===\na|200|A\n';
  assert.throws(() => parsePlan(raw), PlanError);
});

test("A4.8 — whole response wrapped in a code fence: parsed anyway", () => {
  const raw =
    "```\n===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"></div>\n===SLOTS===\na|200|A\n```';
  const plan = parsePlan(raw);
  assert.equal(plan.title, "My App");
});

test("A4.9 — spec text containing a |: preserved, the split rejoins the tail", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"></div>\n===SLOTS===\na|200|Do this | and that\n';
  const plan = parsePlan(raw);
  assert.equal(plan.slots[0]?.spec, "Do this | and that");
});

test("A4.10 — no DATA section at all (P5): collections is [], no throw", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"></div>\n===SLOTS===\na|200|A\n';
  const plan = parsePlan(raw); // must not throw — DATA is optional, this is the common case
  assert.deepEqual(plan.collections, []);
});

test("A4.11 — DATA with one valid line (P5): one collection, name and description split on the first |", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"></div>\n===SLOTS===\na|200|A\n' +
    "===DATA===\ntodos|A list of todo items with a | in the description\n";
  const plan = parsePlan(raw);
  assert.deepEqual(plan.collections, [
    { name: "todos", description: "A list of todo items with a | in the description" },
  ]);
});

test("A4.12 — DATA with an invalid collection name (P5): that line skipped, the rest kept", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"></div>\n===SLOTS===\na|200|A\n' +
    "===DATA===\nBad-Name|invalid\ntodos|valid one\n";
  const plan = parsePlan(raw);
  assert.deepEqual(plan.collections, [{ name: "todos", description: "valid one" }]);
});

// Sanity check on shared regexes actually reachable without the blocked import, so this
// file is not *purely* documentation: SLOT_ID_PATTERN and COLLECTION_PATTERN are exported
// from @any-app/protocol and are exactly what would make A4.4/A4.11/A4.12 pass or fail
// inside parsePlan's own validation. This does not substitute for testing parsePlan itself
// (the orchestration — defaulting, clamping, dedupe, PlanError-throwing — lives entirely
// inside the unreachable function body) but it does confirm the underlying validation the
// spec's examples rely on behaves as assumed above.
test("A4 sanity — SLOT_ID_PATTERN / COLLECTION_PATTERN reject the ids the skipped cases assume they reject", async () => {
  const { SLOT_ID_PATTERN, COLLECTION_PATTERN } = await import("@any-app/protocol");
  assert.equal(SLOT_ID_PATTERN.test("Timer"), false);
  assert.equal(SLOT_ID_PATTERN.test("1x"), false);
  assert.equal(SLOT_ID_PATTERN.test("a".repeat(40)), false);
  assert.equal(SLOT_ID_PATTERN.test("foo"), true);
  assert.equal(COLLECTION_PATTERN.test("Bad-Name"), false);
  assert.equal(COLLECTION_PATTERN.test("todos"), true);
});
