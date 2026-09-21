/**
 * A5: renderSkeletons / renderDocument / slotIdsInShell, plus the sanitizePlaceholders and utilityCss cases.
 * Target: packages/protocol/src/slots.ts.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  renderSkeletons,
  renderDocument,
  slotIdsInShell,
  utilityCss,
  sanitizePlaceholders,
} from "@any-app/protocol";
import type { FilledApp } from "@any-app/protocol";
import { parsePlan, PlanError } from "../../packages/generator/src/planner";

test("A5.1 — exact placeholder replaced with a sized skeleton div", () => {
  const out = renderSkeletons('<div data-slot="foo"></div>', [{ id: "foo", height: 300, spec: "x" }]);
  // data-slot stays on the rendered element (beside id="slot-foo") so a script querying [data-slot] still finds it.
  assert.equal(
    out,
    '<div id="slot-foo" data-slot="foo" class="anyapp-skeleton" style="min-height:300px"></div>',
  );
});

test("A5.2 — placeholder with an extra attribute is matched, and the attribute is kept (not discarded)", () => {
  // The tolerant scan matches this and keeps the model's own class. It used to be rejected (byte-exact regex), which was a
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

// Widened ATTR: boolean attributes, digits/colons in names, unquoted values.

test("A5.2m — valueless/boolean attribute (hidden) is matched and preserved", () => {
  const out = renderSkeletons('<div data-slot="a" hidden></div>', [{ id: "a", height: 50, spec: "x" }]);
  // Boolean attributes are re-emitted as hidden="": valid HTML, and renderSkeletonElement always quotes.
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
  // An unquoted class=x must not become `class=x anyapp-skeleton` (the space would end the attribute); the output is re-quoted.
  const shell = "<div data-slot=\"a\" class=x></div>";
  const out = renderSkeletons(shell, [{ id: "a", height: 50, spec: "x" }]);
  assert.equal(
    out,
    '<div id="slot-a" data-slot="a" class="x anyapp-skeleton" style="min-height:50px"></div>',
  );
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

// End-to-end via parsePlan: now that the planner is told the placeholder carries the region's class, these shells must parse
// (they used to throw PlanError).

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

test("A5.12 — real content inside a data-slot element: parsePlan no longer throws — sanitizePlaceholders strips it first", () => {
  // Deliberate reversal: this used to be rejected outright. sanitizePlaceholders now strips it with a depth-tracked scan, which is
  // safe because fill overwrites it. A5.19/A5.20 cover the cases where PlanError must still fire.
  const raw =
    "===TITLE===\nMy App\n===CSS===\nbody{}\n" +
    '===SHELL===\n<div data-slot="a">actual content</div>\n===SLOTS===\na|200|A\n';
  const plan = parsePlan(raw);
  assert.equal(plan.shell, '<div data-slot="a"></div>');
});

// sanitizePlaceholders tested directly, so each bail-out and correctness rule has its own case.

test("A5.13 — simple content: stripped, and reported in `stripped`", () => {
  const shell = '<div data-slot="chart" class="card">Loading chart...</div>';
  const out = sanitizePlaceholders(shell);
  assert.equal(out.shell, '<div data-slot="chart" class="card"></div>');
  assert.deepEqual(out.stripped, [{ id: "chart", removed: "Loading chart..." }]);
});

test("A5.14 — nested element of the SAME tag name: depth tracking closes on the correct (outer) close tag", () => {
  const shell = '<div data-slot="a"><div>inner</div></div>';
  const out = sanitizePlaceholders(shell);
  assert.equal(out.shell, '<div data-slot="a"></div>');
  assert.deepEqual(out.stripped, [{ id: "a", removed: "<div>inner</div>" }]);
});

test("A5.15 — void element inside content: does not affect depth tracking, whole content still stripped", () => {
  const shell = '<div data-slot="a">line one<br>line two</div>';
  const out = sanitizePlaceholders(shell);
  assert.equal(out.shell, '<div data-slot="a"></div>');
  assert.deepEqual(out.stripped, [{ id: "a", removed: "line one<br>line two" }]);
});

test("A5.16 — attribute value containing '>' inside nested markup: tag-boundary detection respects the quote, not the first '>'", () => {
  const shell = '<div data-slot="a"><span title="a > b">x</span></div>';
  const out = sanitizePlaceholders(shell);
  assert.equal(out.shell, '<div data-slot="a"></div>');
  assert.deepEqual(out.stripped, [{ id: "a", removed: '<span title="a > b">x</span>' }]);
});

test("A5.17 — content that is only a comment, and content containing a comment that mentions a fake data-slot: both stripped", () => {
  const commentOnly = sanitizePlaceholders('<div data-slot="a"><!-- todo --></div>');
  assert.equal(commentOnly.shell, '<div data-slot="a"></div>');
  assert.deepEqual(commentOnly.stripped, [{ id: "a", removed: "<!-- todo -->" }]);

  // A data-slot-shaped string in a comment is inert and must not trip the nested-slot bail-out.
  const fakeSlotInComment = sanitizePlaceholders(
    '<div data-slot="a"><!-- <div data-slot="fake"></div> --></div>',
  );
  assert.equal(fakeSlotInComment.shell, '<div data-slot="a"></div>');
  assert.deepEqual(fakeSlotInComment.stripped, [
    { id: "a", removed: "<!-- <div data-slot=\"fake\"></div> -->" },
  ]);
});

test("A5.18 — data-slot text inside a <script> — never treated as a placeholder, in the shell overall or inside another element's content", () => {
  // Top-level: mirrors A5.2j, but for sanitizePlaceholders — a script anywhere in the shell
  // must never be scanned for candidate elements to strip.
  const topLevel = '<script>var x = \'<div data-slot="fake">y</div>\';</script>';
  assert.deepEqual(sanitizePlaceholders(topLevel), { shell: topLevel, stripped: [] });

  // A script inside a placeholder, next to real text so it reaches the depth-tracked scan. Its body mentions data-slot and contains
  // a fake </div>; neither may block stripping or be read as the closing tag.
  const nested = sanitizePlaceholders(
    '<div data-slot="a"><script>var x = \'<div data-slot="fake"></div>\';</script>real text</div>',
  );
  assert.equal(nested.shell, '<div data-slot="a"></div>');
  assert.deepEqual(nested.stripped, [
    { id: "a", removed: "<script>var x = '<div data-slot=\"fake\"></div>';</script>real text" },
  ]);
});

test("A5.19 — a genuine nested data-slot element inside content: left alone (bail — a different, worse problem)", () => {
  const shell = '<div data-slot="a"><div data-slot="b"></div>text</div>';
  const out = sanitizePlaceholders(shell);
  assert.equal(out.shell, shell, "shell must be byte-identical — nothing touched");
  assert.deepEqual(out.stripped, []);
});

test("A5.20 — no matching close tag before end of input: left alone (bail)", () => {
  const shell = '<div data-slot="a">never closes';
  const out = sanitizePlaceholders(shell);
  assert.equal(out.shell, shell);
  assert.deepEqual(out.stripped, []);
});

test("A5.21 — the placeholder's own tag is a void element: left alone (no legal body to strip)", () => {
  // Malformed (a void element with a close tag): leave it for PlanError rather than guess.
  const shell = '<br data-slot="a">stray text</br>';
  const out = sanitizePlaceholders(shell);
  assert.equal(out.shell, shell);
  assert.deepEqual(out.stripped, []);
});

test("A5.22 — idempotency: sanitizePlaceholders(sanitizePlaceholders(shell).shell) strips nothing further", () => {
  const shells = [
    '<div data-slot="chart" class="card">Loading chart...</div>',
    '<div data-slot="a"><div>inner</div></div>',
    '<div data-slot="a">line one<br>line two</div>',
    '<div data-slot="a"><span title="a > b">x</span></div>',
    '<div data-slot="a"><!-- todo --></div>',
    // Left-alone shapes must also be stable under a second pass (nothing to change, so
    // nothing changes).
    '<div data-slot="a"><div data-slot="b"></div>text</div>',
    '<div data-slot="a">never closes',
  ];
  for (const shell of shells) {
    const first = sanitizePlaceholders(shell);
    const second = sanitizePlaceholders(first.shell);
    assert.equal(second.shell, first.shell, `not idempotent for: ${shell}`);
    assert.deepEqual(second.stripped, [], `second pass must find nothing left to strip for: ${shell}`);
  }
});

// utilityCss: the .hidden fallback fires unless the planner has a STANDALONE .hidden (not merely a compound one, which is F8's
// question). Placement after the planner CSS is tested in shell.test.ts.

test("utilityCss — planner CSS has no .hidden anywhere: the fallback rule is returned", () => {
  const css = ".panel{padding:8px} .btn.active{color:blue}";
  assert.equal(utilityCss(css), ".hidden{display:none}");
});

test("utilityCss — planner CSS already defines a standalone .hidden selector: nothing is returned", () => {
  const css = ".panel{padding:8px} .hidden{visibility:hidden}";
  assert.equal(utilityCss(css), "");
});

test("utilityCss — planner .hidden definition inside a pseudo-class context still counts as standalone", () => {
  // `.hidden:not(.foo)` still applies .hidden on its own, so it is standalone (unlike `.hidden.foo`).
  const css = ".hidden:not(.foo){display:none}";
  assert.equal(utilityCss(css), "");
});

test("utilityCss — a COMPOUND selector defining .hidden (e.g. .confirmation-panel.hidden) does NOT suppress the fallback", () => {
  // A real generated app: only
  // `.confirmation-panel.hidden` was defined, yet `.contact-form` was toggled hidden, so the fallback must still fire.
  const css =
    ".contact-form { background:#fff; } " +
    ".confirmation-panel.hidden { display: none; } " +
    ".contact-form, .confirmation-panel { padding: 1.5rem; }";
  assert.equal(utilityCss(css), ".hidden{display:none}");
});

test("utilityCss — .hidden in a descendant combinator position suppresses the fallback", () => {
  // Two compound units (descendant combinator): `.hidden` applies on its own.
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
  // One qualifying unit anywhere is enough.
  const css = ".a.hidden, .hidden{display:none}";
  assert.equal(utilityCss(css), "");
});

test("utilityCss — a compound selector .a.b does NOT credit either class as a standalone definition", () => {
  const css = ".ctrl-btn.start{color:green}";
  assert.equal(utilityCss(css), ".hidden{display:none}"); // neither name is "hidden" — sanity
  const cssWithHidden = ".ctrl-btn.hidden{color:green}";
  // A compound `.ctrl-btn.hidden` does not hide an arbitrary element, so the fallback still fires.
  assert.equal(utilityCss(cssWithHidden), ".hidden{display:none}");
});

test("utilityCss — empty planner CSS: the fallback rule is returned", () => {
  assert.equal(utilityCss(""), ".hidden{display:none}");
});

test("utilityCss — decimal numbers in CSS declarations invent nothing", () => {
  // Decimals sit inside declaration blocks, which are stripped before scanning, so 0.5 / .65 are never read as classes.
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
