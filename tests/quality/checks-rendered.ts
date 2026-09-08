/**
 * Frontend section F ("Generated-app quality", `.docs/tests-frontend.md`) — rendered-page
 * checks driven programmatically against a real Chromium (`chromium.launch()` from the
 * `playwright` package — see `runner.ts`), never the `playwright test` CLI or a config file.
 *
 * No `lib.dom` anywhere in this file, on purpose: this package's root `tsconfig.json` cannot
 * be touched (see `CLAUDE.md`/the task brief), it has no exclusion for `tests/quality`, and
 * `tests/frontend`'s own DOM-enabled tsconfig is not reachable from here — a bare `document`/
 * `window` identifier in this file would fail `npm run typecheck`, and an ambient `.d.ts`
 * adding `lib.dom` here would leak DOM globals into the *whole* program the same way the root
 * tsconfig's own comment warns about for `tests/frontend`. So every piece of in-page logic
 * below is written as a plain JS **string** passed to `page.evaluate()` — Playwright accepts
 * a string there and never type-checks its contents — rather than a TypeScript arrow function
 * that would need `document`/`window`/`HTMLElement` declared as ambient types. Everything
 * outside those strings uses only Playwright's own `Page`/`Locator` API, which needs no DOM
 * lib either.
 */
import type { Page } from "playwright";
import type { CheckResult } from "./checks-doc";

function ok(id: string, label: string, pass: boolean, detail?: string): CheckResult {
  return { id, label, status: pass ? "pass" : "fail", detail };
}
function skip(id: string, label: string, reason: string): CheckResult {
  return { id, label, status: "skip", detail: reason };
}

/** Attach console/pageerror listeners *before* navigating — F1 needs errors from load itself,
 * not just from the idle period after. Returns the two arrays the checks below read from;
 * call this before `page.goto`. */
export function attachErrorListeners(page: Page): { consoleErrors: string[]; pageErrors: string[] } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => {
    pageErrors.push(err.message);
  });
  return { consoleErrors, pageErrors };
}

/** F1: no console/page errors during load and 5s of idle. Call after the 5s wait. */
function checkF1(consoleErrors: string[], pageErrors: string[]): CheckResult {
  const all = [...consoleErrors, ...pageErrors];
  return ok(
    "F1",
    "No console errors during load and 5s idle",
    all.length === 0,
    all.length ? all.slice(0, 5).join(" | ") : undefined,
  );
}

const OVERFLOW_PROBE = `
(function () {
  var doc = document.documentElement;
  var body = document.body;
  var viewportWidth = window.innerWidth;
  var scrollWidth = Math.max(doc ? doc.scrollWidth : 0, body ? body.scrollWidth : 0);
  return { viewportWidth: viewportWidth, scrollWidth: scrollWidth };
})()
`;

/** F2/F3 share one probe (viewport width vs. document scroll width); only the viewport size
 * and the resulting label/id differ. A 1px slack absorbs subpixel rounding that is not a real
 * overflow. F3's spec text ("no content overflowing its container") is approximated here as
 * "no *horizontal document* overflow" — the cheap, high-signal proxy the spec's own note (F2
 * "is worth having early... horizontal overflow is both the most common way that fails and
 * trivially detectable") explicitly names, not a per-element containment check against every
 * nested box on the page. A component that overflows its own card but stays within the
 * document's overall width would not be caught by either. */
async function checkOverflow(
  page: Page,
  id: string,
  label: string,
  width: number,
  height: number,
): Promise<CheckResult> {
  await page.setViewportSize({ width, height });
  await page.waitForTimeout(150); // let CSS media queries/layout settle
  const { viewportWidth, scrollWidth } = await page.evaluate<{ viewportWidth: number; scrollWidth: number }>(
    OVERFLOW_PROBE,
  );
  const overflow = scrollWidth > viewportWidth + 1;
  return ok(id, label, !overflow, overflow ? `scrollWidth ${scrollWidth} > viewport ${viewportWidth}` : undefined);
}

const checkF2 = (page: Page) => checkOverflow(page, "F2", "No horizontal scroll on <body> at 375px", 375, 812);
const checkF3 = (page: Page) => checkOverflow(page, "F3", "No content overflowing its container at 1440px", 1440, 900);

export interface F4Result extends CheckResult {
  clicked: number;
  skipped: number;
  total: number;
}

/**
 * F4: every button and link is clickable, with no error thrown on click.
 *
 * Uses Playwright's `Locator` API (not `$$eval`) throughout — see the file header. An anchor
 * whose `href` looks like it would navigate away (an absolute URL, or a relative path that
 * isn't just an in-page fragment) is deliberately **skipped**, not clicked: this app is a
 * single generated page, and following a real navigation would tear down the very page the
 * rest of this sweep's checks (F5-F9) need to keep running against. That is a real narrowing
 * of what F4 as written asks for ("every button and link") — a generated app's external links
 * (if any) get no click coverage at all here. `{ force: true }` bypasses Playwright's own
 * actionability wait (covered-by-another-element, off-screen, etc.) — the case cares whether
 * the *app* throws on click, not whether Playwright considers the element cleanly clickable.
 */
async function checkF4(page: Page, pageErrors: string[]): Promise<F4Result> {
  const locator = page.locator(
    'button, a[href], input[type="button"], input[type="submit"], [role="button"]',
  );
  const total = await locator.count();
  const errorsBefore = pageErrors.length;
  let clicked = 0;
  let skipped = 0;

  for (let i = 0; i < total; i++) {
    const el = locator.nth(i);
    // No reliable tag-name check here (see the file header — Locator.evaluate's default
    // generic needs lib.dom, so it's avoided entirely). A `button`/`input`/`[role=button]`
    // never carries a real `href`, so gating on the attribute alone is tag-agnostic and
    // catches the one case this guards against: an <a> that would actually navigate.
    const href = await el.getAttribute("href").catch(() => null);
    const navigates = !!href && href.trim() !== "" && href.trim() !== "#" && !href.trim().startsWith("#");
    if (navigates) {
      skipped++;
      continue;
    }
    const visible = await el.isVisible().catch(() => false);
    if (!visible) {
      skipped++;
      continue;
    }
    await el.click({ force: true, timeout: 3000 }).catch(() => {
      // A Playwright-level click failure (detached mid-click, etc.) is not what F4 measures
      // — it measures whether a successful click throws inside the app. Not counted either
      // way; the element is still "clicked" in the sense that was attempted.
    });
    clicked++;
    await page.waitForTimeout(120);
  }

  const newErrors = pageErrors.slice(errorsBefore);
  const pass = newErrors.length === 0;
  return {
    id: "F4",
    label: "Every button and link is clickable, no error thrown on click",
    status: pass ? "pass" : "fail",
    detail: pass
      ? `clicked ${clicked}/${total} (${skipped} skipped: hidden or external link)`
      : `clicked ${clicked}/${total}, errors: ${newErrors.slice(0, 3).join(" | ")}`,
    clicked,
    skipped,
    total,
  };
}

/** F5: no "lorem ipsum" in rendered text. Named by the spec itself as "trivially gameable" —
 * a model that writes "Lörem Ipsüm" or embeds the words as separate spans passes this check
 * while still shipping placeholder filler; it catches the literal, common case and nothing
 * cleverer. */
async function checkF5(page: Page): Promise<CheckResult> {
  const text = await page.evaluate<string>("document.body ? document.body.innerText.toLowerCase() : ''");
  const found = text.includes("lorem ipsum");
  return ok("F5", 'Rendered text contains no "lorem ipsum"', !found);
}

/** F6: no visible raw HTML or stray markers on screen. Checks rendered *text* (not markup)
 * for the literal artifacts this project's own streaming format could leak if a parser step
 * broke: an un-consumed `===SLOT id===` marker, a markdown fence, or `<`/`>` that read as text
 * because a tag was written escaped rather than parsed. This is a fixed, known-artifact list,
 * not a general "does this look like broken HTML" detector — a different kind of leaked
 * marker this project doesn't currently produce would not be caught. */
async function checkF6(page: Page): Promise<CheckResult> {
  const text = await page.evaluate<string>("document.body ? document.body.innerText : ''");
  const markers = ["===SLOT", "```", "&lt;div", "&lt;script", "&lt;template"];
  const found = markers.filter((m) => text.includes(m));
  return ok(
    "F6",
    "No visible raw HTML or stray markers on screen",
    found.length === 0,
    found.length ? `found: ${found.join(", ")}` : undefined,
  );
}

interface ContrastProbe {
  ratio: number;
  fg: string;
  bg: string;
  sample: string;
}

const CONTRAST_PROBE = `
(function () {
  function parseColor(str) {
    var m = /rgba?\\(([^)]+)\\)/.exec(str || "");
    if (!m) return null;
    var parts = m[1].split(",").map(function (s) { return parseFloat(s); });
    return { r: parts[0] || 0, g: parts[1] || 0, b: parts[2] || 0, a: parts.length > 3 ? parts[3] : 1 };
  }
  function luminance(c) {
    function chan(v) {
      v = v / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    return 0.2126 * chan(c.r) + 0.7152 * chan(c.g) + 0.0722 * chan(c.b);
  }
  var body = document.body;
  if (!body) return { ratio: 0, fg: "", bg: "", sample: "" };
  var style = window.getComputedStyle(body);
  var fg = parseColor(style.color) || { r: 0, g: 0, b: 0, a: 1 };
  var bgEl = body;
  var bg = null;
  while (bgEl) {
    var s = window.getComputedStyle(bgEl);
    var c = parseColor(s.backgroundColor);
    if (c && c.a > 0) { bg = c; break; }
    bgEl = bgEl.parentElement;
  }
  if (!bg) bg = { r: 255, g: 255, b: 255, a: 1 };
  var l1 = luminance(fg) + 0.05;
  var l2 = luminance(bg) + 0.05;
  var ratio = l1 > l2 ? l1 / l2 : l2 / l1;
  return { ratio: ratio, fg: style.color, bg: style.backgroundColor, sample: (body.innerText || "").slice(0, 40) };
})()
`;

const MIN_CONTRAST_RATIO = 4.5; // WCAG AA, normal text

/**
 * F7: contrast of body text against its background meets a minimum ratio.
 *
 * Samples exactly one pairing — `document.body`'s own computed `color` against the nearest
 * ancestor (starting at `body` itself) with a non-transparent `background-color` — not every
 * text/background pairing on the page. A page whose body text is fine but some card or badge
 * has poor contrast would not be caught; a page with a background *image* or CSS gradient
 * (rather than a solid `background-color`) falls back to white here, which can produce a
 * false pass or fail depending on the actual image. `MIN_CONTRAST_RATIO` is WCAG AA's normal-
 * text threshold (4.5:1) applied uniformly, even though large/heading text only needs 3:1 —
 * a stricter bar than the spec text ("meets a minimum ratio") technically requires, chosen
 * because this is a body-text sample by construction.
 */
async function checkF7(page: Page): Promise<CheckResult> {
  const probe = await page.evaluate<ContrastProbe>(CONTRAST_PROBE);
  const pass = probe.ratio >= MIN_CONTRAST_RATIO;
  return ok(
    "F7",
    "Contrast of body text against its background meets a minimum ratio",
    pass,
    `ratio ${probe.ratio.toFixed(2)}:1 (fg ${probe.fg}, bg ${probe.bg})`,
  );
}

/**
 * F8: interactive apps show a visible state change on interaction. Only meaningful for
 * prompts tagged "interactive" in `prompts.ts` — the caller is expected to skip this for
 * everything else, which is why this function itself never returns a `skip` (the caller
 * decides applicability, not this file).
 *
 * The heuristic is deliberately model-agnostic rather than prompt-specific: click up to five
 * visible, plausibly-interactive elements in document order and check whether the page's
 * rendered text differs at **any point along the way** — sampled after every click, not just
 * before-the-first vs. after-the-last. That distinction is not theoretical: this sweep's own
 * minimal real run hit it directly. A generated counter's controls landed in DOM order as
 * `-`, `+`, `Reset`; clicking all three in sequence takes the display 0 -> -1 -> 0 -> 0, so a
 * before/after-only comparison sees "0" both times and reports no change on an app that is
 * plainly working. Sampling after each click catches the transient -1 in the middle and
 * passes correctly.
 *
 * What's still a real gap: it cannot tell a genuine state change from an unrelated mutation
 * (an opened dropdown, a hover-triggered tooltip that happens to still be visible when
 * sampled), so a false pass is possible. It also cannot target the *specific* control a human
 * would recognize as "the interactive part" (a plus button vs. a decorative icon button) — it
 * clicks whatever `checkF4`-style selectors find, in document order, which is a reasonable
 * proxy only because these apps are small.
 */
async function checkF8Interactive(page: Page): Promise<CheckResult> {
  const locator = page.locator('button, a[href="#"], input[type="button"], [role="button"]');
  const total = await locator.count();
  const n = Math.min(total, 5);
  let attempted = 0;
  let changed = false;
  let previous = await page.evaluate<string>("document.body ? document.body.innerText : ''");
  for (let i = 0; i < n; i++) {
    const el = locator.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.click({ force: true, timeout: 2000 }).catch(() => {});
      attempted++;
      await page.waitForTimeout(250);
      const current = await page.evaluate<string>("document.body ? document.body.innerText : ''");
      if (current !== previous) changed = true;
      previous = current;
    }
  }
  if (attempted === 0) {
    return ok("F8", "Interactive apps show a visible state change on interaction", false, "no clickable element found to interact with");
  }
  return ok(
    "F8",
    "Interactive apps show a visible state change on interaction",
    changed,
    changed ? undefined : `clicked ${attempted} element(s) (checked after each click), rendered text never changed`,
  );
}

/**
 * S13 diagnostic (`.docs/testing-review.md`): fills a real `<form>`'s inputs with plausible
 * values, submits it, and checks whether the page's *visible* text changed at all. Exists
 * because `checkF8Interactive` above cannot see this failure class two different ways at
 * once: it only runs for prompts tagged `"interactive"` (`contact-form` is tagged `"form"`,
 * not `"interactive"` — see `prompts.ts`), and even if it did run, it clicks whatever
 * buttons/links it finds without filling any fields first — a submit button behind
 * `required`/`type="email"` HTML5 validation with empty inputs never actually fires a
 * `submit` event, so the click-and-compare heuristic would report nothing either way,
 * correctly by its own lights. This is a *diagnostic*, not a spec F-case, for the same reason
 * `F8_MODIFIER_DIAGNOSTIC_ID` in `checks-doc.ts` is: never folded into the F1-F8 rate — see
 * `report.ts`'s dedicated diagnostics table.
 *
 * S13's own reduced example is exactly the shape this catches: a shell script that toggles
 * `hidden` on `[data-slot="x"]` (the skeleton wrapper) while the planner's CSS rule
 * (`.form-panel.hidden`) targets a class the fill call put on an element *inside* that
 * wrapper. Submitting the form throws no error and the DOM structure is entirely valid — the
 * only observable symptom is that nothing the user can see changes. Comparing
 * `document.body.innerText` before vs. after is a genuine signal for this, not a weaker
 * substitute for a real assertion: `innerText` (unlike `textContent`) already excludes
 * anything `display:none`, so it faithfully reflects the *rendered* tree at each moment — an
 * app whose submit handler actually flips which panel is visible changes what `innerText`
 * returns (the form's labels disappear, the confirmation copy appears); an app whose handler
 * runs but touches the wrong element changes nothing in the accessible tree, and `innerText`
 * before and after are identical strings.
 *
 * Scoped to the *first* `<form>` on the page only — a page with more than one form (a search
 * box plus a real submission form, say) gets no coverage on the others. Field values are
 * chosen from the input's `type` attribute and a loose `name`/`placeholder` keyword match
 * (`plausibleValueFor` below), not from the prompt's own content, so this is necessarily a
 * generic fill, not a semantically perfect one — good enough to satisfy typical HTML5
 * validation (a real email shape, a non-empty required field) without needing per-prompt
 * fixtures. Known gap symmetrical with `checkF4`'s: a false pass remains possible if a submit
 * handler mutates something *other* than visible text/visibility (e.g. it only fires a
 * non-visual side effect), and a false fail remains possible if a legitimately-working submit
 * handler doesn't change on-screen text either (unlikely for a "confirmation message" prompt,
 * which is what this is scoped to, but not impossible in general).
 *
 * **Reloads the page before doing anything else** — found live, writing this diagnostic's own
 * differential test (parallel- vs. sequential-contact-form.html). `runRenderedChecks` runs
 * this *after* `checkF4`, which clicks every button on the page, submit included, with every
 * field still empty. On a form with its own client-side "required" validation (the real
 * `contact-form` documents both have one), that empty submit fails validation and leaves
 * validation-error text visible in the DOM (`.error-message.visible`) — real, on-screen text
 * that has nothing to do with S13. Left in place, that becomes a *confound*, not a fixed
 * baseline: this diagnostic's own fill-and-resubmit later clears those errors (because the
 * fields are filled now), which changes `document.body.innerText` on its own, in *both* the
 * broken and the working document — a false pass on exactly the broken one this diagnostic
 * exists to catch. Confirmed live: `parallel-contact-form.html` read "pass" when driven
 * through the full `runRenderedChecks` pipeline (F1-F8 first, this diagnostic last), and
 * correctly "fail" when this function was called directly against a freshly-loaded page with
 * no prior interaction. Reloading first discards whatever state F1-F8 left behind, so this
 * diagnostic always measures its *own* before/after against a clean load — the same guarantee
 * a fresh `page.goto()` would give, without needing to actually open a second page.
 */
export const FORM_SUBMIT_DIAGNOSTIC_ID = "DIAG:form-submit-inert";

/** Loose type/name/placeholder -> plausible value mapping, so `checkFormSubmitDiagnostic` can
 * fill an arbitrary generated form well enough to pass ordinary HTML5 validation
 * (`required`, `type="email"`, etc.) without knowing anything about the specific app. Not
 * trying to be a realistic fixture generator — just enough substance that a validity check
 * doesn't reject it and that filled inputs aren't literally empty. */
function plausibleValueFor(type: string, name: string, placeholder: string): string {
  const hint = `${name} ${placeholder}`.toLowerCase();
  const t = type.toLowerCase();
  if (t === "email" || hint.includes("email")) return "quality-check@example.com";
  if (t === "tel" || hint.includes("phone")) return "+1 555 0100";
  if (t === "url" || hint.includes("website")) return "https://example.com";
  if (t === "number" || t === "range") return "42";
  if (t === "date") return "2026-01-15";
  if (t === "search") return "quality check";
  if (t === "password") return "TestPassword123!";
  if (hint.includes("name")) return "Jane Doe";
  return "Quality-check test value.";
}

function normalizeVisibleText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export async function checkFormSubmitDiagnostic(page: Page): Promise<CheckResult> {
  const label = "[diagnostic, S13] submitting the form visibly changes the page";

  // See this function's doc comment — earlier checks in the same run (F4, in particular) can
  // leave behind on-screen state (validation errors from an empty-field click) that would
  // otherwise confound the before/after comparison below.
  await page.reload({ waitUntil: "load", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(300);

  const forms = page.locator("form");
  if ((await forms.count()) === 0) {
    return skip(FORM_SUBMIT_DIAGNOSTIC_ID, label, "no <form> element found on the page");
  }
  const form = forms.first();

  // Fill every visible, plausibly-fillable text-like field inside the form.
  const fillable = form.locator(
    'input:not([type="submit"]):not([type="button"]):not([type="checkbox"]):not([type="radio"])' +
      ':not([type="hidden"]):not([type="file"]):not([type="range"]):not([type="color"]), textarea',
  );
  const fillableCount = await fillable.count();
  for (let i = 0; i < fillableCount; i++) {
    const el = fillable.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    const type = (await el.getAttribute("type").catch(() => null)) ?? "text";
    const name = (await el.getAttribute("name").catch(() => null)) ?? "";
    const placeholder = (await el.getAttribute("placeholder").catch(() => null)) ?? "";
    await el.fill(plausibleValueFor(type, name, placeholder), { timeout: 2000 }).catch(() => {});
  }

  // Check every checkbox/radio — an unmet "you must agree" requirement would otherwise block
  // submission for a reason unrelated to what this diagnostic measures.
  const checkable = form.locator('input[type="checkbox"], input[type="radio"]');
  const checkableCount = await checkable.count();
  for (let i = 0; i < checkableCount; i++) {
    const el = checkable.nth(i);
    if (await el.isVisible().catch(() => false)) {
      await el.check({ force: true, timeout: 2000 }).catch(() => {});
    }
  }

  // Pick a non-default option in every <select> — index 0 is very often an unselectable
  // placeholder ("Choose a category…"), so a required <select> stuck at index 0 can fail
  // native validation the same way an empty field would.
  const selects = form.locator("select");
  const selectCount = await selects.count();
  for (let i = 0; i < selectCount; i++) {
    const el = selects.nth(i);
    if (!(await el.isVisible().catch(() => false))) continue;
    await el
      .selectOption({ index: 1 }, { timeout: 2000 })
      .catch(() => el.selectOption({ index: 0 }, { timeout: 2000 }).catch(() => {}));
  }

  const before = await page.evaluate<string>("document.body ? document.body.innerText : ''");

  const submitControl = form.locator('button[type="submit"], input[type="submit"], button:not([type])');
  if ((await submitControl.count()) > 0) {
    await submitControl.first().click({ force: true, timeout: 3000 }).catch(() => {});
  } else if (fillableCount > 0) {
    // No explicit submit control found — pressing Enter in the last filled field triggers the
    // browser's own implicit form submission, dispatching the same real "submit" event a
    // button click would.
    await fillable
      .nth(fillableCount - 1)
      .press("Enter", { timeout: 2000 })
      .catch(() => {});
  }

  await page.waitForTimeout(400);
  const after = await page.evaluate<string>("document.body ? document.body.innerText : ''");

  const changed = normalizeVisibleText(before) !== normalizeVisibleText(after);
  return ok(
    FORM_SUBMIT_DIAGNOSTIC_ID,
    label,
    changed,
    changed
      ? undefined
      : "filled and submitted the first <form> on the page; rendered text was identical before and after",
  );
}

export interface RenderedChecksOptions {
  /** Prompt tags from `prompts.ts` — controls whether F8 is scored or skipped. */
  tags: string[];
}

/**
 * Runs the whole of frontend section F against one already-navigated, settled page.
 * `attachErrorListeners(page)` must have been called *before* `page.goto()` — see its doc
 * comment — and the returned arrays passed in here. F9 (the screenshot/HTML artifact) is not
 * produced by this function; `runner.ts` saves those directly, since it owns the artifact
 * paths and needs to save them unconditionally rather than as a pass/fail case (per the spec:
 * "reviewed by a human on failure — some quality regressions have no assertion").
 */
export async function runRenderedChecks(
  page: Page,
  listeners: { consoleErrors: string[]; pageErrors: string[] },
  opts: RenderedChecksOptions,
): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  results.push(checkF1(listeners.consoleErrors, listeners.pageErrors));
  results.push(await checkF2(page));
  results.push(await checkF3(page));
  results.push(await checkF4(page, listeners.pageErrors));
  results.push(await checkF5(page));
  results.push(await checkF6(page));
  results.push(await checkF7(page));

  if (opts.tags.includes("interactive")) {
    results.push(await checkF8Interactive(page));
  } else {
    results.push(skip("F8", "Interactive apps show a visible state change on interaction", "prompt not tagged interactive"));
  }

  if (opts.tags.includes("form")) {
    results.push(await checkFormSubmitDiagnostic(page));
  } else {
    results.push(
      skip(
        FORM_SUBMIT_DIAGNOSTIC_ID,
        "[diagnostic, S13] submitting the form visibly changes the page",
        "prompt not tagged form",
      ),
    );
  }

  return results;
}
