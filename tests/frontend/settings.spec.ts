/**
 * G1-G9: provider settings and BYOK. All but G9 use the shared server with a session credential saved through the real /settings form and a fake
 * provider. G9 needs the platform credential (a fresh generation), so it runs isolated stacks, one per provider.
 * G1 and G7 are proven through the edit round trip, the session-aware consumer, because the internal stream route is reached without the browser's
 * cookie.
 */
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { HANDOFF_PATH } from "./global-setup";
import {
  seedFilledApp,
  submitPrompt,
  establishAnonSession,
  planText,
  slotMarker,
  SHELL_2_SLOTS,
  SLOTS_2,
  STUDIO_ORIGIN,
} from "./doc-builder";

const { databaseUrl, appTokenSecret } = JSON.parse(await readFile(HANDOFF_PATH, "utf8")) as {
  databaseUrl: string;
  appTokenSecret: string;
};

async function saveCredential(
  page: import("@playwright/test").Page,
  fake: FakeProvider,
  apiKey: string,
): Promise<void> {
  await page.goto("/settings");
  await page.selectOption('#cred-form select[name="provider"]', "openai");
  await page.fill('#cred-form input[name="apiKey"]', apiKey);
  await page.fill('#cred-form input[name="baseUrl"]', fake.baseUrl);
  await page.fill('#cred-form input[name="model"]', "fake-model");
  fake.queueComplete({ text: "ok" }); // satisfies build(credential).validate(model)
  await page.click('#cred-form button[type="submit"]');
  await expect(page.locator("#cred-result")).toContainText("Saved and validated");
}

test.describe("G — provider settings and BYOK", () => {
  test("G1 — saving a credential is accepted, and it actually gets used for a real call (edit round trip)", async ({ page }) => {
    const fake = await startFakeProvider();
    try {
      const prompt = `G1-${Date.now()}`;
      const sessionId = await establishAnonSession(page);
      await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, prompt, {
        slots: [{ id: "alpha", height: 100, spec: "x" }],
        content: { alpha: "<p>original</p>" },
      }, sessionId);

      await saveCredential(page, fake, "test-key-g1");

      fake.queueComplete({ text: "<p>changed</p>" });
      await page.goto("/");
      await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
      await page.fill('#edit-form input[name="instruction"]', "change it");
      await page.selectOption('#edit-form select[name="target"]', "alpha");
      await page.click('#edit-form button[type="submit"]');
      await expect(page.locator("#edit-result")).toContainText("Updated");
      // The fake actually received the call — proves the saved credential, not some other
      // fallback, is what got used.
      expect(fake.requestCount()).toBeGreaterThanOrEqual(2); // validate() + regenerateSlot()
    } finally {
      await fake.close();
    }
  });

  test("G2 — after saving, the credential list shows only a mask, never the key, including after a reload", async ({ page }) => {
    const fake = await startFakeProvider();
    try {
      const apiKey = "sk-g2-secret-value-0123456789";
      await saveCredential(page, fake, apiKey);

      // credentialSaved swaps only #cred-result; the list renders at page load, so the mask appears after a reload.
      let content = await page.content();
      expect(content).not.toContain(apiKey);

      await page.reload();
      content = await page.content();
      expect(content).not.toContain(apiKey);
      await expect(page.locator(".cred-list")).toContainText("····" + apiKey.slice(-4));
      await expect(page.locator('#cred-form input[name="apiKey"]')).toHaveValue("");
    } finally {
      await fake.close();
    }
  });

  // G3 checks both halves: the message is scrubbed AND reaches the DOM. htmx drops 4xx/5xx bodies by default; views.ts swaps them, and this pins it.
  test("G3 — an invalid key is rejected with a readable, scrubbed message that is actually shown", async ({ page }) => {
    const fake = await startFakeProvider();
    try {
      const badKey = "sk-bogus-should-not-leak-anywhere";
      fake.queueError({
        status: 401,
        body: { error: { message: `Incorrect API key provided: ${badKey}`, type: "invalid_request_error" } },
      });

      await page.goto("/settings");
      await page.selectOption('#cred-form select[name="provider"]', "openai");
      await page.fill('#cred-form input[name="apiKey"]', badKey);
      await page.fill('#cred-form input[name="baseUrl"]', fake.baseUrl);
      await page.fill('#cred-form input[name="model"]', "fake-model");

      const [response] = await Promise.all([
        page.waitForResponse(
          (r) => r.url().endsWith("/settings/credentials") && r.request().method() === "POST",
        ),
        page.click('#cred-form button[type="submit"]'),
      ]);

      expect(response.status()).toBe(400);
      const text = await response.text();
      expect(text).not.toContain(badKey);
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain("edit-problem"); // a real editProblem() fragment, readable, not a stack trace

      // The fragment must actually reach the DOM.
      await expect(page.locator("#cred-result .edit-problem")).toHaveCount(1);
      // ...and still carry no trace of the key once it is on the page.
      expect(await page.content()).not.toContain(badKey);
      await expect(page.locator(".empty")).toContainText("No credentials saved");
    } finally {
      await fake.close();
    }
  });

  test("G4 — page source and DOM contain no substring of the credential after saving", async ({ page }) => {
    const fake = await startFakeProvider();
    try {
      const apiKey = "sk-g4-should-never-appear-anywhere-12345";
      await saveCredential(page, fake, apiKey);

      const source = await page.content();
      expect(source).not.toContain(apiKey);
      const dom = await page.evaluate(() => document.documentElement.outerHTML);
      expect(dom).not.toContain(apiKey);
    } finally {
      await fake.close();
    }
  });

  test("G5 — per-role configuration is reflected on the settings page, and stable across a reload", async ({ page }) => {
    // roleConfigTable is read-only and env-driven, so this checks it reflects the server's config.
    await page.goto("/settings");
    const rows = page.locator(".role-table tbody tr");
    await expect(rows).toHaveCount(4);
    const before = await rows.allTextContents();

    await page.reload();
    const after = await page.locator(".role-table tbody tr").allTextContents();
    expect(after).toEqual(before);

    // Each row shows the server's configured model (servers.ts's default, no role override).
    for (const row of before) {
      expect(row).toContain("test-harness-placeholder-model");
    }
  });

  test("G6 — generating with no credential configured shows a clear prompt, not a provider stack trace", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".cred-banner")).toBeVisible();
    await expect(page.locator(".cred-banner")).toContainText("Add a credential");

    const prompt = `G6-${Date.now()}`;
    const { frame } = await submitPrompt(page, prompt);
    const banner = frame.locator("pre");
    await expect(banner).toContainText("Add one in settings");
    const text = (await banner.textContent()) ?? "";
    expect(text).not.toMatch(/at\s+\S+\.(ts|js):\d+/); // no stack-trace-looking lines
  });

  // Like G3: the 500 must be scrubbed and shown.
  test("G7 — a provider 401 during an edit is scrubbed and the failure is actually shown", async ({ page }) => {
    const fake = await startFakeProvider();
    try {
      const apiKey = "sk-g7-should-not-leak-anywhere-999";
      const prompt = `G7-${Date.now()}`;
      const sessionId = await establishAnonSession(page);
      await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, prompt, {
        slots: [{ id: "alpha", height: 100, spec: "x" }],
        content: { alpha: "<p>original</p>" },
      }, sessionId);

      await saveCredential(page, fake, apiKey);

      fake.queueError({
        status: 401,
        body: { error: { message: `Incorrect API key provided: ${apiKey}`, type: "invalid_request_error" } },
      });
      await page.goto("/");
      await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
      await page.fill('#edit-form input[name="instruction"]', "change it");
      await page.selectOption('#edit-form select[name="target"]', "alpha");

      const [response] = await Promise.all([
        page.waitForResponse((r) => /\/generations\/.+\/edits$/.test(r.url()) && r.request().method() === "POST"),
        page.click('#edit-form button[type="submit"]'),
      ]);

      expect(response.status()).toBe(500);
      const bannerText = await response.text();
      expect(bannerText).not.toContain(apiKey);
      expect(bannerText).toContain("edit-problem");

      // The failure must actually be shown, same as G3.
      await expect(page.locator("#edit-result .edit-problem")).toHaveCount(1);

      const pageSource = await page.content();
      expect(pageSource).not.toContain(apiKey);
    } finally {
      await fake.close();
    }
  });

  test("G8 — deleting a credential updates the UI immediately; a later generation still fails cleanly", async ({ page }) => {
    const fake = await startFakeProvider();
    try {
      await saveCredential(page, fake, "test-key-g8");
      // credentialSaved()'s response only swaps #cred-result (see G2's note) — reload to
      // see the credential list itself reflect it before deleting from it.
      await page.reload();
      await expect(page.locator(".cred-list")).toContainText("openai");

      page.on("dialog", (d) => d.accept()); // hx-confirm on the Remove button
      await page.locator(".cred-list li", { hasText: "openai" }).locator("button").click();
      // The delete swaps only that <li>; the <ul> stays but empty, and the empty-state text needs a reload.
      await expect(page.locator(".cred-list li")).toHaveCount(0);

      await page.reload();
      await expect(page.locator(".empty")).toContainText("No credentials saved");

      // Generation ignores the session credential, so this hits the same no-credential path as G6 and must fail cleanly.
      const { frame } = await submitPrompt(page, `G8-${Date.now()}`);
      await expect(frame.locator("pre")).toContainText("Add one in settings");
    } finally {
      await fake.close();
    }
  });

  test("G9 — the same prompt renders through openai and anthropic platform configs alike", async ({ page }) => {
    const plan = planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 });
    const fillChunks = [slotMarker("alpha"), "<p>Alpha</p>\n", slotMarker("beta"), "<p>Beta</p>\n"];

    // One isolated stack per provider, used once and torn down before the next; the caller creates and closes the fake (its baseUrl is needed in env).
    async function renderThroughIsolatedServer(
      fake: FakeProvider,
      env: Record<string, string>,
      prompt: string,
    ): Promise<string> {
      const scratch = await createScratchDatabase();
      try {
        const ports = await findFreePorts(2);
        const [studio, sandbox] = [ports[0]!, ports[1]!];
        const servers = await startServers({
          databaseUrl: scratch.databaseUrl,
          sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
          ports: { studio, sandbox },
          env,
        });
        try {
          fake.queueComplete({ text: plan });
          fake.queueStream({ chunks: fillChunks });
          const { frame } = await submitPrompt(page, prompt, servers.studioOrigin);
          await expect(frame.locator(".anyapp-skeleton")).toHaveCount(0, { timeout: 15_000 });
          return await frame.content();
        } finally {
          await servers.stop();
        }
      } finally {
        await scratch.drop();
      }
    }

    const fakeOpenAI = await startFakeProvider();
    let htmlA: string;
    try {
      htmlA = await renderThroughIsolatedServer(
        fakeOpenAI,
        {
          LLM_PROVIDER: "openai",
          LLM_MODEL: "fake-model",
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: fakeOpenAI.baseUrl,
        },
        `G9-openai-${Date.now()}`,
      );
    } finally {
      await fakeOpenAI.close();
    }

    const fakeAnthropic = await startFakeProvider();
    let htmlB: string;
    try {
      htmlB = await renderThroughIsolatedServer(
        fakeAnthropic,
        {
          LLM_PROVIDER: "anthropic",
          LLM_MODEL: "fake-model",
          ANTHROPIC_API_KEY: "test-key",
          ANTHROPIC_BASE_URL: fakeAnthropic.baseUrl,
        },
        `G9-anthropic-${Date.now()}`,
      );
    } finally {
      await fakeAnthropic.close();
    }

    // Both rendered fully; the provider choice is not visible anywhere in the result.
    expect(htmlA).not.toMatch(/openai|anthropic/i);
    expect(htmlB).not.toMatch(/openai|anthropic/i);
  });
});
