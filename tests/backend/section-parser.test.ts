/** A3: parseSections. Re-exported by the package index. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSections } from "@any-app/generator";

test("A3.1 — all five sections present: each body returned, trimmed", () => {
  const raw =
    "===TITLE===\nMy App\n" +
    "===CSS===\nbody{margin:0}\n" +
    "===SHELL===\n<div data-slot=\"a\"></div>\n" +
    "===SLOTS===\na|200|Do a thing\n" +
    "===SCRIPT===\nconsole.log(1)\n";
  const sections = parseSections(raw);
  assert.deepEqual(sections, {
    TITLE: "My App",
    CSS: "body{margin:0}",
    SHELL: '<div data-slot="a"></div>',
    SLOTS: "a|200|Do a thing",
    SCRIPT: "console.log(1)",
  });
});

test("A3.2 — SCRIPT section absent: key absent, no throw", () => {
  const raw = "===TITLE===\nMy App\n===CSS===\nbody{}\n";
  const sections = parseSections(raw);
  assert.deepEqual(sections, { TITLE: "My App", CSS: "body{}" });
  assert.equal("SCRIPT" in sections, false);
});

test("A3.3 — ===CSS=== trailing text: not treated as a header, headers must be alone on the line", () => {
  const raw = "===CSS=== trailing text\nbody{}\n";
  const sections = parseSections(raw);
  assert.deepEqual(sections, {});
});

test("A3.4 — a === line inside CSS content: not treated as a header unless it matches the full pattern", () => {
  const raw = "===CSS===\na{}\n=== not a header ===\nb{}\n";
  const sections = parseSections(raw);
  assert.deepEqual(sections, { CSS: "a{}\n=== not a header ===\nb{}" });
});

test("A3.5 — empty section body: returns empty string, not undefined", () => {
  const raw = "===CSS===\n===SHELL===\n<div></div>\n";
  const sections = parseSections(raw);
  assert.equal(sections.CSS, "");
  assert.notEqual(sections.CSS, undefined);
  assert.equal(sections.SHELL, "<div></div>");
});

test("A3.6 — no markers at all: returns {}", () => {
  assert.deepEqual(parseSections("no markers here at all, just prose"), {});
});
