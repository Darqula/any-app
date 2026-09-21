/**
 * D1-D11: the swap() runtime against a static page: no generation, no database, no global-setup servers; each test runs its own tiny http server
 * for a real origin. D3 drives both script paths because swap() from a <template> runs scripts even without rerunScripts, while the postMessage
 * edit path (innerHTML) depends on it entirely. D11 asserts each script runs
 * exactly once on both paths.
 */
import http from "node:http";
import { test, expect } from "@playwright/test";
import { swapRuntime } from "@any-app/protocol";

// The page.evaluate callbacks are browser code, so this needs the DOM lib; tests/frontend has its own tsconfig for that (H2) so DOM globals do not
// leak into server files. The runtime's custom globals still need casts.

type Handler = (req: http.IncomingMessage, res: http.ServerResponse) => void | Promise<void>;

/** Starts a throwaway server and reports its origin, which swapRuntime needs before the port is known. */
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

/** Wraps body markup in a document with the runtime inlined as renderShellHead does. */
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

      // Sub-case 1: swap() pulling a script out of a <template>. Passes even without the recreation loop, so it is not enough alone.
      await page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("x"));
      expect(await page.evaluate(() => (window as unknown as { __initialRan?: boolean }).__initialRan)).toBe(true);

      // Sub-case 2: the edit path (postMessage slot-content, innerHTML). This is the one that depends on rerunScripts.
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

  test("D4 — a slot script with a src attribute loads on both paths; only the postMessage path actually re-creates the element (S16)", async ({ page }) => {
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

      // Sub-case 1: a src-script moved out of a <template>. fill() passes needsRerun:false, so the same element executes on insertion.
      await page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("x"));
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __extRan?: boolean }).__extRan))
        .toBe(true);
      const marker = await page
        .locator("#slot-x script")
        .first()
        .getAttribute("data-marker");
      expect(marker).toBe("carried-over");

      // Sub-case 2: the edit path: needsRerun:true re-creates the script with its attributes copied, proving attribute-copying.
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
    // Out-of-order landing (parallel fill): slot a is first in the document but swap("b") runs before swap("a"). The only browser-side coverage
    // of this now that fill defaults to sequential.
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
    // Shells reach for e.detail.element.querySelector(...). Checks both dispatch paths and that the queried content is real, not just detail.element truthy.
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

  test("D11 — a slot script executes exactly once, not twice (S16), on both swap() and a postMessage edit", async ({ page }) => {
    // Counts executions: a script running twice is loud only in Chart.js ("Canvas is already in use"); double listeners, writes and timers are silent.
    const server = await startServer((getOrigin) => (req, res) => {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(
        pageHtml(
          getOrigin(),
          `<div id="slot-x" class="anyapp-skeleton" style="min-height:40px"></div>
           <template id="c-x"><script>window.__swapRuns = (window.__swapRuns || 0) + 1;</script><p>hi</p></template>`,
        ),
      );
    });
    try {
      await page.goto(server.origin + "/");

      // Sub-case 1: initial fill via swap(). needsRerun must be false: the document-parsed script already ran on insertion.
      await page.evaluate(() => (window as unknown as { swap(id: string): void }).swap("x"));
      // No timers or network here, but wait a beat so an async double run cannot slip past a synchronous read.
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => (window as unknown as { __swapRuns?: number }).__swapRuns)).toBe(1);

      // Sub-case 2: the edit path. needsRerun must be true (innerHTML marks the script started); exactly 1, not >=1, also catches a double run.
      await page.evaluate((appOrigin) => {
        window.postMessage(
          {
            channel: "anyapp",
            type: "slot-content",
            id: "x",
            html: '<script>window.__editRuns = (window.__editRuns || 0) + 1;</script><p>edited</p>',
          },
          appOrigin,
        );
      }, server.origin);
      await expect
        .poll(() => page.evaluate(() => (window as unknown as { __editRuns?: number }).__editRuns))
        .toBe(1);
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => (window as unknown as { __editRuns?: number }).__editRuns)).toBe(1);
    } finally {
      await server.close();
    }
  });
});
