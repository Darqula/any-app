/**
 * Cases D1-D8. D3-D5 and D7 point STUDIO_INTERNAL_URL at a local node:http stub to control the upstream (404,
 * hang, refusal); the real studio still starts but sits idle. D2, D6 and D8 use the real studio (proxy relay, three-hop abort, heartbeat).
 */
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { INTERNAL_SECRET_HEADER } from "@any-app/protocol";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { seedGeneration } from "../harness/seed";
import { extractPreview, grantQuery } from "../harness/preview";

const INTERNAL_SECRET = "sandbox-routes-internal-secret";

const PLAN_TEXT = `===TITLE===
Test App
===CSS===
body{font-family:sans-serif}
===SHELL===
<div data-slot="header"></div>
<div data-slot="body"></div>
===SLOTS===
header|80|A short header.
body|300|Main content area.`;

async function waitUntil(
  check: () => boolean | Promise<boolean>,
  opts: { timeoutMs?: number; intervalMs?: number; message?: string } = {},
): Promise<void> {
  const { timeoutMs = 8000, intervalMs = 50, message = "condition" } = opts;
  const start = Date.now();
  for (;;) {
    if (await check()) return;
    if (Date.now() - start >= timeoutMs) {
      throw new Error(`waitUntil: timed out after ${timeoutMs}ms waiting for: ${message}`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

interface Stack {
  scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  fake: FakeProvider;
  servers: Awaited<ReturnType<typeof startServers>>;
}

async function setup(t: TestContext, envOverrides: Record<string, string> = {}): Promise<Stack> {
  const scratch = await createScratchDatabase();
  t.after(() => scratch.drop());

  const fake = await startFakeProvider();
  t.after(() => fake.close());

  const [studioPort, sandboxPort] = await findFreePorts(2);
  const servers = await startServers({
    databaseUrl: scratch.databaseUrl,
    sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
    ports: { studio: studioPort!, sandbox: sandboxPort! },
    env: {
      INTERNAL_SECRET,
      LLM_PROVIDER: "openai",
      LLM_MODEL: "fake-model",
      LLM_MAX_TOKENS: "2000",
      LLM_FILL_MODE: "sequential",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: fake.baseUrl,
      ...envOverrides,
    },
  });
  t.after(() => servers.stop());

  return { scratch, fake, servers };
}

/** Returns the id and grant so /preview/:id can be called directly: the sandbox forwards ?g blindly and studio 404s a private app without it. */
async function createGeneration(
  servers: Stack["servers"],
  prompt = "Sandbox test app.",
): Promise<{ id: string; grant: string }> {
  const res = await fetch(`${servers.studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt }).toString(),
  });
  return extractPreview(await res.text());
}

// A stand-in for studio where a test must fully control the upstream (D3-D5, D7); the sandbox reads only STUDIO_INTERNAL_URL.

interface Stub {
  url: string;
  requests: { headers: Record<string, string | string[] | undefined> }[];
  close(): Promise<void>;
}

function startStub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<Stub> {
  return new Promise((resolve, reject) => {
    const requests: { headers: Record<string, string | string[] | undefined> }[] = [];
    const server = createServer((req, res) => {
      requests.push({ headers: { ...req.headers } });
      handler(req, res);
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise((res2) => server.close(() => res2())),
      });
    });
  });
}


test("D1 — GET /health", async (t) => {
  const { servers } = await setup(t);
  const res = await fetch(`${servers.sandboxOrigin}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "sandbox" });
});

test("D2 — GET /preview/:id proxies studio's body through unchanged", async (t) => {
  const { servers, scratch } = await setup(t);
  const document = "<!doctype html>\n<html><body>D2 proxy check</body></html>";
  const seeded = await seedGeneration(scratch.databaseUrl, { status: "complete", document });

  const res = await fetch(`${servers.sandboxOrigin}/preview/${seeded.id}`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, document);
});

test("D3 — sandbox's request to studio carries the x-internal-secret header", async (t) => {
  const stub = await startStub((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<!doctype html><html><body>stub</body></html>");
  });
  const { servers } = await setup(t, { STUDIO_INTERNAL_URL: stub.url });
  t.after(() => stub.close());

  const res = await fetch(`${servers.sandboxOrigin}/preview/some-id`);
  assert.equal(res.status, 200);
  assert.equal(stub.requests.length, 1);
  assert.equal(stub.requests[0]!.headers[INTERNAL_SECRET_HEADER], INTERNAL_SECRET);
});

test("D4 — studio returns 404: sandbox returns 404, not 500", async (t) => {
  const stub = await startStub((_req, res) => {
    res.writeHead(404, { "Content-Type": "text/html" });
    res.end("<p>not found</p>");
  });
  const { servers } = await setup(t, { STUDIO_INTERNAL_URL: stub.url });
  t.after(() => stub.close());

  const res = await fetch(`${servers.sandboxOrigin}/preview/missing-id`);
  assert.equal(res.status, 404);
});

test("D5 — studio is down: sandbox responds without crashing the process", async (t) => {
  const [deadPort] = await findFreePorts(1); // released immediately after; nothing listens here
  const { servers } = await setup(t, { STUDIO_INTERNAL_URL: `http://127.0.0.1:${deadPort}` });

  const res = await fetch(`${servers.sandboxOrigin}/preview/some-id`);
  assert.ok(res.status >= 500 && res.status < 600, `expected a 5xx from the connection-refused case, got ${res.status}`);

  const health = await fetch(`${servers.sandboxOrigin}/health`);
  assert.equal(health.status, 200, "the sandbox process must still be alive and serving");
});

test("D6 — viewer disconnects: the upstream fetch is aborted (asserted on the studio/provider side)", async (t) => {
  const { servers, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers, "Sandbox disconnect test.");

  fake.queueComplete({ text: PLAN_TEXT });
  const fillHandle = fake.queueStream(); // manual mode — left open until we choose to abort

  const controller = new AbortController();
  const res = await fetch(`${servers.sandboxOrigin}/preview/${id}${grantQuery(grant)}`, { signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  await reader.read(); // drain the already-buffered doctype/shell

  await fillHandle.connected; // the fill request has genuinely reached the fake provider
  controller.abort();
  await reader.cancel().catch(() => {});

  // The point of D6: the disconnect propagates client -> sandbox -> studio -> the fake provider's own connection. The row's final state is
  // asserted in C10, not repeated here.
  await waitUntil(() => fake.requests()[1]?.aborted === true, {
    message: "the fake provider's fill request must eventually be recorded as aborted, through sandbox and studio",
  });
});

test("D7 — viewer disconnects before upstream headers arrive: no unhandled rejection, nothing written to a dead socket", async (t) => {
  let stubReqSeen = false;
  const stub = await startStub((_req, res) => {
    stubReqSeen = true;
    // Never responds in this test's lifetime, so the abort lands before any upstream response, not mid-body.
    const timer = setTimeout(() => {
      try {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<!doctype html><html></html>");
      } catch {
        // Client long gone by now — fine.
      }
    }, 5000);
    timer.unref();
  });
  const { servers } = await setup(t, { STUDIO_INTERNAL_URL: stub.url });
  t.after(() => stub.close());

  const controller = new AbortController();
  const fetchPromise = fetch(`${servers.sandboxOrigin}/preview/some-id`, { signal: controller.signal });
  await waitUntil(() => stubReqSeen, { timeoutMs: 2000, message: "sandbox's proxy request must reach the stub" });
  controller.abort();
  await assert.rejects(fetchPromise, "the client's own fetch must reject once aborted before headers arrived");

  // An abort here passes through Express 5's async rejection handling with no try/catch around the fetch. The process still answering
  // /health proves it did not crash.
  const health = await fetch(`${servers.sandboxOrigin}/health`);
  assert.equal(health.status, 200);
});

test("D8a — a deliberately small PREVIEW_TIMEOUT_MS bounds a stuck upstream instead of hanging", async (t) => {
  const { servers, fake } = await setup(t, { PREVIEW_TIMEOUT_MS: "1200" });
  const { id, grant } = await createGeneration(servers, "Timeout bound test.");

  // The planner call alone takes far longer than PREVIEW_TIMEOUT_MS — proves the bound
  // actually cuts the proxied connection rather than waiting the full delay out.
  fake.queueComplete({ text: PLAN_TEXT, delayMs: 6000 });

  const start = Date.now();
  const res = await fetch(`${servers.sandboxOrigin}/preview/${id}${grantQuery(grant)}`);
  try {
    // Read to the end, or the proxy cut it off: undici reports an abandoned chunked body as a rejected read. Either outcome means the
    // connection did not run the full 6s.
    await res.text();
  } catch {
    // Expected when sandbox truncates the response instead of ending it cleanly.
  }
  const elapsedMs = Date.now() - start;

  assert.ok(
    elapsedMs < 4000,
    `expected the 1.2s PREVIEW_TIMEOUT_MS to cut the connection well before the 6s upstream delay; took ${elapsedMs}ms`,
  );
});

test("D8b — heartbeat comments keep a quiet proxied connection alive (bounded wait, not the forbidden 300s)", async (t) => {
  const { servers, fake } = await setup(t); // default PREVIEW_TIMEOUT_MS (900000) — plenty of headroom
  const { id, grant } = await createGeneration(servers, "Heartbeat test.");

  // Studio's planning heartbeat fires every 15s and is not configurable, so this must wait past it; 17s is nowhere near the 300s it guards.
  fake.queueComplete({ text: PLAN_TEXT, delayMs: 17_000 });

  const controller = new AbortController();
  const res = await fetch(`${servers.sandboxOrigin}/preview/${id}${grantQuery(grant)}`, { signal: controller.signal });
  assert.equal(res.status, 200);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + 20_000;
  while (!buffer.includes("<!-- planning -->") && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
  }
  assert.ok(
    buffer.includes("<!-- planning -->"),
    "expected at least one heartbeat comment to reach the client through the sandbox proxy",
  );

  controller.abort();
  await reader.cancel().catch(() => {});
});
