/**
 * D10 — the inlined data runtime (`dataRuntime(token)`, packages/protocol/src/data-runtime.ts).
 * Same posture as swap-runtime.spec.ts: no generation, no database, no dependency on
 * global-setup.ts's servers. A throwaway `http` server plays the sandbox's `/data/*` API so
 * the real request headers/bodies can be inspected server-side, which is at least as direct
 * as intercepting with Playwright's own routing.
 */
import http from "node:http";
import { test, expect } from "@playwright/test";
import { dataRuntime } from "@any-app/protocol";

// See swap-runtime.spec.ts's header comment: `window` below is the real `lib.dom` type now
// (tests/frontend has its own tsconfig.json with DOM enabled, checked separately — see
// testing-review.md H2), not a module-scoped `declare const window: any`. The custom
// `anyapp.data.*` surface this file pokes at still needs `window as unknown as {...}` casts,
// same as before.

interface SeenRequest {
  method: string;
  url: string;
  authorization: string | null;
  contentType: string | null;
  body: string;
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

/** Starts a throwaway server serving one HTML page (with `dataRuntime(token)` inlined) plus
 * a `/data/*` fake API, and records every request it receives. */
async function startFixture(
  token: string,
): Promise<{ origin: string; seen: SeenRequest[]; close: () => Promise<void> }> {
  const seen: SeenRequest[] = [];
  const server = http.createServer(async (req, res) => {
    if (req.url === "/") {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.end(`<!doctype html><html><head><script>${dataRuntime(token)}</script></head><body></body></html>`);
      return;
    }

    if (req.url?.startsWith("/data/")) {
      const body = await readBody(req);
      seen.push({
        method: req.method ?? "",
        url: req.url,
        authorization: (req.headers.authorization as string | undefined) ?? null,
        contentType: (req.headers["content-type"] as string | undefined) ?? null,
        body,
      });

      if (req.url === "/data/boom") {
        res.statusCode = 400;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: "quota exceeded" }));
        return;
      }

      res.setHeader("Content-Type", "application/json");
      if (req.method === "DELETE") {
        res.statusCode = 204;
        res.end();
        return;
      }
      if (req.method === "POST" || req.method === "PATCH") {
        res.end(JSON.stringify({ id: "1", ...(body ? JSON.parse(body) : {}) }));
        return;
      }
      // GET — a trailing /<id> segment (after the collection name) means "get one".
      const parts = req.url.split("?")[0]!.split("/").filter(Boolean); // ["data", "<collection>", ...]
      if (parts.length > 2) {
        res.end(JSON.stringify({ id: parts[2] }));
      } else {
        res.end(JSON.stringify([{ id: "1" }]));
      }
      return;
    }

    res.statusCode = 404;
    res.end();
  });

  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });

  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("D10 — window.anyapp.data exposes create/list/get/update/remove, sends the bearer token, and rejects with the server's error string on non-2xx", async ({
  page,
}) => {
  const TOKEN = "test-data-token-abc123";
  const fixture = await startFixture(TOKEN);
  try {
    await page.goto(fixture.origin + "/");

    const shape = await page.evaluate(() => {
      const data = (window as unknown as { anyapp?: { data?: Record<string, unknown> } }).anyapp?.data;
      if (!data) return null;
      return (["create", "list", "get", "update", "remove"] as const).map(
        (key) => typeof data[key],
      );
    });
    expect(shape).toEqual(["function", "function", "function", "function", "function"]);

    // Drive each method once, in a known order, so `fixture.seen` can be checked positionally.
    await page.evaluate(() =>
      (window as unknown as { anyapp: { data: { create: Function } } }).anyapp.data.create("things", {
        name: "a",
      }),
    );
    await page.evaluate(() =>
      (window as unknown as { anyapp: { data: { list: Function } } }).anyapp.data.list(
        "things",
        { done: true },
        10,
      ),
    );
    await page.evaluate(() =>
      (window as unknown as { anyapp: { data: { get: Function } } }).anyapp.data.get("things", "1"),
    );
    await page.evaluate(() =>
      (window as unknown as { anyapp: { data: { update: Function } } }).anyapp.data.update("things", "1", {
        name: "b",
      }),
    );
    await page.evaluate(() =>
      (window as unknown as { anyapp: { data: { remove: Function } } }).anyapp.data.remove("things", "1"),
    );

    expect(fixture.seen).toHaveLength(5);
    for (const request of fixture.seen) {
      expect(request.authorization).toBe(`Bearer ${TOKEN}`);
    }

    const [create, list, get, update, remove] = fixture.seen;
    expect(create!.method).toBe("POST");
    expect(create!.url).toBe("/data/things");
    expect(create!.contentType).toBe("application/json");
    expect(JSON.parse(create!.body)).toEqual({ name: "a" });

    expect(list!.method).toBe("GET");
    expect(list!.url).toBe("/data/things?where[done]=true&limit=10");
    expect(list!.contentType).toBeNull(); // no body on a GET — call() omits content-type entirely

    expect(get!.method).toBe("GET");
    expect(get!.url).toBe("/data/things/1");

    expect(update!.method).toBe("PATCH");
    expect(update!.url).toBe("/data/things/1");
    expect(JSON.parse(update!.body)).toEqual({ name: "b" });

    expect(remove!.method).toBe("DELETE");
    expect(remove!.url).toBe("/data/things/1");

    // Non-2xx must reject with the server's `error` string, not resolve.
    const outcome = await page.evaluate(async () => {
      try {
        await (window as unknown as { anyapp: { data: { create: Function } } }).anyapp.data.create(
          "boom",
          {},
        );
        return { rejected: false, message: null as string | null };
      } catch (error) {
        return { rejected: true, message: error instanceof Error ? error.message : String(error) };
      }
    });
    expect(outcome.rejected).toBe(true);
    expect(outcome.message).toBe("quota exceeded");
  } finally {
    await fixture.close();
  }
});
