/**
 * Frontend section F: rendered-page checks driven programmatically against real Chromium (not the playwright test CLI). No lib.dom here, on
 * purpose: in-page logic is a string given to page.evaluate(), so no DOM globals leak into the type program.
 */
import type { Page } from "playwright";
import type { CheckResult } from "./checks-doc";

function ok(id: string, label: string, pass: boolean, detail?: string): CheckResult {
  return { id, label, status: pass ? "pass" : "fail", detail };
}
function skip(id: string, label: string, reason: string): CheckResult {
  return { id, label, status: "skip", detail: reason };
}

/** Attach before page.goto: F1 needs errors from load itself. */
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

/**
 * F2/F3: viewport width vs. document scroll width, 1px slack. F3's "content overflowing its container" is approximated as horizontal
 * document overflow, so a component overflowing its own card within the page width is missed.
 */
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
 * F4: every button and link clickable without a thrown error. Anchors that would navigate away are skipped (they would tear down the page the
 * other checks need), so external links get no coverage. force:true because the question is whether the app throws.
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
    // Gate on the href attribute, not the tag name: Locator.evaluate needs DOM types here. Only an <a> carries a navigating href.
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

/** F5: no "lorem ipsum". Trivially gameable; catches only the literal case. */
async function checkF5(page: Page): Promise<CheckResult> {
  const text = await page.evaluate<string>("document.body ? document.body.innerText.toLowerCase() : ''");
  const found = text.includes("lorem ipsum");
  return ok("F5", 'Rendered text contains no "lorem ipsum"', !found);
}

/** F6: no visible raw markup or markers. Checks rendered text against a fixed artifact list (a ===SLOT marker, a fence, escaped tags). */
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

/** F7: contrast of one sample: body's color vs. the nearest opaque ancestor background. A gradient or image falls back to white. WCAG AA 4.5:1 for all text. */
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
 * F8: an interactive app shows a state change. Clicks up to five plausible controls and compares rendered text after EACH click, not just
 * before and after (a counter's -, +, Reset returns to 0). Cannot tell a real state change from an unrelated mutation.
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
 * Diagnostic (S13): fills the first form, submits, and checks whether visible text changed (F8 cannot: wrong prompt tag, empty required fields).
 * innerText excludes display:none, so it reflects the rendered tree. Reloads first: F4's empty submit leaves validation errors that the later
 * refill would clear, a false pass on exactly the broken document.
 */
export const FORM_SUBMIT_DIAGNOSTIC_ID = "DIAG:form-submit-inert";

/** A loose type/name/placeholder to plausible value mapping, just enough to pass HTML5 validation. */
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

  // Reload first: earlier checks (F4) leave on-screen state that would confound the before/after comparison.
  await page.reload({ waitUntil: "load", timeout: 30_000 }).catch(() => {});
  await page.waitForTimeout(300);

  const forms = page.locator("form");
  if ((await forms.count()) === 0) {
    return skip(FORM_SUBMIT_DIAGNOSTIC_ID, label, "no <form> element found on the page");
  }
  const form = forms.first();

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

  // Pick a non-default option: index 0 is usually an unselectable placeholder that would fail required validation.
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
    // No submit control found: Enter in the last field triggers the browser's implicit submission.
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

/** Runs frontend section F on one settled page. attachErrorListeners must have run before goto. F9 (screenshot/HTML) is saved by runner.ts, not here. */
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
