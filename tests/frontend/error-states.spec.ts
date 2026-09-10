/**
 * E1-E8 — error and edge states. E5 and E7 run against seeded rows on the suite's shared
 * default server. E1-E4, E6, E8 need a real generation through the fake provider, so — same
 * as progressive.spec.ts's C2-C8 — this file spins up its OWN isolated scratch database,
 * fake provider, and studio/sandbox pair on ephemeral ports (see global-setup.ts's header
 * comment for why: a session-scoped BYOK credential cannot reach a fresh generation's
 * planner/fill, only the platform credential this isolated server is configured with can).
 */
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { seedGeneration } from "../harness/seed";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import type { RunningServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { HANDOFF_PATH } from "./global-setup";
import {
  buildFilledDocument,
  submitPrompt,
  openSidebarApp,
  establishAnonSession,
  planText,
  slotMarker,
  SHELL_2_SLOTS,
  SLOTS_2,
  STUDIO_ORIGIN,
  isKnownStudioHomepageSyntaxBug,
} from "./doc-builder";

const { databaseUrl } = JSON.parse(await readFile(HANDOFF_PATH, "utf8")) as { databaseUrl: string };

test.describe("E — error and edge states", () => {
  test("E5 — replay of a completed app renders fully, with no skeletons at any point", async ({ page }) => {
    const prompt = `E5-${Date.now()}`;
    const { document } = buildFilledDocument("e5-app", "unused-secret", STUDIO_ORIGIN, {
      slots: [{ id: "alpha", height: 100, spec: "x" }],
      content: { alpha: "<p>done</p>" },
    });
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, { prompt, document, sessionId });
    const { frame } = await openSidebarApp(page, prompt);
    await expect(frame.locator(".anyapp-skeleton")).toHaveCount(0);
    await expect(frame.locator("#slot-alpha")).toContainText("done");
  });

  test("E7 — an unknown generation id: frame shows 'Preview unavailable', studio does not error", async ({ page }) => {
    // Runs on the shared default server directly (not this file's isolated stack below) —
    // it only needs a plain sandbox host, no generation, no credential.
    const fakeId = "00000000-0000-4000-8000-000000000000";
    await page.goto(`http://${fakeId}.apps.localhost:3001/preview/${fakeId}`);
    await expect(page.locator("body")).toContainText("Preview unavailable");

    // Studio itself must not have errored — a fresh request still works normally.
    await page.goto("/");
    await expect(page.locator("#generation-list")).toBeVisible();
  });

  test.describe("E1-E4, E6, E8 (real generations, isolated server)", () => {
    let scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
    let servers: RunningServers;
    let fake: FakeProvider;

    test.beforeAll(async () => {
      scratch = await createScratchDatabase();
      const ports = await findFreePorts(2);
      const [studio, sandbox] = [ports[0]!, ports[1]!];
      fake = await startFakeProvider();
      servers = await startServers({
        databaseUrl: scratch.databaseUrl,
        sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
        ports: { studio, sandbox },
        env: {
          LLM_PROVIDER: "openai",
          LLM_MODEL: "fake-model",
          OPENAI_API_KEY: "test-key",
          OPENAI_BASE_URL: fake.baseUrl,
        },
      });
    });

    test.afterAll(async () => {
      await fake.close();
      await servers.stop();
      await scratch.drop();
    });

    test("E1 — a generation that fails mid-stream shows a red error banner inside the frame", async ({ page }) => {
      fake.queueComplete({ text: planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 }) });
      fake.queueError({ status: 500 });

      const { frame } = await submitPrompt(page, `E1-${Date.now()}`, servers.studioOrigin);
      const banner = frame.locator("pre", { hasText: "Generation failed" });
      await expect(banner).toBeVisible();
      const style = (await banner.getAttribute("style")) ?? "";
      expect(style).toContain("b00020");
    });

    test("E2 — a failure after the shell was written keeps the shell and appends the banner below it", async ({ page }) => {
      fake.queueComplete({ text: planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 }) });
      fake.queueError({ status: 500 });

      const { frame } = await submitPrompt(page, `E2-${Date.now()}`, servers.studioOrigin);
      await expect(frame.locator(".anyapp-skeleton")).toHaveCount(2); // the shell painted, unfilled
      const banner = frame.locator("pre", { hasText: "Generation failed" });
      await expect(banner).toBeVisible();

      const order = await frame.evaluate(() =>
        Array.from(document.querySelectorAll(".anyapp-skeleton, pre")).map((n) =>
          n.classList.contains("anyapp-skeleton") ? "skeleton" : "banner",
        ),
      );
      expect(order).toEqual(["skeleton", "skeleton", "banner"]);
    });

    test("E3 — a concurrent duplicate request shows an 'Already generating' page with a meta refresh", async ({ page, context }) => {
      fake.queueComplete({ text: planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 }) });
      const handle = fake.queueStream(); // left open — the first request is still "in progress"

      // `src`, not a hand-built `/preview/${id}` — it already carries the Phase 6 view grant
      // (`?g=...`) `previewFrame` minted for the FIRST page's own iframe. The second page
      // shares this context's cookie jar (`context.newPage()`, not a fresh browser context),
      // but that cookie is host-only on studio's origin and never reaches the sandbox's — the
      // grant in the URL is the only thing that authorizes this direct navigation to a
      // (default-private) generation it does not own.
      const { src } = await submitPrompt(page, `E3-${Date.now()}`, servers.studioOrigin);

      const second = await context.newPage();
      await second.goto(src);
      await expect(second.locator("body")).toContainText("Already generating");
      await expect(second.locator('meta[http-equiv="refresh" i]')).toHaveCount(1);

      await second.close();
      await handle.finish();
    });

    test("E4 — after the first generation finishes, the 'Already generating' page's refresh shows the finished app", async ({
      page,
      context,
    }) => {
      fake.queueComplete({ text: planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 }) });
      const handle = fake.queueStream();

      // See E3's comment: reuse the grant-bearing `src`, not a hand-built preview URL.
      const { src } = await submitPrompt(page, `E4-${Date.now()}`, servers.studioOrigin);

      const second = await context.newPage();
      await second.goto(src);
      await expect(second.locator("body")).toContainText("Already generating");

      await handle.emit(slotMarker("alpha") + "<p>Alpha</p>\n" + slotMarker("beta") + "<p>Beta</p>\n");
      await handle.finish();

      // The page's own <meta http-equiv="refresh" content="2"> does the reload — real
      // wall-clock, not something Playwright accelerates — so just wait for its effect.
      await expect(second.locator(".anyapp-skeleton")).toHaveCount(0, { timeout: 8000 });
      await second.close();
    });

    test("E6 — replay vs. streamed render: equivalent after both settle (screenshot, not markup)", async ({ page, context }) => {
      fake.queueComplete({ text: planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 }) });
      fake.queueStream({
        chunks: [slotMarker("alpha"), "<p>Alpha content</p>\n", slotMarker("beta"), "<p>Beta content</p>\n"],
      });

      const prompt = `E6-${Date.now()}`;
      const { frame: streamedFrame } = await submitPrompt(page, prompt, servers.studioOrigin);
      await expect(streamedFrame.locator(".anyapp-skeleton")).toHaveCount(0);
      const streamedShot = await streamedFrame.locator("body").screenshot();

      // Replay the SAME, now-complete generation via a SECOND studio page — through the
      // sidebar, the same way a real viewer would reopen it — rather than opening the
      // sandbox's preview URL directly in a bare tab. That distinction turned out to
      // matter for this comparison: opened directly, the "replay" page renders at the
      // full browser viewport width, while the "streamed" one renders inside studio's
      // iframe (narrower — studio's own grid layout reserves a 320px sidebar), so the
      // same content wraps differently and a pixel comparison would never agree
      // regardless of markup equivalence. Going through the sidebar on both sides puts
      // them in the same iframe layout context, which is the actual thing this case
      // means by "equivalent" (see .docs/tests-frontend.md: renderDocument emits slots in
      // plan order while the live stream completes in completion order — Phase 4 dropped
      // the old byte-identical guarantee on purpose, since swap() is order-independent;
      // this checks that the resulting *rendering* still agrees, not the markup).
      const replayPage = await context.newPage();
      const { frame: replayFrame } = await openSidebarApp(replayPage, prompt, servers.studioOrigin);
      await expect(replayFrame.locator(".anyapp-skeleton")).toHaveCount(0);
      const replayShot = await replayFrame.locator("body").screenshot();
      await replayPage.close();

      expect(Buffer.compare(streamedShot, replayShot)).toBe(0);
    });

    test("E8 — closing the tab mid-generation: no console errors, and studio stays responsive after", async ({ page, context }) => {
      const consoleErrors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => consoleErrors.push(String(err)));

      fake.queueComplete({ text: planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 }) });
      const handle = fake.queueStream(); // left open

      await submitPrompt(page, `E8-${Date.now()}`, servers.studioOrigin);
      await expect(page.locator("#stage iframe")).toHaveCount(1);

      await page.close(); // the viewer closes the tab mid-generation
      // Filters one specific, already-reported production error (see doc-builder.ts's
      // isKnownStudioHomepageSyntaxBug) that fires on every studio homepage load,
      // unrelated to this case's actual concern (the abandoned generation itself).
      expect(consoleErrors.filter((e) => !isKnownStudioHomepageSyntaxBug(e))).toEqual([]);

      // Studio itself must still be responsive to a fresh request afterward.
      const fresh = await context.newPage();
      await fresh.goto(servers.studioOrigin + "/");
      await expect(fresh.locator("#generation-list")).toBeVisible();
      await fresh.close();

      await handle.finish().catch(() => {}); // best-effort cleanup; likely already aborted server-side
    });
  });
});
