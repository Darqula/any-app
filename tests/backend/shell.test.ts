/**
 * renderShellHead's .hidden utility CSS: gating and placement (see utilityCss). Needs no Postgres or env: shell.ts imports only
 * @any-app/protocol.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderShellHead, renderFullHead } from "../../apps/studio/src/shell";
import { utilityCss, renderDocument, renderSkeletons } from "@any-app/protocol";
import type { AppPlan, FilledApp } from "@any-app/protocol";

// `__dirname` does not exist in ES modules — same pattern as tests/harness/*.ts and
// packages/store/src/migrate.ts.
const here = path.dirname(fileURLToPath(import.meta.url));

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
  const doc = renderShellHead(plan(".panel{padding:8px}"), "http://localhost:3000");
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
  );
  assert.equal(doc.includes(".hidden{display:none}"), false, "must not override a planner that had its own opinion");
  // The planner's own .hidden rule is still there, untouched.
  assert.ok(doc.includes(".hidden{visibility:hidden}"));
});

test("shell — SKELETON_CSS is always emitted before the planner stylesheet, regardless of the fallback", () => {
  const doc = renderShellHead(plan(""), "http://localhost:3000");
  const skeletonIndex = doc.indexOf("anyapp-skeleton");
  const anyappIndex = doc.indexOf('<style id="anyapp-css">');
  assert.ok(skeletonIndex !== -1 && anyappIndex !== -1 && skeletonIndex < anyappIndex);
});

test("shell — renderFullHead (the edit-time render path) gates and places the fallback the same way as renderShellHead", () => {
  const doc = renderFullHead(plan(".panel{padding:8px}"), "http://localhost:3000");
  const anyappIndex = doc.indexOf('<style id="anyapp-css">');
  const utilityIndex = doc.indexOf(".hidden{display:none}");
  assert.ok(anyappIndex !== -1 && utilityIndex !== -1 && anyappIndex < utilityIndex);
});

// Regression proof against a real persisted generation (a contact form).
// Its planner CSS has only a COMPOUND `.form-panel.hidden, .confirmation-panel.hidden`, yet its handler toggles `hidden` on
// `.contact-form`, which no rule covers. utilityCss must fire on it, which needs hasStandaloneHiddenSelector, not F8's question.
// A separate, unrelated defect in that artifact: its script queries [data-slot="confirmation-panel"], the outer skeleton wrapper
// which never carries `hidden`, so the panel never shows. That is a DOM-targeting bug in generated code, not fixed here.

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
  // Remove the compound rules to reconstruct the common shape: a slot uses `X hidden` and nothing in the CSS mentions .hidden.
  const cssWithNoHiddenRule = plannerCss.replace(/\.form-panel\.hidden,\s*\.confirmation-panel\.hidden\s*\{[^}]*\}/, "");
  assert.equal(cssWithNoHiddenRule.includes("hidden"), false, "sanity: no trace of .hidden left");

  const oldDoc = `<style id="anyapp-css">${cssWithNoHiddenRule}</style>`;
  const newDoc = oldDoc + `<style>${utilityCss(cssWithNoHiddenRule)}</style>`;

  // A text heuristic, not a real cascade. It is only valid because cssWithNoHiddenRule has no .hidden-shaped substring at all.
  function wouldBeHidden(doc: string): boolean {
    return /\.hidden\s*\{[^}]*display\s*:\s*none/.test(doc);
  }

  assert.equal(wouldBeHidden(oldDoc), false, "before the fallback: nothing hides it — the permanently-visible bug");
  assert.equal(wouldBeHidden(newDoc), true, "after the fallback: the fallback rule hides it");
});

// The shell script targets [data-slot="x"], which carries the region's classes only if the planner put them on the placeholder
// and fill did not re-wrap its content. These prove the mechanism through the real renderShellHead/renderSkeletons path; they cannot
// prove a model follows the reworded prompts.

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
    // The planner's actual shell: bare placeholders with no class, which is what produced the artifact's un-targetable element.
    shell: '<main><div data-slot="form-panel"></div><div data-slot="confirmation-panel"></div></main>',
    script: "",
    slots: b1Slots(),
    collections: [],
  };
  const doc = renderShellHead(planA, "http://localhost:3000");
  const marker = 'data-slot="confirmation-panel"';
  const start = doc.lastIndexOf("<", doc.indexOf(marker));
  const end = doc.indexOf(">", doc.indexOf(marker)) + 1;
  const element = doc.slice(start, end);
  // The rendered tag's class is only anyapp-skeleton: neither the semantic class nor the initial `hidden` state is on it.
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
    // Change 1: the planner puts the region's own class, including its initial `hidden` state, on the placeholder.
    shell:
      '<main><div data-slot="form-panel" class="form-panel"></div>' +
      '<div data-slot="confirmation-panel" class="confirmation-panel hidden"></div></main>',
    script: "",
    slots: b1Slots(),
    collections: [],
  };
  const doc = renderShellHead(planB, "http://localhost:3000");
  const marker = 'data-slot="confirmation-panel"';
  const start = doc.lastIndexOf("<", doc.indexOf(marker));
  const end = doc.indexOf(">", doc.indexOf(marker)) + 1;
  const element = doc.slice(start, end);
  assert.equal(
    element,
    '<div id="slot-confirmation-panel" data-slot="confirmation-panel" class="confirmation-panel hidden anyapp-skeleton" style="min-height:180px">',
  );
  // The element the artifact's handler queries now carries both classes, so the compound rule applies and remove("hidden") works.
  assert.ok(doc.includes(".confirmation-panel.hidden"), "sanity: the real artifact's compound rule is present");
});

test("S13 — coupling: Change 1 (class on placeholder) WITHOUT Change 2 (fill call still wraps) doubles the class, nested", () => {
  // The failure mode if only the planner half ships: a fill call that wraps its output in the same class leaves it on two nested elements.
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
