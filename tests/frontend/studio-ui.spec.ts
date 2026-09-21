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

    // A fresh page load, so this asserts what the server renders, not the live refresh.
    await page.goto("/");

    expect(dialogFired).toBe(false);
    await expect(page.locator("#generation-list img")).toHaveCount(0);
    await expect(page.locator("#generation-list li", { hasText: marker })).toBeVisible();
  });

  test("A10 — status badges are one width, and the delete cross takes no room until the row is hovered", async ({ page }) => {
    const marker = `A10-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    for (const status of ["complete", "pending", "failed", "streaming"] as const) {
      await seedGeneration(databaseUrl, { prompt: `${marker} ${status}`, document: MINIMAL_DOCUMENT, status, sessionId });
    }
    await page.goto("/");

    const widths = await page
      .locator("#generation-list li", { hasText: marker })
      .locator(".status")
      .evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
    expect(widths).toHaveLength(4);
    expect(new Set(widths).size, `badge widths: ${widths}`).toBe(1);

    const row = page.locator("#generation-list li", { hasText: `${marker} complete` });
    const badge = row.locator(".status");
    const cross = row.locator(".app-delete");
    const restX = (await badge.boundingBox())!.x;
    expect((await cross.boundingBox())!.width).toBe(0);
    await row.hover();
    await expect.poll(async () => (await cross.boundingBox())!.width).toBeGreaterThan(0);
    await expect.poll(async () => (await badge.boundingBox())!.x).toBeLessThan(restX);

    // A mouse click on the row's name focuses it; the cross must not stay open once the
    // pointer has left (it used to, via :focus-within).
    await row.locator("button").click();
    await page.mouse.move(600, 300);
    await expect.poll(async () => (await cross.boundingBox())!.width).toBe(0);
  });

  test("A11 — delete uses the in-page confirmation dialog: cancel and Escape keep the app, Delete removes it", async ({ page }) => {
    const marker = `A11-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    const { id } = await seedGeneration(databaseUrl, { prompt: `${marker} doomed`, document: MINIMAL_DOCUMENT, status: "complete", sessionId });
    let native = 0;
    page.on("dialog", async (d) => { native++; await d.dismiss(); });
    await page.goto("/");

    const row = page.locator("#generation-list li", { hasText: marker });
    const dialog = page.locator("#confirm-dialog");
    const open = async () => { await row.hover(); await row.locator(".app-delete").click(); await expect(dialog).toBeVisible(); };

    await open();
    await expect(dialog).toContainText(`${marker} doomed`);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await open();
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(row).toHaveCount(1);

    await open();
    await dialog.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(row).toHaveCount(0);
    expect(native, "the browser's own confirm() must not be used").toBe(0);

    const pool = new Pool({ connectionString: databaseUrl });
    try {
      const { rows } = await pool.query("select 1 from generations where id = $1", [id]);
      expect(rows).toHaveLength(0);
    } finally {
      await pool.end();
    }
  });

  test("A12 — the sidebar follows the server without a reload: status flips and rows created elsewhere appear", async ({ page }) => {
    const marker = `A12-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    const { id } = await seedGeneration(databaseUrl, { prompt: `${marker} first`, document: MINIMAL_DOCUMENT, status: "pending", sessionId });
    await page.goto("/");

    const status = page.locator("#generation-list li", { hasText: `${marker} first` }).locator(".status");
    await expect(status).toHaveText("pending");

    const pool = new Pool({ connectionString: databaseUrl });
    try {
      await pool.query("update generations set status = 'streaming' where id = $1", [id]);
      await expect(status).toHaveText("streaming", { timeout: 10_000 });
      await pool.query("update generations set status = 'complete' where id = $1", [id]);
      await expect(status).toHaveText("complete", { timeout: 10_000 });
    } finally {
      await pool.end();
    }

    // A row this tab never created (another tab or device). A pending one keeps the fast
    // poll running, so this does not have to wait out the idle interval.
    await seedGeneration(databaseUrl, { prompt: `${marker} second`, document: MINIMAL_DOCUMENT, status: "pending", sessionId });
    await expect(page.locator("#generation-list li", { hasText: `${marker} second` })).toBeVisible({ timeout: 20_000 });
  });

  test("A13 — creating an app from the composer shows its row immediately, as pending or beyond, and highlights it", async ({ page }) => {
    const prompt = `A13 composer ${Date.now()}`;
    await page.goto("/");
    await page.fill('textarea[name="prompt"]', prompt);
    await page.click('button[type="submit"]');
    const row = page.locator("#generation-list li", { hasText: prompt });
    await expect(row).toBeVisible({ timeout: 5_000 });
    await expect(row).toHaveClass(/active/);
    await expect(page.locator('textarea[name="prompt"]')).toHaveValue("");
  });

  test("A14 — the conversation panel: hidden with nothing selected, shows the prompt, expands to ~30% of the screen, and remembers it", async ({ page }) => {
    const prompt = `A14 conversation ${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, { prompt, document: MINIMAL_DOCUMENT, status: "complete", sessionId });
    await page.goto("/");

    const panel = page.locator(".chat-panel");
    const log = page.locator("#chat-log");
    await expect(panel).toBeHidden();

    await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
    await expect(panel).toBeVisible();
    await expect(page.locator("#chat-toggle")).toHaveAttribute("aria-expanded", "false");
    await expect(log).toBeHidden(); // collapsed: just the header strip

    await page.locator("#chat-toggle").click();
    await expect(page.locator("#chat-toggle")).toHaveAttribute("aria-expanded", "true");
    await expect(log).toBeVisible();
    await expect(log.locator("li").first()).toContainText(prompt);
    const viewport = page.viewportSize()!;
    const height = (await log.boundingBox())!.height;
    expect(Math.abs(height - viewport.height * 0.3)).toBeLessThan(6);

    // Remembered per browser, and hidden again when the shown app is deleted.
    await page.reload();
    await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
    await expect(log).toBeVisible();
    await page.locator("#chat-toggle").click();
    await expect(log).toBeHidden();
  });

  test("A15 — the create box empties on submit and the prompt still reaches the server; a rejected prompt is put back", async ({ page }) => {
    const prompt = `A15 clears ${Date.now()}`;
    await page.goto("/");
    const box = page.locator('textarea[name="prompt"]');

    await box.fill(prompt);
    await page.click('button[type="submit"]');
    await expect(box).toHaveValue("");
    await expect(page.locator("#stage iframe")).toHaveCount(1);
    expect(await promptsMatching(prompt)).toEqual([prompt]); // cleared in the UI, sent in full

    // Whitespace passes the browser's "required" check but the server rejects it (400): the
    // text comes back so it can be fixed instead of retyped.
    await box.fill("   ");
    await page.click('button[type="submit"]');
    await expect(box).toHaveValue("   ");

    // ...but not over something the user has typed since.
    await box.fill("   ");
    await box.press("Enter");
    await box.fill("new draft");
    await expect(box).toHaveValue("new draft");
  });
});
