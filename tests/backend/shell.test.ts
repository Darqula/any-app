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
import { mintAppToken, utilityCss, renderDocument, renderSkeletons } from "@any-app/protocol";
import type { AppPlan, FilledApp } from "@any-app/protocol";

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
// IMPORTANT — history, corrected twice now (see slots.ts's `hasStandaloneHiddenSelector` and
// `utilityCss` doc comments for the full story):
//
// Reading that file shows the planner's stylesheet defines a COMPOUND selector,
// `.form-panel.hidden, .confirmation-panel.hidden { display: none; }`, not a standalone
// `.hidden` rule. An earlier version of `CSS_CLASS_SELECTOR` carried a `(?<![\w.])`
// lookbehind that (wrongly) refused to credit the second class of a compound selector at
// all, so an even-earlier version of `utilityCss` misread this document as "the planner never
// mentioned .hidden" and fired its fallback. Dropping the lookbehind fixed that misread —
// but the fix over-corrected for THIS gate specifically: crediting a compound selector as
// "the planner has an opinion on .hidden" is the right answer for F8 (is `hidden` styled at
// all — yes, if you also carry `confirmation-panel`), but the WRONG question for `utilityCss`
// (will adding `hidden` to an arbitrary element hide it — no, not unless it also carries
// `confirmation-panel`). That wrong question is exactly what let a live bug through: the same
// artifact's own submit handler toggles `hidden` on `.contact-form`, which has NO matching
// rule, compound or otherwise — and the compound-crediting gate stood the fallback down
// anyway, so `.contact-form` never hid.
//
// `hasStandaloneHiddenSelector` (slots.ts) is the fix: it only credits a selector unit whose
// ONLY class is `hidden`, so a compound `.confirmation-panel.hidden` no longer suppresses the
// fallback. The tests below prove, against this exact real artifact: (1) `utilityCss` now
// fires on this document's actual planner CSS (it did not before), and (2) the general
// mechanism — a toggle with NO applicable `.hidden` rule at all — was, and remains, fixed.
//
// A separate, genuine defect is visible in this artifact, unrelated to any of the above: the
// submit handler calls
// `document.querySelector('[data-slot="confirmation-panel"]').classList.remove("hidden")`,
// but `[data-slot="confirmation-panel"]` resolves to the OUTER skeleton wrapper (S12 forces
// `data-slot` onto that element), which never carries the "hidden" class to begin with (only
// the INNER filled `<div class="confirmation-panel hidden">` does) — so the confirmation
// panel never becomes visible after a real submission either. That is a DOM-targeting bug in
// the generated script, unrelated to CSS, and this change does not fix it (reported
// separately, no action needed here).
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

test("regression — real artifact's actual CSS: the compound-only .hidden definition does NOT suppress the fallback", () => {
  const artifact = readFileSync(ARTIFACT_PATH, "utf8");
  const plannerCss = extractPlannerCss(artifact);
  assert.ok(plannerCss.includes(".confirmation-panel.hidden"), "sanity: the compound rule is really there");
  assert.equal(
    utilityCss(plannerCss),
    ".hidden{display:none}",
    "a compound-only .hidden rule must not stand the fallback down — .contact-form's toggle has no rule of its own",
  );
});

test("regression — general case: NO .hidden-matching rule anywhere also fires the fallback (same outcome, simpler input)", () => {
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
  // template emits (see the artifact's `<template id="c-confirmation-panel">`). This is a
  // TEXT heuristic, not a real cascade — good enough only because `cssWithNoHiddenRule`
  // contains no `.hidden`-shaped substring at all (asserted above), so it cannot be fooled by
  // a compound selector the way it would be for `plannerCss` itself (see the test above,
  // which asks `utilityCss` directly rather than pattern-matching stylesheet text for that
  // reason).
  function wouldBeHidden(doc: string): boolean {
    return /\.hidden\s*\{[^}]*display\s*:\s*none/.test(doc);
  }

  assert.equal(wouldBeHidden(oldDoc), false, "before the fallback: nothing hides it — the permanently-visible bug");
  assert.equal(wouldBeHidden(newDoc), true, "after the fallback: the fallback rule hides it");
});

// ---------------------------------------------------------------------------------------
// S13 (.docs/testing-review.md) — the shell script targets [data-slot="x"], but that element
// only carries the classes the model's stylesheet/script depend on if the PLANNER put them on
// the placeholder itself (planner-prompt.ts's SHELL rule) and the fill call did NOT re-wrap its
// content in a container of its own (fill-prompt.ts / fill-slot-prompt.ts's rule). These tests
// prove the *mechanism* end to end through the real, unmodified renderShellHead/renderSkeletons
// path, using the real artifact's own CSS (`.form-panel.hidden, .confirmation-panel.hidden`)
// and slot sizes. They do NOT prove the model will follow the reworded prompts — that is not
// verifiable offline; see the prompt changes themselves and .docs/testing-review.md.
// ---------------------------------------------------------------------------------------

function b1Slots(): AppPlan["slots"] {
  return [
    { id: "form-panel", height: 380, spec: "The contact form." },
    { id: "confirmation-panel", height: 180, spec: "Thank-you message shown after submit." },
  ];
}

test("S13 — the real artifact's ACTUAL (pre-fix) shape: [data-slot=\"confirmation-panel\"] carries none of the CSS's toggle classes", () => {
  const artifact = readFileSync(ARTIFACT_PATH, "utf8");
  const plannerCss = extractPlannerCss(artifact);
  const planA: AppPlan = {
    title: "Contact Studio",
    css: plannerCss,
    // The planner's actual shell: bare placeholders, no class — this is what produced the
    // real artifact's line `<div id="slot-confirmation-panel" data-slot="confirmation-panel"
    // class="anyapp-skeleton" ...></div>`, which the artifact's own toggle script then misses.
    shell: '<main><div data-slot="form-panel"></div><div data-slot="confirmation-panel"></div></main>',
    script: "",
    slots: b1Slots(),
    collections: [],
  };
  const doc = renderShellHead(planA, "http://localhost:3000", mintAppToken(randomUUID(), SECRET));
  const marker = 'data-slot="confirmation-panel"';
  const start = doc.lastIndexOf("<", doc.indexOf(marker));
  const end = doc.indexOf(">", doc.indexOf(marker)) + 1;
  const element = doc.slice(start, end);
  // The exact rendered opening tag: `class` is ONLY `anyapp-skeleton` — neither the semantic
  // class the CSS rule needs (`confirmation-panel`) nor the initial toggle state (`hidden`) is
  // on the element the artifact's own script queries via `[data-slot="confirmation-panel"]`.
  assert.equal(
    element,
    '<div id="slot-confirmation-panel" data-slot="confirmation-panel" class="anyapp-skeleton" style="min-height:180px">',
  );
});

test("S13 — B-shaped plan (Change 1): placeholder carries the region's class, merged with anyapp-skeleton, id/data-slot still forced", () => {
  const artifact = readFileSync(ARTIFACT_PATH, "utf8");
  const plannerCss = extractPlannerCss(artifact);
  const planB: AppPlan = {
    title: "Contact Studio",
    css: plannerCss,
    // Change 1: the planner puts the region's own class — including its initial "hidden"
    // state, which is exactly the kind of thing a shell (not the not-yet-run fill call) can
    // reasonably decide — directly on the placeholder.
    shell:
      '<main><div data-slot="form-panel" class="form-panel"></div>' +
      '<div data-slot="confirmation-panel" class="confirmation-panel hidden"></div></main>',
    script: "",
    slots: b1Slots(),
    collections: [],
  };
  const doc = renderShellHead(planB, "http://localhost:3000", mintAppToken(randomUUID(), SECRET));
  const marker = 'data-slot="confirmation-panel"';
  const start = doc.lastIndexOf("<", doc.indexOf(marker));
  const end = doc.indexOf(">", doc.indexOf(marker)) + 1;
  const element = doc.slice(start, end);
  assert.equal(
    element,
    '<div id="slot-confirmation-panel" data-slot="confirmation-panel" class="confirmation-panel hidden anyapp-skeleton" style="min-height:180px">',
  );
  // The exact element the real artifact's own submit handler queries
  // (`document.querySelector('[data-slot="confirmation-panel"]')`) now carries both the
  // semantic class the CSS rule needs (`confirmation-panel`) and the initial toggle state
  // (`hidden`) — the compound selector `.confirmation-panel.hidden{display:none}` applies to
  // this exact element, and `.classList.remove("hidden")` on it is no longer a no-op.
  assert.ok(doc.includes(".confirmation-panel.hidden"), "sanity: the real artifact's compound rule is present");
});

test("S13 — coupling: Change 1 (class on placeholder) WITHOUT Change 2 (fill call still wraps) doubles the class, nested", () => {
  // Demonstrates the failure mode the doc comments in planner-prompt.ts/fill-prompt.ts warn
  // about: if only the planner half of the fix ships, a fill call that (against the still-old
  // fill-prompt wording, or simply non-compliant) wraps its own output in a container carrying
  // the same class ends up with that class on two nested elements.
  const filled: FilledApp = {
    title: "t",
    css: ".confirmation-panel{padding:2rem}",
    shell: '<div data-slot="confirmation-panel" class="confirmation-panel hidden"></div>',
    script: "",
    slots: [{ id: "confirmation-panel", height: 180, spec: "s" }],
    // What an UN-fixed fill call (still wrapping) would produce even though the placeholder
    // now also carries the class — the bug Change 2 exists to prevent.
    content: { "confirmation-panel": '<div class="confirmation-panel hidden"><p>Thanks!</p></div>' },
    collections: [],
  };
  const doc = renderDocument(
    filled,
    (p) => `<head><style>${p.css}</style></head><body>${renderSkeletons(p.shell, p.slots)}`,
    "</body>",
  );
  const occurrences = (doc.match(/class="[^"]*\bconfirmation-panel\b[^"]*"/g) ?? []).length;
  assert.equal(occurrences, 2, "the class appears on two different elements — the outer slot AND the fill call's own wrapper");
});
