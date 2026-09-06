/**
 * A5 — renderSkeletons / renderDocument / slotIdsInShell.
 * Spec: .docs/tests-backend.md section A5. Target: packages/protocol/src/slots.ts.
 *
 * All of these are exported directly from @any-app/protocol.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSkeletons, renderDocument, slotIdsInShell } from "@any-app/protocol";
import type { FilledApp } from "@any-app/protocol";
import { parsePlan, PlanError } from "../../packages/generator/src/planner";

test("A5.1 — exact placeholder replaced with a sized skeleton div", () => {
  const out = renderSkeletons('<div data-slot="foo"></div>', [{ id: "foo", height: 300, spec: "x" }]);
  // S12: `data-slot` is kept on the rendered element (alongside `id="slot-foo"`) so a model
  // that queries `[data-slot="foo"]` from its own script still finds the live element —
  // swap()/fill() only ever replace this element's children, never the element itself.
  assert.equal(
    out,
    '<div id="slot-foo" data-slot="foo" class="anyapp-skeleton" style="min-height:300px"></div>',
  );
});

test("A5.2 — placeholder with an extra attribute is matched, and the attribute is kept (not discarded)", () => {
  // Was "NOT replaced (deliberate strictness)" under the old byte-exact regex — that
  // strictness is exactly what a real 28%-of-generations failure mode traced back to (see
  // open-problems.md's "Phase 6 pre-flight"). The tolerant scan matches this, and the model's
  // own `class="extra"` (its styling hook) is preserved, not discarded, on the rendered element.
  const shell = '<div data-slot="foo" class="extra"></div>';
  const out = renderSkeletons(shell, [{ id: "foo", height: 300, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-foo" data-slot="foo" class="extra anyapp-skeleton" style="min-height:300px"></div>',
  );
});

test("A5.2b — class attribute before data-slot is kept and merged", () => {
  const shell = '<div class="panel" data-slot="chart"></div>';
  const out = renderSkeletons(shell, [{ id: "chart", height: 240, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-chart" data-slot="chart" class="panel anyapp-skeleton" style="min-height:240px"></div>',
  );
});

test("A5.2c — non-div tag (span) is matched and its tag preserved", () => {
  const shell = '<span data-slot="last-updated"></span>';
  const out = renderSkeletons(shell, [{ id: "last-updated", height: 20, spec: "x" }]);
  assert.equal(
    out,
    '<span id="slot-last-updated" data-slot="last-updated" class="anyapp-skeleton" style="min-height:20px"></span>',
  );
});

test("A5.2d — single-quoted data-slot attribute is matched", () => {
  const shell = "<div data-slot='chart'></div>";
  const out = renderSkeletons(shell, [{ id: "chart", height: 100, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-chart" data-slot="chart" class="anyapp-skeleton" style="min-height:100px"></div>',
  );
});

test("A5.2e — self-closing placeholder is matched", () => {
  const shell = '<div data-slot="chart"/>';
  const out = renderSkeletons(shell, [{ id: "chart", height: 100, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-chart" data-slot="chart" class="anyapp-skeleton" style="min-height:100px"></div>',
  );
});

test("A5.2f — whitespace-only body is matched (counts as empty)", () => {
  const shell = '<div data-slot="chart">   \n  </div>';
  const out = renderSkeletons(shell, [{ id: "chart", height: 100, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-chart" data-slot="chart" class="anyapp-skeleton" style="min-height:100px"></div>',
  );
});

test("A5.2g — uppercase tag and attribute name are matched, id extracted correctly", () => {
  const shell = '<DIV DATA-SLOT="chart"></DIV>';
  const out = renderSkeletons(shell, [{ id: "chart", height: 100, spec: "x" }]);
  assert.equal(
    out,
    '<DIV id="slot-chart" data-slot="chart" class="anyapp-skeleton" style="min-height:100px"></DIV>',
  );
});

test("A5.2h — existing style attribute is merged with min-height, not clobbered", () => {
  const shell = '<div data-slot="chart" style="border:1px solid red"></div>';
  const out = renderSkeletons(shell, [{ id: "chart", height: 100, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-chart" data-slot="chart" class="anyapp-skeleton" style="border:1px solid red; min-height:100px"></div>',
  );
});

test("A5.2i — real (non-whitespace) content inside the element is NOT matched — genuinely ambiguous", () => {
  const shell = '<div data-slot="chart"><p>placeholder</p></div>';
  const out = renderSkeletons(shell, [{ id: "chart", height: 100, spec: "x" }]);
  assert.equal(out, shell);
  assert.deepEqual(slotIdsInShell(shell), []);
});

test("A5.2j — markup inside a <script> is never treated as a placeholder", () => {
  const shell = '<script>el.innerHTML = \'<div data-slot="x"></div>\';</script>';
  assert.deepEqual(slotIdsInShell(shell), []);
  assert.equal(renderSkeletons(shell, [{ id: "x", height: 100, spec: "s" }]), shell);
});

test("A5.2k — our own rendered output is never re-matched (idempotency guard)", () => {
  const rendered =
    '<div id="slot-chart" data-slot="chart" class="anyapp-skeleton" style="min-height:100px"></div>';
  assert.deepEqual(slotIdsInShell(rendered), []);
  assert.equal(renderSkeletons(rendered, [{ id: "chart", height: 100, spec: "x" }]), rendered);
});

test("A5.2l — idempotency: slotIdsInShell(renderSkeletons(shell, slots)) is always []", () => {
  const shells = [
    '<div data-slot="foo"></div>',
    '<div class="panel" data-slot="chart"></div>',
    '<span data-slot="last-updated"></span>',
    "<div data-slot='single'></div>",
    '<div data-slot="selfclose"/>',
  ];
  const slots = [
    { id: "foo", height: 300, spec: "x" },
    { id: "chart", height: 240, spec: "x" },
    { id: "last-updated", height: 20, spec: "x" },
    { id: "single", height: 100, spec: "x" },
    { id: "selfclose", height: 100, spec: "x" },
  ];
  for (let i = 0; i < shells.length; i++) {
    const rendered = renderSkeletons(shells[i]!, [slots[i]!]);
    assert.deepEqual(slotIdsInShell(rendered), [], `not idempotent for: ${shells[i]}`);
  }
});

test("A5.3 — placeholder for an id absent from the spec list: rendered with height 0, no throw", () => {
  const out = renderSkeletons('<div data-slot="bar"></div>', []);
  assert.equal(
    out,
    '<div id="slot-bar" data-slot="bar" class="anyapp-skeleton" style="min-height:0px"></div>',
  );
});

test("A5.4 — renderDocument with content missing for a slot: empty template, no undefined in output", () => {
  const filled: FilledApp = {
    title: "t",
    css: "",
    shell: "",
    script: "",
    slots: [{ id: "x", height: 200, spec: "s" }],
    content: {},
    collections: [],
  };
  const doc = renderDocument(filled, () => "<head></head>", "</body>");
  assert.equal(doc, '<head></head><template id="c-x"></template><script>swap("x")</script>\n</body>');
  assert.equal(doc.includes("undefined"), false);
});

test("A5.5 — slotIdsInShell returns ids in document order", () => {
  const ids = slotIdsInShell('<div data-slot="b"></div><div data-slot="a"></div>');
  assert.deepEqual(ids, ["b", "a"]);
});

test("A5.6 — duplicate slot id in shell: parsePlan throws PlanError naming the repeated id", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a"></div><div data-slot="a"></div>\n===SLOTS===\na|200|A\n';
  assert.throws(() => parsePlan(raw), (err: unknown) => err instanceof PlanError && /a/.test(err.message));
});

test("A5.7 — renderDocument emits slots in plan order (P4), even when content was populated in completion order", () => {
  const filled: FilledApp = {
    title: "t",
    css: "",
    shell: "",
    script: "",
    slots: [
      { id: "b", height: 200, spec: "s" },
      { id: "a", height: 200, spec: "s" },
    ],
    // Inserted in the OPPOSITE order to `slots` — as parallel fill's completion order would.
    content: { a: "A-content", b: "B-content" },
    collections: [],
  };
  const doc = renderDocument(filled, () => "", "");
  // Plan order (b, then a) wins over content's insertion/completion order.
  assert.ok(doc.indexOf('id="c-b"') < doc.indexOf('id="c-a"'));
  assert.ok(doc.indexOf("B-content") < doc.indexOf("A-content"));
});
