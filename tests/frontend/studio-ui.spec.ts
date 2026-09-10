/**
 * A1–A9 — studio UI. Needs the real servers/database (see global-setup.ts) but no model:
 * every case that needs an existing generation uses `seedGeneration()` rather than driving a
 * real one — see `.docs/tests-frontend.md`'s "Seeding instead of generating" and this task's
 * brief. A2/A3/A8/A9 are about the live submission path itself, so those go through the real
 * `POST /generations` form.
 *
 * A1 used to live in smoke.spec.ts (it still does, verbatim — see that file's own note); it
 * is repeated here too so this file is a complete, standalone A1–A9 set with one id per test
 * title, per this task's instructions.
 */
import { readFile } from "node:fs/promises";
import pg from "pg";
import { test, expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import { seedGeneration } from "../harness/seed";
import { HANDOFF_PATH } from "./global-setup";

const { Pool } = pg;

// Read once at module load — globalSetup has already finished by the time any spec file's
// module body runs, and this value never changes for the life of the run.
const { databaseUrl } = JSON.parse(await readFile(HANDOFF_PATH, "utf8")) as { databaseUrl: string };

const MINIMAL_DOCUMENT = "<!doctype html><html><body>seeded</body></html>";

async function countGenerations(): Promise<number> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<{ count: string }>("select count(*) from generations");
    return Number(rows[0]!.count);
  } finally {
    await pool.end();
  }
}

async function promptsMatching(marker: string): Promise<string[]> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<{ prompt: string }>(
      "select prompt from generations where prompt like $1 order by created_at asc",
      [`${marker}%`],
    );
    return rows.map((r) => r.prompt);
  } finally {
    await pool.end();
  }
}

/**
 * Phase 6 (impl-phase-6.md's known casualty table): the sidebar is now owner-scoped
 * (`listRecentGenerations(owner)`), so a row seeded with no `session_id` belongs to nobody
 * and never shows up for whichever fresh anonymous session this test's browser context gets.
 * Every case below that seeds a row and then expects to see it in the sidebar navigates once
 * FIRST to learn this page's real anonymous session id (the cookie value IS the session id —
 * see session.ts), seeds the row as that same session's own, then reloads.
 */
async function establishAnonSession(page: Page): Promise<string> {
  await page.goto("/");
  const cookies = await page.context().cookies();
  const cookie = cookies.find((c) => c.name === "anyapp_session");
  if (!cookie) throw new Error("expected the home page to set an anyapp_session cookie");
  return cookie.value;
}

test.describe("A — studio UI", () => {
  test("A1 — fresh load, no generations: empty state, no iframe", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#generation-list")).toContainText("No apps yet. Describe one above.");
    await expect(page.locator("#stage")).toContainText("Your app will appear here.");
    await expect(page.locator("#stage iframe")).toHaveCount(0);
  });

  test("A2 — submitting a prompt puts an iframe in #stage", async ({ page }) => {
    await page.goto("/");
    await page.fill('textarea[name="prompt"]', `A2 submit ${Date.now()}`);
    await page.click('button[type="submit"]');
    await expect(page.locator("#stage iframe")).toHaveCount(1);
  });

  test("A3 — an empty or whitespace-only prompt is blocked: no iframe, no new row", async ({ page }) => {
    const before = await countGenerations();
    await page.goto("/");

    // Fully empty: the textarea's native `required` attribute should block submission before
    // any request is even sent.
    await page.click('button[type="submit"]');
    await page.waitForTimeout(200);
    await expect(page.locator("#stage iframe")).toHaveCount(0);
    expect(await countGenerations()).toBe(before);

    // Whitespace-only: a non-zero length value satisfies native `required`, so this one
    // actually reaches the server — internal.ts's `String(req.body.prompt ?? "").trim()`
    // check is what has to reject it.
    await page.fill('textarea[name="prompt"]', "   ");
    await page.click('button[type="submit"]');
    await page.waitForTimeout(300);
    await expect(page.locator("#stage iframe")).toHaveCount(0);
    expect(await countGenerations()).toBe(before);
  });

  test("A4 — reload after a generation: the prompt appears in the sidebar with its status", async ({ page }) => {
    const prompt = `A4 sidebar ${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, { prompt, document: MINIMAL_DOCUMENT, status: "complete", sessionId });

    await page.goto("/");
    const item = page.locator("#generation-list li", { hasText: prompt });
    await expect(item).toBeVisible();
    await expect(item.locator(".status")).toHaveText("complete");
  });

  test("A5 — clicking a sidebar entry swaps #stage to that app's iframe", async ({ page }) => {
    const prompt = `A5 click target ${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    const seeded = await seedGeneration(databaseUrl, { prompt, document: MINIMAL_DOCUMENT, status: "complete", sessionId });

    await page.goto("/");
    await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();

    const iframe = page.locator("#stage iframe");
    await expect(iframe).toHaveCount(1);
    await expect(iframe).toHaveAttribute("src", new RegExp(seeded.id));
  });

  test("A6 — a prompt longer than 80 characters is truncated in the sidebar", async ({ page }) => {
    const marker = `A6-${Date.now()}-`;
    const longPrompt = marker + "x".repeat(200) + "-should-be-cut";
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, { prompt: longPrompt, document: MINIMAL_DOCUMENT, status: "complete", sessionId });

    await page.goto("/");
    const button = page.locator("#generation-list li button", { hasText: marker });
    const text = await button.textContent();
    expect(text).not.toBeNull();
    expect(text!.length).toBeLessThanOrEqual(80);
    expect(text).toBe(longPrompt.slice(0, 80));
    expect(text).not.toContain("should-be-cut");
  });

  test("A7 — a failed generation shows \"failed\", styled by .status-failed", async ({ page }) => {
    const prompt = `A7 failed ${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, {
      prompt,
      document: MINIMAL_DOCUMENT,
      status: "failed",
      error: "seeded failure for A7",
      sessionId,
    });

    await page.goto("/");
    const status = page.locator("#generation-list li", { hasText: prompt }).locator(".status");
    await expect(status).toHaveText("failed");
    await expect(status).toHaveClass(/status-failed/);
  });

  test("A8 — two rapid submits each produce their own row; the second replaces the frame", async ({ page }) => {
    const marker = `A8-${Date.now()}`;
    const promptA = `${marker}-first`;
    const promptB = `${marker}-second`;

    await page.goto("/");

    await page.fill('textarea[name="prompt"]', promptA);
    await page.click('button[type="submit"]');
    await expect(page.locator("#stage iframe")).toHaveCount(1);
    const srcA = await page.locator("#stage iframe").getAttribute("src");

    await page.fill('textarea[name="prompt"]', promptB);
    await page.click('button[type="submit"]');
    await expect(page.locator("#stage iframe")).toHaveCount(1); // still exactly one — replaced, not stacked
    // `toHaveCount(1)` above is trivially already true (the FIRST iframe already satisfies
    // it) the instant this click fires, so it does not by itself wait for the SECOND
    // response to actually land — reading `src` right after it can (and, since Phase 6 added
    // a couple of real DB round trips to POST /generations, now reliably does) still see the
    // stale first iframe. Wait for the attribute to actually change before reading it.
    await expect(page.locator("#stage iframe")).not.toHaveAttribute("src", srcA!);
    const srcB = await page.locator("#stage iframe").getAttribute("src");

    expect(srcB).not.toBe(srcA);

    const rows = await promptsMatching(marker);
    expect(rows.sort()).toEqual([promptA, promptB].sort());
  });

  test("A9 — prompt text is escaped in the sidebar", async ({ page }) => {
    const marker = `A9-${Date.now()}`;
    const prompt = `${marker}"><img src=x onerror=alert(1)>`;

    let dialogFired = false;
    page.on("dialog", async (dialog) => {
      dialogFired = true;
      await dialog.dismiss();
    });

    await page.goto("/");
    await page.fill('textarea[name="prompt"]', prompt);
    await page.click('button[type="submit"]');
    await expect(page.locator("#stage iframe")).toHaveCount(1);

    // The sidebar only re-renders on a full page load (the submit form only swaps #stage).
    await page.goto("/");

    expect(dialogFired).toBe(false);
    await expect(page.locator("#generation-list img")).toHaveCount(0);
    await expect(page.locator("#generation-list li", { hasText: marker })).toBeVisible();
  });
});
