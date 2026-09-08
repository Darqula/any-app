/**
 * A5 — renderSkeletons / renderDocument / slotIdsInShell.
 * Spec: .docs/tests-backend.md section A5. Target: packages/protocol/src/slots.ts.
 *
 * All of these are exported directly from @any-app/protocol.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderSkeletons, renderDocument, slotIdsInShell, utilityCss } from "@any-app/protocol";
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

// ---------------------------------------------------------------------------------------
// Broadened ATTR pattern — valueless/boolean attributes, digits/colons in attribute names,
// and unquoted values. See slots.ts's doc comment on `ATTR`/`GENERIC_ATTR` for the HTML
// syntax being widened to, and CLAUDE.md's "The slot-placeholder scan" note for why this
// stopped being nearly-dead code the moment placeholders were allowed to carry attributes
// (S13, 2026-09-07) — PlanError rose from 10% to 26% specifically because of this gap.
// ---------------------------------------------------------------------------------------

test("A5.2m — valueless/boolean attribute (hidden) is matched and preserved", () => {
  const out = renderSkeletons('<div data-slot="a" hidden></div>', [{ id: "a", height: 50, spec: "x" }]);
  // Boolean attributes are re-emitted with an explicit empty value — `hidden=""` is valid HTML
  // and semantically identical to bare `hidden`; renderSkeletonElement always quotes.
  assert.equal(
    out,
    '<div id="slot-a" data-slot="a" hidden="" class="anyapp-skeleton" style="min-height:50px"></div>',
  );
  assert.deepEqual(slotIdsInShell('<div data-slot="a" hidden></div>'), ["a"]);
});

test("A5.2n — class attribute plus a trailing boolean attribute are both matched and both preserved", () => {
  const shell = '<div data-slot="a" class="x" hidden></div>';
  const out = renderSkeletons(shell, [{ id: "a", height: 50, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-a" data-slot="a" hidden="" class="x anyapp-skeleton" style="min-height:50px"></div>',
  );
});

test("A5.2o — a digit in an attribute name (data-col2) is matched and the attribute preserved", () => {
  const shell = '<div data-slot="a" data-col2="x"></div>';
  const out = renderSkeletons(shell, [{ id: "a", height: 50, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-a" data-slot="a" data-col2="x" class="anyapp-skeleton" style="min-height:50px"></div>',
  );
});

test("A5.2o2 — a colon in an attribute name (xml:lang) is matched and the attribute preserved", () => {
  const shell = '<div data-slot="a" xml:lang="en"></div>';
  const out = renderSkeletons(shell, [{ id: "a", height: 50, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-a" data-slot="a" xml:lang="en" class="anyapp-skeleton" style="min-height:50px"></div>',
  );
});

test("A5.2p — unquoted attribute value (class=x) is matched, and the skeleton merge emits VALID quoted markup", () => {
  // The regression this guards against: naively concatenating an unquoted value into the
  // merged class string must not produce `class=x anyapp-skeleton` (unquoted and broken —
  // the space would end the attribute early, leaving `anyapp-skeleton` as a bogus bare
  // attribute). renderSkeletonElement always re-quotes class/style regardless of how the
  // source value was written, so the output here must be properly double-quoted.
  const shell = "<div data-slot=\"a\" class=x></div>";
  const out = renderSkeletons(shell, [{ id: "a", height: 50, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-a" data-slot="a" class="x anyapp-skeleton" style="min-height:50px"></div>',
  );
  // Sanity: no unquoted `class=` survives anywhere in the output.
  assert.equal(/class=[^"]/.test(out), false);
});

test("A5.2q — unquoted style value merges min-height as valid quoted markup", () => {
  const shell = "<div data-slot=\"a\" style=color:red></div>";
  const out = renderSkeletons(shell, [{ id: "a", height: 50, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-a" data-slot="a" class="anyapp-skeleton" style="color:red; min-height:50px"></div>',
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
    '<div data-slot="hasboolean" hidden></div>',
    '<div data-slot="hasunquoted" class=x></div>',
    '<div data-slot="hasdigit" data-col2="x"></div>',
    '<div data-slot="mixed" class="x" hidden data-col2=y></div>',
  ];
  const slots = [
    { id: "foo", height: 300, spec: "x" },
    { id: "chart", height: 240, spec: "x" },
    { id: "last-updated", height: 20, spec: "x" },
    { id: "single", height: 100, spec: "x" },
    { id: "selfclose", height: 100, spec: "x" },
    { id: "hasboolean", height: 100, spec: "x" },
    { id: "hasunquoted", height: 100, spec: "x" },
    { id: "hasdigit", height: 100, spec: "x" },
    { id: "mixed", height: 100, spec: "x" },
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

// ---------------------------------------------------------------------------------------
// End-to-end via parsePlan: each of these shells is exactly the shape from the defect
// report — a real attribute list on a placeholder, now that S13 (2026-09-07) tells the
// planner the placeholder IS the region and should carry its class. Before this fix, every
// one of these threw PlanError via unmatchedSlotAttributes ("shell has data-slot
// attribute(s) that didn't form a valid placeholder"); now they must all parse cleanly.
// ---------------------------------------------------------------------------------------

test("A5.8 — bare boolean attribute (hidden) on a placeholder no longer throws PlanError", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a" hidden></div>\n===SLOTS===\na|200|A\n';
  const plan = parsePlan(raw);
  assert.deepEqual(plan.slots.map((s) => s.id), ["a"]);
});

test("A5.9 — class plus a trailing boolean attribute on a placeholder no longer throws PlanError", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a" class="x" hidden></div>\n===SLOTS===\na|200|A\n';
  const plan = parsePlan(raw);
  assert.deepEqual(plan.slots.map((s) => s.id), ["a"]);
});

test("A5.10 — a digit in an attribute name (data-col2) on a placeholder no longer throws PlanError", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a" data-col2="x"></div>\n===SLOTS===\na|200|A\n';
  const plan = parsePlan(raw);
  assert.deepEqual(plan.slots.map((s) => s.id), ["a"]);
});

test("A5.11 — an unquoted attribute value (class=x) on a placeholder no longer throws PlanError", () => {
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a" class=x></div>\n===SLOTS===\na|200|A\n';
  const plan = parsePlan(raw);
  assert.deepEqual(plan.slots.map((s) => s.id), ["a"]);
});

test("A5.12 — real content inside a data-slot element still throws PlanError (guard #3 must survive)", () => {
  // This one is NOT in the "fixed" table — a regex genuinely cannot tell an intentional
  // placeholder from real content the model forgot to strip, so this must keep failing
  // loudly via unmatchedSlotAttributes rather than silently dropping the region.
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a">actual content</div>\n===SLOTS===\na|200|A\n';
  assert.throws(() => parsePlan(raw), (err: unknown) => err instanceof PlanError);
});

// ---------------------------------------------------------------------------------------
// utilityCss — the `.hidden` fallback (see slots.ts's doc comment on the function, and on
// `hasStandaloneHiddenSelector`, for the full rationale: emitted only when the planner's CSS
// does not already define a STANDALONE `.hidden` — one that applies with no other class
// required on the same element — and only meant to be placed AFTER the planner stylesheet by
// its caller; the ordering itself is covered in shell.test.ts, since it is `renderShellHead`,
// not this function, that controls placement).
//
// This gate deliberately asks a DIFFERENT, narrower question than F8's `CSS_CLASS_SELECTOR`
// ("is `hidden` styled at all", which credits a compound selector's second class — see that
// regex's own tests/comment). A planner that only ever writes `.x.hidden{}` has an opinion
// about `.hidden` for F8's purposes, but NOT for this gate's: adding `hidden` to some other,
// unrelated element does nothing, and this gate exists precisely to fix that case. See
// shell.test.ts's regression tests for the real artifact this was caught on.
// ---------------------------------------------------------------------------------------

test("utilityCss — planner CSS has no .hidden anywhere: the fallback rule is returned", () => {
  const css = ".panel{padding:8px} .btn.active{color:blue}";
  assert.equal(utilityCss(css), ".hidden{display:none}");
});

test("utilityCss — planner CSS already defines a standalone .hidden selector: nothing is returned", () => {
  const css = ".panel{padding:8px} .hidden{visibility:hidden}";
  assert.equal(utilityCss(css), "");
});

test("utilityCss — planner .hidden definition inside a pseudo-class context still counts as standalone", () => {
  // `.hidden:not(.foo)` applies `.hidden` on its own to any element that has it — `:not(.foo)`
  // restricts what is EXCLUDED, not what else must additionally be present — so this is still
  // standalone, unlike a compound class selector such as `.hidden.foo`.
  const css = ".hidden:not(.foo){display:none}";
  assert.equal(utilityCss(css), "");
});

test("utilityCss — a COMPOUND selector defining .hidden (e.g. .confirmation-panel.hidden) does NOT suppress the fallback", () => {
  // This is the live bug this gate exists to fix, using the exact CSS from a real generation
  // (tests/quality/artifacts/2026-09-06T17-31-26-174Z/parallel-contact-form.html): the planner
  // defined `.confirmation-panel.hidden{display:none}`, but a DIFFERENT element
  // (`.contact-form`) was toggled with `.classList.add("hidden")` and had no matching rule of
  // its own. `.confirmation-panel.hidden` requires BOTH classes on the same element, so it
  // does not answer "will adding hidden to an arbitrary element hide it?" — the fallback must
  // still fire so `.contact-form.hidden`-shaped toggles actually hide something.
  //
  // This is a deliberate REVERSAL of this gate's old behavior (see git history / CLAUDE.md):
  // an earlier version of this predicate reused F8's "is hidden mentioned at all" question and
  // stood the fallback down here, which is exactly what let the live bug through.
  const css =
    ".contact-form { background:#fff; } " +
    ".confirmation-panel.hidden { display: none; } " +
    ".contact-form, .confirmation-panel { padding: 1.5rem; }";
  assert.equal(utilityCss(css), ".hidden{display:none}");
});

test("utilityCss — .hidden in a descendant combinator position suppresses the fallback", () => {
  // `.panel .hidden{}` is two separate compound units (descendant combinator splits them) —
  // `.hidden` applies on its own to whatever carries it, regardless of an ancestor's class.
  const css = ".panel .hidden{display:none}";
  assert.equal(utilityCss(css), "");
});

test("utilityCss — .hidden as one option of a grouped selector list suppresses the fallback", () => {
  // `.a, .hidden{}` — the comma separates two independent selectors; `.hidden` alone is one of
  // them, so it applies to any element carrying just `hidden`.
  const css = ".a, .hidden{display:none}";
  assert.equal(utilityCss(css), "");
});

test("utilityCss — a compound .a.hidden alongside a standalone .hidden in the same rule still suppresses", () => {
  // `.a.hidden, .hidden{}` — the FIRST unit is compound (does not qualify on its own), but the
  // SECOND unit is a standalone `.hidden` and qualifies by itself; one qualifying unit anywhere
  // in the stylesheet is enough.
  const css = ".a.hidden, .hidden{display:none}";
  assert.equal(utilityCss(css), "");
});

test("utilityCss — a compound selector .a.b does NOT credit either class as a standalone definition", () => {
  const css = ".ctrl-btn.start{color:green}";
  assert.equal(utilityCss(css), ".hidden{display:none}"); // neither name is "hidden" — sanity
  const cssWithHidden = ".ctrl-btn.hidden{color:green}";
  // Unlike F8's CSS_CLASS_SELECTOR (which credits "hidden" here), this gate must NOT treat a
  // compound .ctrl-btn.hidden as an applicable rule for an arbitrary element — the fallback
  // still fires.
  assert.equal(utilityCss(cssWithHidden), ".hidden{display:none}");
});

test("utilityCss — empty planner CSS: the fallback rule is returned", () => {
  assert.equal(utilityCss(""), ".hidden{display:none}");
});

test("utilityCss — decimal numbers in CSS declarations invent nothing", () => {
  // Decimals appear only inside declaration blocks, which hasStandaloneHiddenSelector strips
  // before scanning for selectors at all — `0.5`/`.65` must never be misread as `.hidden` (or
  // any class) via the leading dot.
  const css = ".panel{opacity:0.5;margin:0.5rem} .other{opacity:.65}";
  assert.equal(utilityCss(css), ".hidden{display:none}");
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
