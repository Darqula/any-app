/**
 * C1-C8 — progressive rendering. C1 runs against a seeded row on the suite's shared default
 * server. C2-C8 need a real generation streamed through the fake provider, which means the
 * *platform* credential (see global-setup.ts's header comment for why a session credential
 * cannot reach planner/fill) — so this file spins up its OWN isolated scratch database, fake
 * provider, and studio/sandbox pair on ephemeral ports, entirely separate from the shared
 * server every other spec file uses. That pair never touches ports 3000/3001, so it cannot
 * contend with (or be contended with by) any other spec file regardless of run order.
 *
 * One fake provider for the whole C2-C8 group, created once in `beforeAll` (so its `baseUrl`
 * is known before the isolated server starts, to wire into its env) and reused by every test
 * — tests run serially (playwright.config.ts), so each one just queues exactly what it
 * expects right before triggering its own generation; the FIFO queue never has to span two
 * tests' worth of ambiguity.
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
import { buildFilledDocument, submitPrompt, planText, slotMarker, SHELL_2_SLOTS, SLOTS_2, openSidebarApp, establishAnonSession } from "./doc-builder";

const { databaseUrl } = JSON.parse(await readFile(HANDOFF_PATH, "utf8")) as { databaseUrl: string };

test.describe("C — progressive rendering", () => {
  test("C1 — preview document compatMode is CSS1Compat, not quirks mode", async ({ page }) => {
    const prompt = `C1-${Date.now()}`;
    const { document: html } = buildFilledDocument("c1-app", "unused-secret", "http://localhost:3000", {
      slots: [{ id: "alpha", height: 100, spec: "x" }],
    });
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, { prompt, document: html, sessionId });
    const { frame } = await openSidebarApp(page, prompt);
    const compatMode = await frame.evaluate(() => document.compatMode);
    expect(compatMode).toBe("CSS1Compat");
  });

  test.describe("C2-C8 (real generations, isolated server)", () => {
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

    test("C2 — a fake stalled after the shell: layout painted, skeleton count == slot count, no slot content yet", async ({ page }) => {
      fake.queueComplete({ text: planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 }) });
      fake.queueStream(); // manual mode (chunks omitted): stays open until this test says otherwise

      const { frame } = await submitPrompt(page, `C2-${Date.now()}`, servers.studioOrigin);
      // A generous timeout on this first isolated-server assertion — a freshly-spawned tsx
      // child process's first real request (DB pool warm-up, JIT) can be slower than later
      // ones in the same file; this bounds that without weakening what's being checked.
      await expect(frame.locator(".anyapp-skeleton")).toHaveCount(2, { timeout: 15_000 });
      await expect(frame.locator("#slot-alpha")).toHaveClass(/anyapp-skeleton/);
      await expect(frame.locator("#slot-beta")).toHaveClass(/anyapp-skeleton/);
      const alphaText = (await frame.locator("#slot-alpha").textContent()) ?? "";
      expect(alphaText.trim()).toBe("");
    });

    test("C3 — first painted layout arrives within budget of the scripted planner latency", async ({ page }) => {
      const delayMs = 600;
      fake.queueComplete({ text: planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 }), delayMs });
      const handle = fake.queueStream();

      const start = Date.now();
      const { frame } = await submitPrompt(page, `C3-${Date.now()}`, servers.studioOrigin);
      await expect(frame.locator(".anyapp-skeleton")).toHaveCount(2, { timeout: delayMs + 4000 });
      const elapsed = Date.now() - start;
      expect(elapsed).toBeLessThan(delayMs + 4000);

      await handle.finish();
    });

    test("C4 — slots are released one at a time, never all at once", async ({ page }) => {
      fake.queueComplete({ text: planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 }) });
      const handle = fake.queueStream();

      const { frame } = await submitPrompt(page, `C4-${Date.now()}`, servers.studioOrigin);
      await expect(frame.locator(".anyapp-skeleton")).toHaveCount(2);

      await handle.emit(slotMarker("alpha") + "<p>Alpha</p>\n");
      // The marker for beta is what CLOSES alpha's template (slot-stream.ts only closes a
      // slot when the next marker — or flush — arrives), so alpha only swaps in here.
      await handle.emit(slotMarker("beta"));
      await expect(frame.locator(".anyapp-skeleton")).toHaveCount(1);
      await expect(frame.locator("#slot-alpha")).not.toHaveClass(/anyapp-skeleton/);
      await expect(frame.locator("#slot-beta")).toHaveClass(/anyapp-skeleton/);

      await handle.emit("<p>Beta</p>\n");
      await handle.finish(); // triggers slotStream.flush(), closing beta
      await expect(frame.locator(".anyapp-skeleton")).toHaveCount(0);
    });

    test("C5 — after the last slot: zero skeletons remain", async ({ page }) => {
      fake.queueComplete({ text: planText({ shell: SHELL_2_SLOTS, slots: SLOTS_2 }) });
      fake.queueStream({ chunks: [slotMarker("alpha"), "<p>Alpha</p>\n", slotMarker("beta"), "<p>Beta</p>\n"] });

      const { frame } = await submitPrompt(page, `C5-${Date.now()}`, servers.studioOrigin);
      await expect(frame.locator(".anyapp-skeleton")).toHaveCount(0);
    });

    test("C6 — Phase 1 linear path: content is visible while the response is still open", async ({ page }) => {
      // A plan missing every required section forces PlanError, which falls back to the
      // linear path (internal.ts's runLinearFallback) — the one that streams raw HTML with
      // no buffering.
      fake.queueComplete({ text: "not a valid plan, no sections here at all" });
      const handle = fake.queueStream();

      const { frame } = await submitPrompt(page, `C6-${Date.now()}`, servers.studioOrigin);
      // runLinearFallback wraps the stream in createTrailingFenceGuard, which holds back
      // the LAST 16 bytes emitted so far (to catch a trailing markdown fence split across
      // chunks) — so the marker text needs trailing padding to actually clear that window
      // before the response ends. An HTML comment is inert (no visible/DOM effect on
      // #c6-marker itself) and stands in for "more text arrives after", same as real output.
      await handle.emit(
        '<html><body><p id="c6-marker">Streaming content, live</p><!-- ' + "x".repeat(24) + " -->",
      );

      // The response is still open — finish() has not been called yet — and the text must
      // already be on screen. This is the assertion that must never regress: a change that
      // buffers the response still renders correctly only AFTER it ends, which is exactly
      // what would slip past a check made only at that point.
      await expect(frame.locator("#c6-marker")).toHaveText("Streaming content, live");

      await handle.finish();
    });

    test("C7 — a trailing markdown fence in the model output is never visible on screen", async ({ page }) => {
      fake.queueComplete({ text: "not a valid plan either" }); // -> linear fallback
      const handle = fake.queueStream();

      const { frame } = await submitPrompt(page, `C7-${Date.now()}`, servers.studioOrigin);
      // Same createTrailingFenceGuard holdback as C6 — pad past its 16-byte window before
      // asserting visibility, or the assertion is checking bytes that were never released.
      await handle.emit('<html><body><p id="c7">Hello world</p><!-- ' + "x".repeat(24) + " -->");
      await expect(frame.locator("#c7")).toHaveText("Hello world");

      await handle.emit("\n```"); // trailing fence — createTrailingFenceGuard holds this back
      await page.waitForTimeout(200);
      const midBody = await frame.evaluate(() => document.body.textContent ?? "");
      expect(midBody).not.toContain("```");

      await handle.finish();
      const finalBody = await frame.evaluate(() => document.body.textContent ?? "");
      expect(finalBody).not.toContain("```");
    });

    test("C8 — skeleton height approximates filled height: a footer below the slots moves little", async ({ page }) => {
      const shellWithFooter = `${SHELL_2_SLOTS}<footer id="page-footer">Bottom</footer>`;
      fake.queueComplete({ text: planText({ shell: shellWithFooter, slots: SLOTS_2 }) });
      const handle = fake.queueStream();

      const { frame } = await submitPrompt(page, `C8-${Date.now()}`, servers.studioOrigin);
      await expect(frame.locator(".anyapp-skeleton")).toHaveCount(2);
      const before = await frame.locator("#page-footer").boundingBox();
      expect(before).not.toBeNull();

      // Separate <p> elements, not one <p> with embedded newlines — HTML collapses interior
      // "\n" to a single space, so a single paragraph would render far shorter than either
      // declared skeleton height regardless of how good the planner's estimate was. This
      // shape is what makes the height comparison below meaningful instead of testing this
      // fixture's own mismatch.
      await handle.emit(slotMarker("alpha") + "<p>Alpha content line.</p>\n".repeat(5));
      await handle.emit(slotMarker("beta") + "<p>Beta content line.</p>\n".repeat(3));
      await handle.finish();
      await expect(frame.locator(".anyapp-skeleton")).toHaveCount(0);

      const after = await frame.locator("#page-footer").boundingBox();
      expect(after).not.toBeNull();
      const delta = Math.abs(after!.y - before!.y);
      // Generous on purpose — this catches a planner that stopped estimating heights
      // entirely, not small inaccuracies. Paragraph margins/line-height mean even
      // reasonably-matched content won't land pixel-exact on the declared skeleton height.
      expect(delta).toBeLessThan(280);
    });
  });
});
