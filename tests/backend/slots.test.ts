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

test("A5.2 — placeholder with an extra attribute is NOT replaced (deliberate strictness)", () => {
  const shell = '<div data-slot="foo" class="extra"></div>';
  const out = renderSkeletons(shell, [{ id: "foo", height: 300, spec: "x" }]);
  // Locks in the deliberate strictness the spec calls out: PLACEHOLDER only matches the
  // exact `<div data-slot="id"></div>` shape, so an extra attribute leaves it untouched.
  assert.equal(out, shell);
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
