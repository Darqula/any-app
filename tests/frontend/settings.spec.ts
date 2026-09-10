/**
 * G1-G9 — provider settings and BYOK. Every case except G9 runs against the suite's plain
 * shared default server (no platform credential — see global-setup.ts) and uses a
 * session-scoped credential, saved through the real /settings form, pointed at a fake
 * provider created right here in this file's own process. G9 is the one case that
 * genuinely needs the *platform* credential (a fresh generation, not an edit — see below),
 * so it alone spins up its own isolated scratch database + fake provider + studio/sandbox
 * pair on ephemeral ports, twice in sequence (once per provider) — the same shape
 * progressive.spec.ts and error-states.spec.ts use for their real-generation cases, and
 * never touching ports 3000/3001 or this suite's shared database.
 *
 * --- Finding: BYOK session credentials cannot reach a fresh generation --------------------
 *
 * `/internal/generations/:id/stream` (internal.ts) is only ever invoked by the sandbox's
 * server-to-server `/preview/:id` proxy (apps/sandbox/src/index.ts) — a plain `fetch()` with
 * no cookie forwarding at all. `sessionId(req, res)` inside that route therefore always
 * mints a brand-new, credential-less session on every call, regardless of what the browser's
 * own session has saved; `credentialForRole` falls through to the platform credential (or
 * NoCredentialError) every time. A session-scoped BYOK credential can only ever affect a
 * route the BROWSER hits directly on the studio origin — which is the edit route
 * (`POST /generations/:id/edits`, edits.ts) and the router role it resolves, not a fresh
 * generation's planner/fill.
 *
 * tests-frontend.md's G1 ("save a credential... and the app can generate with it") and G7
 * ("generation fails with a provider 401") read as if a session credential drives a fresh
 * generation. Given the above, that's not literally exercisable from the browser — so G1 and
 * G7 below prove the same properties (a saved session credential actually gets used; a
 * provider error surfaces scrubbed) through the edit round trip instead, which IS the real,
 * session-aware consumer. See this task's report for the full write-up. This is a documented
 * adaptation to actual behaviour, not a change to production code.
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

      // credentialSaved()'s response only swaps #cred-result — the credential list itself
      // (credentialList(), rendered once at page load) is not updated out of band, so the
      // mask only becomes visible on a fresh load. Check the immediate response first, then
      // reload and check both the mask and the reload-stability tests-frontend.md's G2 asks
      // for.
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

  // Asserts BOTH halves on purpose: the response is scrubbed (the original point of this
  // case) AND the scrubbed fragment actually reaches the DOM. The second half is new —
  // htmx 2.0.4's shipped default `responseHandling` has `{code:"[45]..",swap:false}`, so
  // every 4xx/5xx `editProblem()` fragment this app returns used to be silently discarded and
  // `#cred-result` just stayed empty (testing-review.md S11). views.ts now ships an
  // `htmx-config` meta that swaps 4xx/5xx too, so a rejected credential is visible again;
  // this case is what pins that, and the scrubbing half stops the fix from turning a
  // now-visible message into a leak.
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

      // The fragment must actually reach the DOM — this is the half that S11 broke.
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
    // FINDING: tests-frontend.md's G5 ("per-role model selectors persist, and are reflected
    // after a reload") reads as an editable per-role UI. The actual page (views.ts's
    // roleConfigTable) is read-only and env-driven — its own doc comment says so ("not yet
    // editable from this page"); there is no selector to set. Adapted to what exists: the
    // table correctly and stably reflects the running server's per-role config. See this
    // task's report.
    await page.goto("/settings");
    const rows = page.locator(".role-table tbody tr");
    await expect(rows).toHaveCount(4);
    const before = await rows.allTextContents();

    await page.reload();
    const after = await page.locator(".role-table tbody tr").allTextContents();
    expect(after).toEqual(before);

    // Every row reflects the running server's actual configured model (servers.ts's default
    // LLM_MODEL, unless a role-specific override is set — none is, on this suite's default).
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

  // Same pairing as G3: the 500 response must be scrubbed AND its fragment must actually be
  // shown. editsRouter.s generic-error branch responds `res.status(500)...send(editProblem(...))`,
  // which htmx.s stock defaults discarded outright (testing-review.md S11) — so a failed edit
  // looked like nothing had happened. views.ts.s htmx-config meta now swaps 4xx/5xx.
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

      // The failure must actually be shown, same as G3 — this is the half S11 broke.
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
      // The delete response swaps just that <li> (hx-target="closest li"), so the
      // surrounding <ul class="cred-list"> stays in the DOM but empty — "immediately" here
      // means the row is gone, not that the page's whole empty-state markup (only ever
      // rendered server-side at page load) reappears without a reload.
      await expect(page.locator(".cred-list li")).toHaveCount(0);

      await page.reload();
      await expect(page.locator(".empty")).toContainText("No credentials saved");

      // A later generation: since generation is session-blind regardless (see this file's
      // header note), this exercises the same "no credential" path G6 checks — the default
      // server has no platform credential either, so it must fail cleanly, not with a
      // stack trace.
      const { frame } = await submitPrompt(page, `G8-${Date.now()}`);
      await expect(frame.locator("pre")).toContainText("Add one in settings");
    } finally {
      await fake.close();
    }
  });

  test("G9 — the same prompt renders through openai and anthropic platform configs alike", async ({ page }) => {
    const plan = planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 });
    const fillChunks = [slotMarker("alpha"), "<p>Alpha</p>\n", slotMarker("beta"), "<p>Beta</p>\n"];

    // One isolated stack per provider, entirely separate from the suite's shared server —
    // see this file's header comment for why a platform credential (not a session one) is
    // required here, and global-setup.ts for why that means an isolated pair rather than a
    // restart of the shared one. `fake` is created by the caller (its `baseUrl` has to be
    // known before the server starts, to put in `env`) and closed by the caller too; this
    // helper owns the scratch database and server pair only. Each stack is spun up, used
    // once, and torn down before the next starts — never overlapping, never touching ports
    // 3000/3001.
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
