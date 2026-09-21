/**
 * H1-H7: generated-app data. H1-H4, H6, H7 use seeded rows; H5 needs one real edit round trip using a session credential (edits are session-aware,
 * a fresh generation is not: see global-setup.ts). Data calls run through frame.evaluate() rather than the document's own script, which would
 * re-run on reload and double-write. H6/H7 filter one known studio-shell error (doc-builder.ts).
 */
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { mintAppToken } from "@any-app/protocol";
import { startFakeProvider } from "../harness/fake-provider";
import { HANDOFF_PATH } from "./global-setup";
import {
  seedFilledApp,
  openSidebarApp,
  waitForFrameBySrc,
  establishAnonSession,
  STUDIO_ORIGIN,
  isKnownStudioHomepageSyntaxBug,
} from "./doc-builder";

const { databaseUrl, appTokenSecret } = JSON.parse(await readFile(HANDOFF_PATH, "utf8")) as {
  databaseUrl: string;
  appTokenSecret: string;
};

test.describe("H — generated-app data", () => {
  test("H1 — an app with a DATA section carries the data runtime and a token", async ({ page }) => {
    const prompt = `H1-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    const { id, document } = await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, prompt, {
      collections: [{ name: "todos", description: "things to do" }],
    }, sessionId);
    expect(document).toContain("window.anyapp");
    expect(document).toContain(mintAppToken(id, "rw", appTokenSecret));

    const { frame } = await openSidebarApp(page, prompt);
    const hasData = await frame.evaluate(() => typeof (window as unknown as { anyapp?: { data?: { create?: unknown } } }).anyapp?.data?.create === "function");
    expect(hasData).toBe(true);
  });

  test("H2 — a static app with no DATA section carries no data runtime and no token", async ({ page }) => {
    const prompt = `H2-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    const { id, document } = await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, prompt, {}, sessionId);
    expect(document).not.toContain("window.anyapp");
    expect(document).not.toContain(mintAppToken(id, "rw", appTokenSecret));

    const { frame } = await openSidebarApp(page, prompt);
    const hasData = await frame.evaluate(
      () => typeof (window as unknown as { anyapp?: { data?: unknown } }).anyapp?.data === "undefined",
    );
    expect(hasData).toBe(true);
  });

  test("H3 — a record created from inside the frame is still there after a reload", async ({ page }) => {
    const prompt = `H3-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, prompt, {
      collections: [{ name: "notes", description: "notes" }],
    }, sessionId);
    const { frame, src } = await openSidebarApp(page, prompt);
    const created = await frame.evaluate(async () => {
      const anyapp = (window as unknown as { anyapp: { data: DataApiBrowser } }).anyapp;
      return anyapp.data.create("notes", { text: "hello" });
    });
    expect(created.id).toBeTruthy();

    // Reload the SAME app — a fresh iframe, a fresh load.
    await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
    const frame2 = await waitForFrameBySrc(page, src, { excludeFrame: frame });
    const list = await frame2.evaluate(async () => {
      const anyapp = (window as unknown as { anyapp: { data: DataApiBrowser } }).anyapp;
      return anyapp.data.list("notes");
    });
    expect(list.records).toHaveLength(1);
    expect((list.records[0]!.data as { text: string }).text).toBe("hello");
  });

  test("H4 — two apps with the same collection name each see only their own rows", async ({ page }) => {
    const promptA = `H4-A-${Date.now()}`;
    const promptB = `H4-B-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, promptA, {
      collections: [{ name: "shared", description: "x" }],
    }, sessionId);
    await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, promptB, {
      collections: [{ name: "shared", description: "x" }],
    }, sessionId);

    const { frame: frameA } = await openSidebarApp(page, promptA);
    await frameA.evaluate(async () => {
      const anyapp = (window as unknown as { anyapp: { data: DataApiBrowser } }).anyapp;
      await anyapp.data.create("shared", { owner: "A" });
    });
    const listA = await frameA.evaluate(async () => {
      const anyapp = (window as unknown as { anyapp: { data: DataApiBrowser } }).anyapp;
      return anyapp.data.list("shared");
    });
    expect(listA.records).toHaveLength(1);
    expect((listA.records[0]!.data as { owner: string }).owner).toBe("A");

    const { frame: frameB } = await openSidebarApp(page, promptB);
    const listB = await frameB.evaluate(async () => {
      const anyapp = (window as unknown as { anyapp: { data: DataApiBrowser } }).anyapp;
      return anyapp.data.list("shared");
    });
    expect(listB.records).toHaveLength(0);
  });

  test("H5 — a data-backed app still reads its rows after a slot edit (the token survives re-rendering)", async ({ page }) => {
    const fake = await startFakeProvider();
    try {
      const prompt = `H5-${Date.now()}`;
      const slotId = "alpha";
      const sessionId = await establishAnonSession(page);
      await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, prompt, {
        collections: [{ name: "notes", description: "x" }],
        slots: [{ id: slotId, height: 100, spec: "x" }],
        content: { [slotId]: "<p>original</p>" },
      }, sessionId);

      const { frame, src } = await openSidebarApp(page, prompt);
      const seeded = await frame.evaluate(async () => {
        const anyapp = (window as unknown as { anyapp: { data: DataApiBrowser } }).anyapp;
        return anyapp.data.create("notes", { text: "seed" });
      });
      expect(seeded.id).toBeTruthy();

      await page.goto("/settings");
      await page.selectOption('#cred-form select[name="provider"]', "openai");
      await page.fill('#cred-form input[name="apiKey"]', "test-key-h5");
      await page.fill('#cred-form input[name="baseUrl"]', fake.baseUrl);
      await page.fill('#cred-form input[name="model"]', "fake-model");
      fake.queueComplete({ text: "ok" });
      await page.click('#cred-form button[type="submit"]');
      await expect(page.locator("#cred-result")).toContainText("Saved and validated");

      fake.queueComplete({ text: "<p>edited region</p>" });
      await page.goto("/");
      await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
      // Kept so the next reload can exclude this frame: an uncaptured intermediate frame lets the reload race against itself (waitForFrameBySrc).
      const srcAfterFirstReload = await page.locator("#stage iframe").getAttribute("src");
      const frameAfterFirstReload = await waitForFrameBySrc(page, srcAfterFirstReload!);
      await page.fill('#edit-form input[name="instruction"]', "reword this");
      await page.selectOption('#edit-form select[name="target"]', slotId);
      await page.click('#edit-form button[type="submit"]');
      await expect(page.locator("#edit-result")).toContainText("Updated");

      // Reload fresh: every edit re-renders the document, which must reproduce the same token; otherwise this list() call would 401.
      await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
      const frame2 = await waitForFrameBySrc(page, src, { excludeFrame: frameAfterFirstReload });
      const list = await frame2.evaluate(async () => {
        const anyapp = (window as unknown as { anyapp: { data: DataApiBrowser } }).anyapp;
        return anyapp.data.list("notes");
      });
      expect(list.records).toHaveLength(1);
      expect((list.records[0]!.data as { text: string }).text).toBe("seed");
      await expect(frame2.locator(`#slot-${slotId}`)).toContainText("edited region");
    } finally {
      await fake.close();
    }
  });

  test("H6 — a 429 from the data API is handled honestly: something readable on screen, no unhandled rejection", async ({ page }) => {
    const prompt = `H6-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, prompt, {
      collections: [{ name: "items", description: "x" }],
    }, sessionId);
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(String(e)));

    const { frame } = await openSidebarApp(page, prompt);
    const result = await frame.evaluate(async () => {
      const anyapp = (window as unknown as { anyapp: { data: DataApiBrowser } }).anyapp;
      const status = document.createElement("p");
      status.id = "h6-status";
      status.textContent = "loading…";
      document.body.appendChild(status);

      // The write bucket starts at 60, so 62 rapid creates guarantee a 429. Each call has its own handler so nothing rejects unhandled.
      const calls: Promise<{ ok: boolean; message?: string }>[] = [];
      for (let i = 0; i < 62; i++) {
        calls.push(
          anyapp.data.create("items", { n: i }).then(
            () => ({ ok: true }),
            (e: Error) => ({ ok: false, message: e.message }),
          ),
        );
      }
      const results = await Promise.all(calls);
      const failed = results.filter((r) => !r.ok);
      status.textContent =
        failed.length > 0 ? `done — ${failed.length} failed: ${failed[0]!.message}` : "done — all succeeded";
      return { failedCount: failed.length, sampleError: failed[0]?.message ?? null };
    });

    expect(result.failedCount).toBeGreaterThan(0);
    expect(result.sampleError).toMatch(/rate limit/i);
    await expect(frame.locator("#h6-status")).not.toHaveText("loading…");
    await expect(frame.locator("#h6-status")).toContainText("failed");
    expect(pageErrors.filter((e) => !isKnownStudioHomepageSyntaxBug(e))).toEqual([]);
  });

  test("H7 — no console errors while a data-backed app loads", async ({ page }) => {
    const prompt = `H7-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, prompt, {
      collections: [{ name: "things", description: "x" }],
    }, sessionId);
    const errors: string[] = [];
    page.on("console", (msg) => {
      if (msg.type() === "error") errors.push(msg.text());
    });
    page.on("pageerror", (e) => errors.push(String(e)));

    const { frame } = await openSidebarApp(page, prompt);
    const created = await frame.evaluate(async () => {
      const anyapp = (window as unknown as { anyapp: { data: DataApiBrowser } }).anyapp;
      return anyapp.data.create("things", { n: 1 });
    });
    expect(created.id).toBeTruthy();
    expect(errors.filter((e) => !isKnownStudioHomepageSyntaxBug(e))).toEqual([]);
  });
});

// Ambient type for frame.evaluate() callbacks: window.anyapp.data (data-runtime.ts) is attached at runtime inside the frame.
interface DataApiBrowser {
  create(collection: string, data: unknown): Promise<{ id: string }>;
  list(
    collection: string,
    where?: unknown,
    limit?: number,
  ): Promise<{ records: { id: string; data: unknown }[]; nextCursor: string | null }>;
}
