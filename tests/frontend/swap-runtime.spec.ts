/**
 * D1–D9 — the `swap()` runtime, unit-tested against a static page. No generation, no
 * database, and (deliberately) no dependency on `global-setup.ts`'s studio/sandbox servers —
 * see `.docs/tests-frontend.md`'s Section D framing. Each test spins up its own tiny,
 * throwaway `http` server so the page has a real origin (needed for D3's postMessage
 * sub-case and D4's external-script fetch) without touching anything under `apps/*`.
 *
 * ## A note on D3, read this before touching `rerunScripts` in swap-runtime.ts
 *
 * The doc comment on `SWAP_RUNTIME`/`rerunScripts` (and CLAUDE.md) frames the recreation
 * loop as existing to defeat "a <script> moved out of a <template> by DOM insertion never
 * executes." That is the right conclusion but, verified empirically against real Chromium
 * before writing this file (a throwaway probe that called the *actual* `swapRuntime` source
 * with `rerunScripts` stubbed to a no-op, both via `page.setContent` and via a real streamed
 * HTTP response shaped exactly like `internal.ts`'s output), it is not quite the right
 * mechanism for the case named literally in the spec:
 *
 *   - `swap(id)` pulling a `<script>` out of a `<template>`'s `.content` (the initial-fill
 *     path — `slotClose()` in packages/protocol/src/slots.ts emits exactly this) executes
 *     the script *even with the recreation loop removed*. A `<template>`'s content, when
 *     parsed as part of the normal document parse (streamed or not) rather than via
 *     `innerHTML`/`insertAdjacentHTML`/the fragment-parsing algorithm, never has its script's
 *     "already started" flag set — so a plain `replaceChildren(fragment)` move into a
 *     connected, scripting-enabled document is enough on its own. Confirmed both via
 *     `page.setContent` and via a real Node `http` server writing the response in two
 *     streamed chunks, matching `internal.ts`'s shape.
 *   - The OTHER call site sharing the same `fill()`/`rerunScripts` code — the postMessage
 *     `"slot-content"` handler, used by every edit (`holder.innerHTML = msg.html`) — is
 *     genuinely, exclusively dependent on the loop. `innerHTML` assignment runs the HTML
 *     fragment-parsing algorithm, which *does* mark any `<script>` inside as "already
 *     started" at parse time, permanently. Confirmed the same script never runs there with
 *     the loop stubbed out, real origin, real postMessage.
 *
 * So D3 below drives BOTH paths through the one running page, not just the one the spec
 * names first — a version of D3 that only exercised `swap()` on a `<template>` would go
 * green even with the loop deleted, and would not be the regression guard the docs describe
 * it as. The edit-path assertion is the one that actually depends on `rerunScripts`.
 */
import http from "node:http";
import { test, expect } from "@playwright/test";
import { swapRuntime } from "@any-app/protocol";

// This file's `page.evaluate(...)` callbacks are real browser-context code (window,
// document, ...), which needs the DOM lib to typecheck as anything but `any`. That used to
// mean a module-scoped `declare const window: any` / `document: any` here instead of a real
// `/// <reference lib="dom" />`: under the single `tsc --build` program that used to include
// this file alongside every server-side one, DOM's ambient globals (e.g. `ReadableStream`)
// leaked into every other file, including apps/sandbox/src/index.ts's unrelated use of the
// Node global of the same name. Fixed properly (testing-review.md H2): `tests/frontend` now
// has its own `tsconfig.json` with the DOM lib enabled, checked as a separate `tsc`
// invocation (`npm run typecheck` runs both), so `window`/`document` below are the real
// `lib.dom` types with no leak anywhere else. The custom globals these tests actually poke
// at (`__initialRan`, `swap`, ...) still need `window as unknown as {...}` casts — that part
// was never about `any` vs. real DOM types, `window`'s own static type does not know about
// this project's runtime-injected properties either way.

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

/** Starts a throwaway HTTP server on 127.0.0.1 and hands the handler a way to read back its
 * own final origin (needed because `swapRuntime` must be built with the exact origin the
 * page is served from, but the port isn't known until the server is already listening). */
async function startServer(
  makeHandler: (getOrigin: () => string) => Handler,
): Promise<{ origin: string; close: () => Promise<void> }> {
  let origin = "";
  const server = http.createServer((req, res) => {
    void makeHandler(() => origin)(req, res);
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
  origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Wraps body markup in a full document with the runtime inlined exactly like
 * `renderShellHead` does (a `<script>` in the head), so these tests exercise the runtime the
 * same way a generated document's shell does. */
function pageHtml(origin: string, body: string): string {
  return `<!doctype html>
<html>
<head><script>${swapRuntime(origin)}</script></head>
<body>
${body}
</body>
</html>`;
}

test.describe("D — the swap() runtime", () => {
  test("D1 — swap(\"x\") with a matching template lands content in #slot-x and removes the template", async ({ page }) => {
    const server = await startServer((getOrigin) => (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        pageHtml(
          getOrigin(),
          `<div id="slot-x" class="anyapp-skeleton" style="min-height:80px"></div>
           <template id="c-x"><p id="landed">hello</p></template>`,
        ),
      );
    });
    try {
      await page.goto(server.origin + "/");
      await page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("x"));
      await expect(page.locator("#slot-x #landed")).toHaveText("hello");
      await expect(page.locator("#c-x")).toHaveCount(0);
    } finally {
      await server.close();
    }
  });

  test("D2 — after swap, the skeleton class is removed and inline min-height is cleared", async ({ page }) => {
    const server = await startServer((getOrigin) => (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        pageHtml(
          getOrigin(),
          `<div id="slot-x" class="anyapp-skeleton" style="min-height:80px"></div>
           <template id="c-x"><p>hi</p></template>`,
        ),
      );
    });
    try {
      await page.goto(server.origin + "/");
      await expect(page.locator("#slot-x")).toHaveClass(/anyapp-skeleton/);
      await page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("x"));
      await expect(page.locator("#slot-x")).not.toHaveClass(/anyapp-skeleton/);
      const minHeight = await page.locator("#slot-x").evaluate((el) => (el as any).style.minHeight); // eslint-disable-line @typescript-eslint/no-explicit-any
      expect(minHeight).toBe("");
    } finally {
      await server.close();
    }
  });

  test("D3 — a <script> inside slot content executes (initial fill AND postMessage edits)", async ({ page }) => {
    const server = await startServer((getOrigin) => (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        pageHtml(
          getOrigin(),
          `<div id="slot-x" class="anyapp-skeleton" style="min-height:40px"></div>
           <template id="c-x"><script>window.__initialRan = true;</script><p>hi</p></template>`,
        ),
      );
    });
    try {
      await page.goto(server.origin + "/");

      // Sub-case 1: the literal case named in the spec — swap() pulling a <script> straight
      // out of a <template>. See this file's header comment: this alone would pass even
      // with the recreation loop deleted, so it is not sufficient on its own.
      await page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("x"));
      expect(await page.evaluate(() => (window as unknown as { __initialRan?: boolean }).__initialRan)).toBe(true);

      // Sub-case 2: the edit path. A real edit has no matching <template> — it arrives as a
      // postMessage "slot-content" payload and lands via `holder.innerHTML = msg.html`
      // (swap-runtime.ts). This is the sub-case that genuinely depends on rerunScripts.
      await page.evaluate((appOrigin) => {
        window.postMessage(
          {
            channel: "anyapp",
            type: "slot-content",
            id: "x",
            html: '<script>window.__editRan = true;</script><p>edited</p>',
          },
          appOrigin,
        );
      }, server.origin);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __editRan?: boolean }).__editRan))
        .toBe(true);
      await expect(page.locator("#slot-x")).toContainText("edited");
    } finally {
      await server.close();
    }
  });

  test("D4 — a slot script with a src attribute: attributes are copied onto the re-created element, and the external script loads (initial fill AND postMessage edits)", async ({ page }) => {
    const server = await startServer((getOrigin) => (req, res) => {
      if (req.url === "/ext.js") {
        res.setHeader("Content-Type", "application/javascript");
        res.end("window.__extRan = true;");
        return;
      }
      if (req.url === "/ext2.js") {
        res.setHeader("Content-Type", "application/javascript");
        res.end("window.__extEditRan = true;");
        return;
      }
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        pageHtml(
          getOrigin(),
          `<div id="slot-x" class="anyapp-skeleton" style="min-height:40px"></div>
           <template id="c-x"><script src="/ext.js" data-marker="carried-over"></script></template>`,
        ),
      );
    });
    try {
      await page.goto(server.origin + "/");

      // Sub-case 1: the literal case named in the spec — swap() pulling a src-script straight
      // out of a <template>. Per S6 (testing-review.md) this alone would still pass even with
      // the recreation loop deleted, so it is not sufficient on its own — same reasoning as
      // D3's sub-case 1.
      await page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("x"));
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __extRan?: boolean }).__extRan))
        .toBe(true);
      const marker = await page
        .locator("#slot-x script")
        .first()
        .getAttribute("data-marker");
      expect(marker).toBe("carried-over");

      // Sub-case 2: the edit path — a postMessage "slot-content" payload carrying a src-script,
      // landing via `holder.innerHTML = msg.html`. This is the sub-case that actually depends
      // on rerunScripts for an external script, mirroring D3's sub-case 2.
      await page.evaluate((appOrigin) => {
        window.postMessage(
          {
            channel: "anyapp",
            type: "slot-content",
            id: "x",
            html: '<script src="/ext2.js" data-marker="carried-over-edit"></script>',
          },
          appOrigin,
        );
      }, server.origin);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __extEditRan?: boolean }).__extEditRan))
        .toBe(true);
      const editMarker = await page
        .locator("#slot-x script")
        .first()
        .getAttribute("data-marker");
      expect(editMarker).toBe("carried-over-edit");
    } finally {
      await server.close();
    }
  });

  test("D5 — slot:ready fires once with the correct detail.id and detail.element", async ({ page }) => {
    const server = await startServer((getOrigin) => (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        pageHtml(
          getOrigin(),
          `<div id="slot-x" class="anyapp-skeleton" style="min-height:40px"></div>
           <template id="c-x"><p>hi</p></template>`,
        ),
      );
    });
    try {
      await page.goto(server.origin + "/");
      await page.evaluate(() => {
        (window as unknown as { __events: Array<{ id: string; isSlotElement: boolean }> }).__events = [];
        document.addEventListener("slot:ready", (event) => {
          const detail = (event as CustomEvent<{ id: string; element: HTMLElement }>).detail;
          (window as unknown as { __events: Array<{ id: string; isSlotElement: boolean }> }).__events.push({
            id: detail.id,
            isSlotElement: detail.element === document.getElementById("slot-x"),
          });
        });
      });
      await page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("x"));
      const events = await page.evaluate(
        () => (window as unknown as { __events: Array<{ id: string; isSlotElement: boolean }> }).__events,
      );
      expect(events).toEqual([{ id: "x", isSlotElement: true }]);
    } finally {
      await server.close();
    }
  });

  test("D6 — two slots swapped in reverse document order both land in the right place", async ({ page }) => {
    // Regression guard for out-of-order landing (Phase 4's parallel fan-out) — the only
    // browser-side coverage of it now that LLM_FILL_MODE defaults to sequential. Slot "a"
    // comes first in the DOM/document, but swap("b") is called before swap("a").
    const server = await startServer((getOrigin) => (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        pageHtml(
          getOrigin(),
          `<div id="slot-a" class="anyapp-skeleton" style="min-height:40px"></div>
           <template id="c-a"><p id="content-a">first-in-dom</p></template>
           <div id="slot-b" class="anyapp-skeleton" style="min-height:40px"></div>
           <template id="c-b"><p id="content-b">second-in-dom</p></template>`,
        ),
      );
    });
    try {
      await page.goto(server.origin + "/");
      await page.evaluate(() => {
        const w = window as unknown as { swap(id: string): void };
        w.swap("b");
        w.swap("a");
      });
      await expect(page.locator("#slot-a #content-a")).toHaveText("first-in-dom");
      await expect(page.locator("#slot-b #content-b")).toHaveText("second-in-dom");
      await expect(page.locator("#c-a")).toHaveCount(0);
      await expect(page.locator("#c-b")).toHaveCount(0);
    } finally {
      await server.close();
    }
  });

  test("D7 — swap(\"nope\"): no such template or slot is a no-op, no exception", async ({ page }) => {
    const server = await startServer((getOrigin) => (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(pageHtml(getOrigin(), `<div id="slot-x">unrelated</div>`));
    });
    try {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));

      await page.goto(server.origin + "/");
      // evaluate() itself would reject if swap("nope") threw inside the page.
      await expect(
        page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("nope")),
      ).resolves.toBeUndefined();

      expect(pageErrors).toEqual([]);
      await expect(page.locator("#slot-x")).toHaveText("unrelated");
    } finally {
      await server.close();
    }
  });

  test("D8 — swap(\"x\") called twice: the second call is a no-op, content is not duplicated", async ({ page }) => {
    const server = await startServer((getOrigin) => (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        pageHtml(
          getOrigin(),
          `<div id="slot-x" class="anyapp-skeleton" style="min-height:40px"></div>
           <template id="c-x"><p>hi</p></template>`,
        ),
      );
    });
    try {
      await page.goto(server.origin + "/");
      await page.evaluate(() => {
        const w = window as unknown as { swap(id: string): void };
        w.swap("x");
        w.swap("x");
      });
      await expect(page.locator("#slot-x p")).toHaveCount(1);
      await expect(page.locator("#slot-x p")).toHaveText("hi");
    } finally {
      await server.close();
    }
  });

  test("D9 — the shell script has already run when a slot script executes", async ({ page }) => {
    // Mirrors renderShellHead's real layout: the shell's own <script> (plan.script) is
    // written into <body> before any slot's <template>/swap() pair.
    const server = await startServer((getOrigin) => (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        pageHtml(
          getOrigin(),
          `<div id="slot-x" class="anyapp-skeleton" style="min-height:40px"></div>
           <script>window.__shellReady = true;</script>
           <template id="c-x"><script>window.__order = window.__shellReady ? "ok" : "bad";</script></template>`,
        ),
      );
    });
    try {
      await page.goto(server.origin + "/");
      await page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("x"));
      const order = await page.evaluate(() => (window as unknown as { __order?: string }).__order);
      expect(order).toBe("ok");
    } finally {
      await server.close();
    }
  });

  test("D10 — slot:ready's detail.element is a live reference the shell can query into (S15)", async ({ page }) => {
    // Regression guard for S15 (testing-review.md): the model's natural instinct is
    // `e.detail.element.querySelector(...)`, not resolving `e.detail.id` back into an
    // element itself. This drives that exact pattern end to end in a real browser, on both
    // dispatch paths that go through `fill()` — the initial swap() from a <template> AND the
    // postMessage "slot-content" edit path — and asserts the queried content is real, not
    // just that `detail.element` is truthy.
    const server = await startServer((getOrigin) => (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        pageHtml(
          getOrigin(),
          `<div id="slot-x" class="anyapp-skeleton" style="min-height:40px"></div>
           <template id="c-x"><form><input name="email"></form></template>`,
        ),
      );
    });
    try {
      await page.goto(server.origin + "/");
      await page.evaluate(() => {
        (window as unknown as { __found: (string | null)[] }).__found = [];
        document.addEventListener("slot:ready", (event) => {
          const detail = (event as CustomEvent<{ id: string; element: HTMLElement }>).detail;
          // The exact shape the model wrote in the wild — reach for the form through the
          // element handed over, immediately, with no separate id-to-element lookup.
          const form = detail.element.querySelector("form");
          (window as unknown as { __found: (string | null)[] }).__found.push(
            form ? form.querySelector("input")?.getAttribute("name") ?? null : null,
          );
        });
      });

      // Sub-case 1: initial fill via swap().
      await page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("x"));

      // Sub-case 2: the edit path — a postMessage "slot-content" payload replacing the slot's
      // content with different markup, so a stale/cached element reference would fail this.
      await page.evaluate((appOrigin) => {
        window.postMessage(
          {
            channel: "anyapp",
            type: "slot-content",
            id: "x",
            html: '<form><input name="phone"></form>',
          },
          appOrigin,
        );
      }, server.origin);

      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __found: (string | null)[] }).__found.length))
        .toBe(2);
      const found = await page.evaluate(() => (window as unknown as { __found: (string | null)[] }).__found);
      expect(found).toEqual(["email", "phone"]);
    } finally {
      await server.close();
    }
  });
});
