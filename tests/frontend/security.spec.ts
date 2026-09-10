/**
 * B1-B10 — security invariants. Every case here runs against a seeded row (no model) except
 * B10, which needs one real edit round trip — the edit route is the one call site that is
 * actually session-aware, so it uses a session-scoped BYOK credential pointed at a fake
 * provider created right here in this file's own process (no server restart needed — see
 * server-control.ts's header comment for why edits, unlike a fresh generation, can use a
 * session credential at all).
 *
 * B3/B4/B6/B7/B8/B9's attack code runs via `frame.evaluate()` rather than a baked-in
 * `<script>` — it executes just as much inside the frame's real origin/sandbox context
 * either way (Playwright's CDP evaluation is subject to the same cross-origin restrictions
 * the frame's own inline scripts would face), and it is far easier to parameterise per test
 * (e.g. B7/B8 need another app's id baked in, known only after that app is seeded).
 */
import { readFile } from "node:fs/promises";
import { test, expect } from "@playwright/test";
import { seedGeneration } from "../harness/seed";
import { startFakeProvider } from "../harness/fake-provider";
import { HANDOFF_PATH } from "./global-setup";
import {
  buildStaticDoc,
  seedFilledApp,
  openSidebarApp,
  waitForFrameBySrc,
  establishAnonSession,
  appOriginFor,
  STUDIO_ORIGIN,
} from "./doc-builder";

const { databaseUrl, appTokenSecret } = JSON.parse(await readFile(HANDOFF_PATH, "utf8")) as {
  databaseUrl: string;
  appTokenSecret: string;
};

test.describe("B — security invariants", () => {
  // B1 and B2 are written to check BOTH properties (per-app origin AND allow-same-origin
  // together) so a regression in EITHER half takes BOTH tests red, not just the one whose
  // "own" property broke — see .docs/tests-frontend.md: allow-same-origin is only safe
  // because the origin is per-app, and either half alone looks perfectly reasonable.
  test("B1 — preview iframe src host is the per-app origin, never studio's own (paired with B2)", async ({ page }) => {
    const prompt = `B1-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, { prompt, document: buildStaticDoc("b1"), sessionId });
    await page.goto("/");
    await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
    const iframe = page.locator("#stage iframe");
    const src = await iframe.getAttribute("src");
    expect(src).not.toBeNull();
    const host = new URL(src!).host;
    expect(host).not.toBe("localhost:3000");
    expect(host).toMatch(/^[0-9a-f-]{36}\.apps\.localhost:3001$/);

    // Paired assertion — see B2's own test and the file header comment.
    const sandboxAttr = (await iframe.getAttribute("sandbox")) ?? "";
    const tokens = sandboxAttr.split(/\s+/);
    expect(tokens).toContain("allow-scripts");
    expect(tokens).toContain("allow-same-origin");
  });

  test("B2 — sandbox attribute carries allow-same-origin, safe only because B1's origin is per-app", async ({ page }) => {
    const prompt = `B2-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, { prompt, document: buildStaticDoc("b2"), sessionId });
    await page.goto("/");
    await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
    const iframe = page.locator("#stage iframe");
    const sandboxAttr = (await iframe.getAttribute("sandbox")) ?? "";
    const tokens = sandboxAttr.split(/\s+/);
    expect(tokens).toContain("allow-scripts");
    expect(tokens).toContain("allow-same-origin");

    // Paired assertion — see B1's own test and the file header comment.
    const src = await iframe.getAttribute("src");
    const host = new URL(src!).host;
    expect(host).not.toBe("localhost:3000");
    expect(host).toMatch(/^[0-9a-f-]{36}\.apps\.localhost:3001$/);
  });

  test("B3 — a generated app reads document.cookie: empty, even after a studio session cookie exists", async ({ page }) => {
    await page.goto("/"); // sets anyapp_session on localhost:3000
    const cookies = await page.context().cookies("http://localhost:3000");
    const sessionCookie = cookies.find((c) => c.name === "anyapp_session");
    expect(sessionCookie).toBeTruthy();

    const prompt = `B3-${Date.now()}`;
    await seedGeneration(databaseUrl, { prompt, document: buildStaticDoc("b3"), sessionId: sessionCookie!.value });
    const { frame } = await openSidebarApp(page, prompt);
    const cookie = await frame.evaluate(() => document.cookie);
    expect(cookie).toBe("");
  });

  test("B4 — window.parent.document throws a cross-origin SecurityError", async ({ page }) => {
    const prompt = `B4-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, { prompt, document: buildStaticDoc("b4"), sessionId });
    const { frame } = await openSidebarApp(page, prompt);
    const result = await frame.evaluate(() => {
      try {
        // Accessing .document on a cross-origin Window is what throws — merely referencing
        // window.parent itself would not.
        void window.parent.document;
        return { threw: false, name: null as string | null };
      } catch (e) {
        return { threw: true, name: (e as Error).name };
      }
    });
    expect(result.threw).toBe(true);
    expect(result.name).toBe("SecurityError");
  });

  test("B5 — a localStorage write succeeds and persists; a second app on a different origin sees nothing", async ({ page }) => {
    const promptA = `B5-A-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, { prompt: promptA, document: buildStaticDoc("b5-a"), sessionId });
    const { frame, src } = await openSidebarApp(page, promptA);

    const before = await frame.evaluate(() => localStorage.getItem("b5-key"));
    expect(before).toBeNull();
    await frame.evaluate(() => localStorage.setItem("b5-key", "secret-value"));

    // Reload the SAME app — clicking the sidebar entry again swaps in a fresh iframe with
    // the same src, forcing a real re-navigation — and confirm the write persisted.
    await page.locator("#generation-list li", { hasText: promptA }).locator("button").click();
    const frame2 = await waitForFrameBySrc(page, src, { excludeFrame: frame });
    const after = await frame2.evaluate(() => localStorage.getItem("b5-key"));
    expect(after).toBe("secret-value");

    // A second, different app — a different per-app origin — never sees it. Per-app
    // origins, not per-app nothing.
    const promptB = `B5-B-${Date.now()}`;
    await seedGeneration(databaseUrl, { prompt: promptB, document: buildStaticDoc("b5-b"), sessionId });
    const { frame: frameB } = await openSidebarApp(page, promptB);
    const seenByB = await frameB.evaluate(() => localStorage.getItem("b5-key"));
    expect(seenByB).toBeNull();
  });

  test("B6 — a generated app's fetch to a studio endpoint is blocked by CORS", async ({ page }) => {
    const prompt = `B6-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedGeneration(databaseUrl, { prompt, document: buildStaticDoc("b6"), sessionId });
    const { frame } = await openSidebarApp(page, prompt);
    const result = await frame.evaluate(async () => {
      try {
        const r = await fetch("http://localhost:3000/health");
        return { blocked: false, status: r.status };
      } catch (e) {
        return { blocked: true, name: (e as Error).name };
      }
    });
    expect(result.blocked).toBe(true);
  });

  test("B7 — App A cannot fetch App B's preview HTML (blocked by CORS, so it cannot read B's token out of it)", async ({ page }) => {
    const promptB = `B7-B-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    const seededB = await seedGeneration(databaseUrl, { prompt: promptB, document: buildStaticDoc("b7-target"), sessionId });
    const promptA = `B7-A-${Date.now()}`;
    await seedGeneration(databaseUrl, { prompt: promptA, document: buildStaticDoc("b7-attacker"), sessionId });

    const { frame } = await openSidebarApp(page, promptA);
    const targetUrl = `${appOriginFor(seededB.id)}/preview/${seededB.id}`;
    const result = await frame.evaluate(async (url) => {
      try {
        const r = await fetch(url);
        const text = await r.text();
        return { blocked: false, length: text.length };
      } catch (e) {
        return { blocked: true, name: (e as Error).name };
      }
    }, targetUrl);
    expect(result.blocked).toBe(true);
  });

  test("B8 — the preview URL opened directly renders on its own origin; the cross-fetch B7 blocks is unavailable here too", async ({ page }) => {
    const promptC = `B8-C-${Date.now()}`;
    const seededC = await seedGeneration(databaseUrl, { prompt: promptC, document: buildStaticDoc("b8-target") });
    const promptDirect = `B8-direct-${Date.now()}`;
    const seededDirect = await seedGeneration(databaseUrl, {
      prompt: promptDirect,
      document: buildStaticDoc("b8-direct"),
    });

    await page.goto(`${appOriginFor(seededDirect.id)}/preview/${seededDirect.id}`);
    await expect(page).toHaveTitle("b8-direct");

    const targetUrl = `${appOriginFor(seededC.id)}/preview/${seededC.id}`;
    const result = await page.evaluate(async (url) => {
      try {
        const r = await fetch(url);
        const text = await r.text();
        return { blocked: false, length: text.length };
      } catch (e) {
        return { blocked: true, name: (e as Error).name };
      }
    }, targetUrl);
    expect(result.blocked).toBe(true);
  });

  test("B9 — a same-origin fetch to this app's own /data/... from inside the frame succeeds (no CORS involved)", async ({ page }) => {
    const prompt = `B9-${Date.now()}`;
    const sessionId = await establishAnonSession(page);
    await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, prompt, {
      collections: [{ name: "things", description: "test" }],
    }, sessionId);
    const { frame } = await openSidebarApp(page, prompt);
    const result = await frame.evaluate(async () => {
      try {
        const r = await (window as unknown as { anyapp: { data: { create: Function } } }).anyapp.data.create(
          "things",
          { n: 1 },
        );
        return { ok: true, hasId: typeof (r as { id?: unknown }).id === "string" };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    });
    expect(result.ok).toBe(true);
    expect(result.hasId).toBe(true);
  });

  // Was `test.fixme` while testing-review.md's S10 stood: homePage()'s inline <script> wrote
  // its route regex as a literal inside a template literal, where `\/` is not a real escape
  // sequence — the backslashes were dropped on the way out, the served line became a `//`
  // comment, and the resulting syntax error killed the parse of the WHOLE block. That left
  // anyappFrameFor / anyappApplyEdit / anyappBeforeEdit all undefined on every homepage load,
  // so this case's premise (an edit's postMessage reaching the frame) could not happen at
  // all. views.ts now builds that regex with `new RegExp(...)`, which needs no backslash and
  // so cannot regress the same way; this case is live again and is what pins it.
  test('B10 — an applied edit\'s postMessage names the app\'s exact origin, never "*"', async ({ page }) => {
    const fake = await startFakeProvider();
    try {
      const prompt = `B10-${Date.now()}`;
      const slotId = "alpha";
      const sessionId = await establishAnonSession(page);
      const { id } = await seedFilledApp(databaseUrl, appTokenSecret, STUDIO_ORIGIN, prompt, {
        slots: [{ id: slotId, height: 100, spec: "test region" }],
        content: { [slotId]: "<p>original</p>" },
      }, sessionId);

      // Instrumented on the STUDIO (parent) side, not inside the frame. The property under
      // test is the `targetOrigin` argument the parent passes, and that call goes through a
      // *cross-origin* WindowProxy: patching `window.postMessage` inside the frame cannot
      // see it, because a cross-origin WindowProxy only ever exposes the original native
      // `postMessage`, never an own-property override made on the frame's own global. (An
      // earlier version of this case did exactly that and could never have passed — the
      // messages arrive, `__lastPostMessage` just stays undefined.) Listening for `message`
      // inside the frame does not work either: `event.origin` is the *sender's* origin, and
      // delivery alone cannot tell an exact targetOrigin apart from "*", which also
      // delivers. So wrap the getter the parent actually calls through.
      //
      // addInitScript, not evaluate: this has to survive the `page.goto("/")` below and be
      // in place before htmx swaps in the response that calls anyappApplyEdit().
      await page.addInitScript(() => {
        const sent: { data: unknown; origin: string }[] = [];
        (window as unknown as { __sentPostMessages: unknown[] }).__sentPostMessages = sent;
        const desc = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
        const realGet = desc?.get;
        if (!realGet) return;
        Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
          configurable: true,
          get(this: HTMLIFrameElement) {
            const win = realGet.call(this) as Window | null;
            if (!win) return win;
            return new Proxy(win, {
              get(target, prop, receiver) {
                if (prop === "postMessage") {
                  return (data: unknown, origin: string) => {
                    sent.push({ data, origin });
                    return (target as Window).postMessage(data as never, origin);
                  };
                }
                return Reflect.get(target, prop, receiver);
              },
            });
          },
        });
      });

      await openSidebarApp(page, prompt);

      // The edit route (unlike a fresh generation — see B9/H5's contrast, and this task's
      // report) is reached directly by the browser, so it DOES see this session's cookie
      // and its saved credential.
      await page.goto("/settings");
      await page.selectOption('#cred-form select[name="provider"]', "openai");
      await page.fill('#cred-form input[name="apiKey"]', "test-key-b10");
      await page.fill('#cred-form input[name="baseUrl"]', fake.baseUrl);
      await page.fill('#cred-form input[name="model"]', "fake-model");
      fake.queueComplete({ text: "ok" }); // satisfies build(credential).validate(model)
      await page.click('#cred-form button[type="submit"]');
      await expect(page.locator("#cred-result")).toContainText("Saved and validated");

      fake.queueComplete({ text: "<p>replaced</p>" }); // regenerateSlot's edit-role call
      await page.goto("/");
      await page.locator("#generation-list li", { hasText: prompt }).locator("button").click();
      const src = await page.locator("#stage iframe").getAttribute("src");
      await waitForFrameBySrc(page, src!);

      await page.fill('#edit-form input[name="instruction"]', "change the text");
      await page.selectOption('#edit-form select[name="target"]', slotId);
      await page.click('#edit-form button[type="submit"]');
      await expect(page.locator("#edit-result")).toContainText("Updated");

      // The applied edit's own push (type "slot-content"), not anyappBeforeEdit's earlier
      // "slot-pending" — both go through the same pinned-origin path, but this case is
      // specifically about the one carrying the edit result.
      const sent = await page.evaluate(
        () =>
          (window as unknown as { __sentPostMessages: { data: { type?: string }; origin: string }[] })
            .__sentPostMessages,
      );
      const applied = sent.find((m) => m.data?.type === "slot-content");
      expect(applied, `no slot-content postMessage was sent; saw ${JSON.stringify(sent)}`).toBeTruthy();
      expect(applied!.origin).not.toBe("*");
      expect(applied!.origin).toBe(appOriginFor(id));
    } finally {
      await fake.close();
    }
  });
});
