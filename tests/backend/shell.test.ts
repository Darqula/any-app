/**
 * renderShellHead's `.hidden` utility-CSS gating and placement (see slots.ts's `utilityCss`
 * doc comment for the full rationale). No Postgres, no env, no credentials — `shell.ts`
 * imports nothing but `@any-app/protocol` (same property K24/K25 in data-api.test.ts already
 * rely on to test `renderShellHead` without a running server), so this file needs none of
 * data-api.test.ts's file-level scratch-database fixture either.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderShellHead, renderFullHead } from "../../apps/studio/src/shell";
import { mintAppToken, utilityCss } from "@any-app/protocol";
import type { AppPlan } from "@any-app/protocol";

// `__dirname` does not exist in ES modules — same pattern as tests/harness/*.ts and
// packages/store/src/migrate.ts.
const here = path.dirname(fileURLToPath(import.meta.url));

const SECRET = "shell-test-fixed-app-token-secret";

function plan(css: string): AppPlan {
  return {
    title: "Test app",
    css,
    shell: "<main></main>",
    script: "",
    slots: [],
    collections: [],
  };
}

test("shell — planner CSS lacks .hidden: the fallback <style> is emitted, after the planner stylesheet", () => {
  const doc = renderShellHead(plan(".panel{padding:8px}"), "http://localhost:3000", mintAppToken(randomUUID(), SECRET));
  const anyappIndex = doc.indexOf('<style id="anyapp-css">');
  const utilityIndex = doc.indexOf(".hidden{display:none}");
  assert.notEqual(anyappIndex, -1, "planner stylesheet must be present");
  assert.notEqual(utilityIndex, -1, "the .hidden fallback must be emitted");
  assert.ok(anyappIndex < utilityIndex, "the fallback must come after the planner stylesheet, to win ties on source order");
});

test("shell — planner CSS already defines .hidden: no fallback is emitted at all", () => {
  const doc = renderShellHead(
    plan(".panel{padding:8px} .hidden{visibility:hidden}"),
    "http://localhost:3000",
    mintAppToken(randomUUID(), SECRET),
  );
  assert.equal(doc.includes(".hidden{display:none}"), false, "must not override a planner that had its own opinion");
  // The planner's own .hidden rule is still there, untouched.
  assert.ok(doc.includes(".hidden{visibility:hidden}"));
});

test("shell — SKELETON_CSS is always emitted before the planner stylesheet, regardless of the fallback", () => {
  const doc = renderShellHead(plan(""), "http://localhost:3000", mintAppToken(randomUUID(), SECRET));
  const skeletonIndex = doc.indexOf("anyapp-skeleton");
  const anyappIndex = doc.indexOf('<style id="anyapp-css">');
  assert.ok(skeletonIndex !== -1 && anyappIndex !== -1 && skeletonIndex < anyappIndex);
});

test("shell — renderFullHead (the edit-time render path) gates and places the fallback the same way as renderShellHead", () => {
  const doc = renderFullHead(plan(".panel{padding:8px}"), "http://localhost:3000", mintAppToken(randomUUID(), SECRET));
  const anyappIndex = doc.indexOf('<style id="anyapp-css">');
  const utilityIndex = doc.indexOf(".hidden{display:none}");
  assert.ok(anyappIndex !== -1 && utilityIndex !== -1 && anyappIndex < utilityIndex);
});

// ---------------------------------------------------------------------------------------
// Regression proof against the real persisted artifact
// (tests/quality/artifacts/2026-09-06T17-31-26-174Z/parallel-contact-form.html).
//
// IMPORTANT — what this actually proves, and what it does not (corrected after review):
//
// Reading that file shows the planner's stylesheet defines a COMPOUND selector,
// `.form-panel.hidden, .confirmation-panel.hidden { display: none; }`, not a standalone
// `.hidden` rule. An earlier version of `CSS_CLASS_SELECTOR` carried a `(?<![\w.])`
// lookbehind that (wrongly) refused to credit the second class of a compound selector —
// `.hidden` in `.confirmation-panel.hidden` is preceded by the word character `l` — so an
// earlier version of `utilityCss` misread this real document as "the planner never defined
// .hidden" and fired its fallback anyway. That was itself an instance of the exact failure
// utilityCss's doc comment warns against ("clobber a planner that legitimately defined
// .hidden"), caught in review and fixed by dropping the lookbehind (see the comment on
// `CSS_CLASS_SELECTOR` in slots.ts).
//
// With that fixed, the correct, verified behaviour is: this document's planner CSS DOES
// count as defining `.hidden` (via the compound selector), so `utilityCss` now correctly
// returns "" for it — the fallback does not fire here, and nothing about this document
// changes as a result of change 1. The confirmation panel's div,
// `class="confirmation-panel hidden"`, was already hidden at initial render by the planner's
// own compound rule, with or without this change.
//
// A separate, genuine defect is visible in this artifact: the submit handler calls
// `document.querySelector('[data-slot="confirmation-panel"]').classList.remove("hidden")`,
// but `[data-slot="confirmation-panel"]` resolves to the OUTER skeleton wrapper (S12 forces
// `data-slot` onto that element), which never carries the "hidden" class to begin with (only
// the INNER filled `<div class="confirmation-panel hidden">` does) — so the confirmation
// panel never becomes visible after a real submission either. That is a DOM-targeting bug in
// the generated script, unrelated to CSS, and this change does not fix it (reported
// separately, no action needed here).
//
// What the tests below prove: (1) with the corrected regex, utilityCss reads this exact real
// CSS as "planner already defined .hidden" and stays silent — i.e. change 1 fires on ZERO of
// the sweep's saved documents (this is the only one using a bare `hidden` class at all, and
// it defines it compound), so change 1 is purely defensive for the cases actually observed,
// not a fix for any live case; and (2) the general mechanism this change targets — a slot
// writing `class="X hidden"` with NO applicable `.hidden`-matching rule anywhere — is still
// correctly fixed, demonstrated on a reconstructed variant of this CSS with the compound rule
// removed.
// ---------------------------------------------------------------------------------------

const ARTIFACT_PATH = path.join(
  here,
  "../quality/artifacts/2026-09-06T17-31-26-174Z/parallel-contact-form.html",
);

function extractPlannerCss(doc: string): string {
  const start = doc.indexOf('<style id="anyapp-css">') + '<style id="anyapp-css">'.length;
  const end = doc.indexOf("</style>", start);
  return doc.slice(start, end);
}

test("regression — real artifact's actual CSS: the compound .hidden definition IS credited, so the fallback does NOT fire", () => {
  const artifact = readFileSync(ARTIFACT_PATH, "utf8");
  const plannerCss = extractPlannerCss(artifact);
  assert.ok(plannerCss.includes(".confirmation-panel.hidden"), "sanity: the compound rule is really there");
  assert.equal(utilityCss(plannerCss), "", "the planner's own compound .hidden rule must be respected, not overridden");
});

test("regression — general case: NO .hidden-matching rule anywhere fixes a permanently-visible toggled panel", () => {
  const artifact = readFileSync(ARTIFACT_PATH, "utf8");
  const plannerCss = extractPlannerCss(artifact);
  // Strip the two compound `.hidden` rules to reconstruct the more common real-world shape:
  // a slot uses `class="X hidden"` and NOTHING in the stylesheet mentions `.hidden` at all.
  const cssWithNoHiddenRule = plannerCss.replace(/\.form-panel\.hidden,\s*\.confirmation-panel\.hidden\s*\{[^}]*\}/, "");
  assert.equal(cssWithNoHiddenRule.includes("hidden"), false, "sanity: no trace of .hidden left");

  const oldDoc = `<style id="anyapp-css">${cssWithNoHiddenRule}</style>`;
  const newDoc = oldDoc + `<style>${utilityCss(cssWithNoHiddenRule)}</style>`;

  // Simulate what the browser's cascade would compute for the confirmation panel's div,
  // `class="confirmation-panel hidden"`, using the same rule the artifact's own content
  // template emits (see the artifact's `<template id="c-confirmation-panel">`).
  function wouldBeHidden(doc: string): boolean {
    // A `display:none` declaration reaches the element only if some rule in `doc` has a
    // selector matching an element with classes {confirmation-panel, hidden} and sets
    // display:none. With no compound/standalone .hidden rule (oldDoc), nothing does.
    return /\.hidden\s*\{[^}]*display\s*:\s*none/.test(doc);
  }

  assert.equal(wouldBeHidden(oldDoc), false, "before the fix: nothing hides it — the permanently-visible bug");
  assert.equal(wouldBeHidden(newDoc), true, "after the fix: the fallback rule hides it");
});
