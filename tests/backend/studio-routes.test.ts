/**
 * Cases C1-C6, C8-C16; C7 lives in studio-stream.test.ts. Each test gets its own scratch database, fake
 * provider and server pair. Cleanup order: t.after() runs in registration order, so drop() is registered before stop(); raw pg pools
 * are closed inline.
 */
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { INTERNAL_SECRET_HEADER } from "@any-app/protocol";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { seedGeneration } from "../harness/seed";
import { extractPreview, grantQuery } from "../harness/preview";

const { Pool } = pg;

const INTERNAL_SECRET = "studio-routes-internal-secret";

// A minimal, well-formed planner response (===NAME=== headers alone on their lines), reused wherever a plan must succeed.
const PLAN_TEXT = `===TITLE===
Test App
===CSS===
body{font-family:sans-serif}
.header{padding:8px}
===SHELL===
<div data-slot="header"></div>
<div data-slot="body"></div>
===SLOTS===
header|80|A short header.
body|300|Main content area.`;

// One chunk carrying both slots — most cases here don't care about split-marker robustness
// (that's A6's job), just about a complete, valid fill.
const FILL_CHUNKS = ["===SLOT header===\n<h1>Hello</h1>\n===SLOT body===\n<p>World</p>\n"];

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

interface GenerationRow {
  status: string;
  document: string | null;
  error: string | null;
}

async function queryGeneration(databaseUrl: string, id: string): Promise<GenerationRow | undefined> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<GenerationRow>(
      "select status, document, error from generations where id = $1",
      [id],
    );
    return rows[0];
  } finally {
    await pool.end();
  }
}

async function countGenerations(databaseUrl: string): Promise<number> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<{ n: number }>("select count(*)::int as n from generations");
    return rows[0]!.n;
  } finally {
    await pool.end();
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

/** Returns the id and the view grant: a real generation is private, and the internal route 404s it without a valid grant. */
async function createGeneration(
  servers: Stack["servers"],
  prompt = "Test app prompt.",
): Promise<{ id: string; grant: string }> {
  const res = await fetch(`${servers.studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt }).toString(),
  });
  return extractPreview(await res.text());
}

function streamUrl(servers: Stack["servers"], id: string, grant: string): string {
  return `${servers.studioOrigin}/internal/generations/${id}/stream${grantQuery(grant)}`;
}

function authHeaders(): Record<string, string> {
  return { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET };
}


test("C1 — GET /health", async (t) => {
  const { servers } = await setup(t);
  const res = await fetch(`${servers.studioOrigin}/health`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, service: "studio" });
});

test("C2 — POST /generations with a prompt: row created pending, response contains an iframe", async (t) => {
  const { servers, scratch } = await setup(t);
  const res = await fetch(`${servers.studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt: "A tiny test app." }).toString(),
  });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /<iframe\b[^>]*class="preview"/);
  const { id } = extractPreview(body);
  const row = await queryGeneration(scratch.databaseUrl, id);
  assert.equal(row?.status, "pending");
});

test("C3 — POST /generations with a blank/whitespace prompt: 400, no row created", async (t) => {
  const { servers, scratch } = await setup(t);
  const before = await countGenerations(scratch.databaseUrl);
  const res = await fetch(`${servers.studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt: "   " }).toString(),
  });
  assert.equal(res.status, 400);
  const after = await countGenerations(scratch.databaseUrl);
  assert.equal(after, before, "a rejected blank prompt must not create a row");
});

test("C4/C5/C6 — internal route auth: no secret (403), wrong secret (403), right secret + unknown id (404)", async (t) => {
  const { servers } = await setup(t);
  const unknownId = "00000000-0000-0000-0000-000000000000";

  const noHeader = await fetch(streamUrl(servers, unknownId, ""));
  assert.equal(noHeader.status, 403, "C4: no secret header at all");

  const wrongSecret = await fetch(streamUrl(servers, unknownId, ""), {
    headers: { [INTERNAL_SECRET_HEADER]: "not-the-real-secret" },
  });
  assert.equal(wrongSecret.status, 403, "C5: the wrong secret");

  const rightSecretUnknownId = await fetch(streamUrl(servers, unknownId, ""), { headers: authHeaders() });
  assert.equal(rightSecretUnknownId.status, 404, "C6: right secret, id does not exist");
});

test("C8 — replay of a complete row makes no provider call", async (t) => {
  const { servers, scratch, fake } = await setup(t);
  const document = "<!doctype html>\n<html><body>seeded complete app</body></html>";
  const seeded = await seedGeneration(scratch.databaseUrl, { status: "complete", document });

  // Deliberately nothing queued — a call reaching the fake at all would get its own clear
  // "queue empty" 500, which would surface as a body mismatch below too.
  const res = await fetch(streamUrl(servers, seeded.id, ""), { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.equal(body, document, "a replay must return the stored document unchanged");
  assert.equal(fake.requestCount(), 0, "a replay of a complete row must never touch the provider");
});

test("C9 — two concurrent stream requests for one id: one provider round trip, the loser gets 'Already generating…'", async (t) => {
  const { servers, scratch, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers, "Race test app.");

  // One full script (planner, fill) is queued. If claimForGeneration stopped being atomic, the second request would find the queue empty
  // and get the fake's 500; requestCount() catches that beyond the body check.
  fake.queueComplete({ text: PLAN_TEXT });
  fake.queueStream({ chunks: FILL_CHUNKS, finish: "stop" });

  const url = streamUrl(servers, id, grant);
  const headers = authHeaders();
  // No await between the two fetch() calls — genuinely concurrent, not a race dressed up as
  // two sequential awaits (which would pass even with the old non-atomic claim).
  const [resA, resB] = await Promise.all([fetch(url, { headers }), fetch(url, { headers })]);
  assert.equal(resA.status, 200);
  assert.equal(resB.status, 200);
  const [bodyA, bodyB] = await Promise.all([resA.text(), resB.text()]);

  const bodies = [bodyA, bodyB];
  const losers = bodies.filter((b) => b.includes("Already generating"));
  const winners = bodies.filter((b) => !b.includes("Already generating"));
  assert.equal(losers.length, 1, "exactly one response must be the loser");
  assert.equal(winners.length, 1, "exactly one response must be the winner");
  assert.match(losers[0]!, /<meta http-equiv="refresh" content="2">/);
  assert.ok(winners[0]!.includes("<h1>Hello</h1>"), "the winner must carry the real generated content");

  assert.equal(
    fake.requestCount(),
    2,
    "only one generation attempt (planner + fill) may ever reach the provider for this id",
  );

  const row = await queryGeneration(scratch.databaseUrl, id);
  assert.equal(row?.status, "complete");
});

/**
 * C10 — a disconnect mid-stream sends the row back to pending and saves no document.
 * Regression: the SDKs' stream iterators end silently on abort, so nothing threw and a mid-sentence document was saved as complete.
 * Fixed in the adapters (they raise the abort error after the loop), which also fixes the before-any-content case that used to fail
 * as a bogus "model declined".
 */
test("C10 — client disconnect mid-stream: row back to pending, no document saved", async (t) => {
  const { servers, scratch, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers, "Disconnect test app.");

  fake.queueComplete({ text: PLAN_TEXT });
  // Manual mode (chunks omitted) — lets this test choose exactly when content has started
  // flowing before disconnecting, matching the case's own "mid-stream" framing.
  const fillHandle = fake.queueStream();

  const controller = new AbortController();
  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders(), signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  await reader.read(); // the doctype/shell, already flushed

  await fillHandle.connected; // the fill request has genuinely reached the fake provider
  await fillHandle.emit("===SLOT header===\n<h1>partial</h1>\n"); // now genuinely mid-content
  await new Promise((r) => setTimeout(r, 100)); // let it land before disconnecting
  controller.abort();
  await reader.cancel().catch(() => {});

  await waitUntil(async () => (await queryGeneration(scratch.databaseUrl, id))?.status !== "streaming", {
    message: "the row to leave 'streaming' after the client disconnected",
  });

  const requests = fake.requests();
  assert.equal(requests.length, 2, "planner + fill, nothing more");
  assert.equal(
    requests[1]!.aborted,
    true,
    "the fake provider's own fill request must be recorded as aborted — the upstream request " +
      "genuinely gets cut, regardless of how the row above ends up",
  );

  const row = await queryGeneration(scratch.databaseUrl, id);
  assert.equal(row?.status, "pending", "a disconnect must put the row back for a clean retry");
  assert.equal(row?.document, null, "a half-written document must never be persisted");

  const health = await fetch(`${servers.studioOrigin}/health`);
  assert.equal(health.status, 200, "the server must still be up and serving other requests");
});

test("C11 — provider returns finish_reason content_filter: row failed, error banner in the body", async (t) => {
  const { servers, scratch, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers, "Content filter test app.");

  fake.queueComplete({ text: PLAN_TEXT });
  fake.queueStream({ chunks: ["partial "], finish: "content_filter" });

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Generation failed:/);
  assert.match(body, /content_filter/);

  const row = await queryGeneration(scratch.databaseUrl, id);
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /content_filter/);
});

test("C12 — provider returns an empty stream: row failed with 'empty response'", async (t) => {
  const { servers, scratch, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers, "Empty response test app.");

  fake.queueComplete({ text: PLAN_TEXT });
  fake.queueStream({ chunks: [] }); // gotcha per README: [] auto-plays zero chunks and finishes itself

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Generation failed:/);
  assert.match(body, /empty response/);

  const row = await queryGeneration(scratch.databaseUrl, id);
  assert.equal(row?.status, "failed");
  assert.match(row?.error ?? "", /empty response/);
});

test("C13 — provider returns HTTP 500: row failed, server stays up", async (t) => {
  const { servers, scratch, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers, "Provider 500 test app.");

  fake.queueComplete({ text: PLAN_TEXT });
  fake.queueError({ status: 500 }); // retryable defaults to false — one call, not up to three

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Generation failed:/);

  const row = await queryGeneration(scratch.databaseUrl, id);
  assert.equal(row?.status, "failed");

  const health = await fetch(`${servers.studioOrigin}/health`);
  assert.equal(health.status, 200);
});

test("C14 — planner returns unparseable output: falls back to linear, app still renders, row complete", async (t) => {
  const { servers, scratch, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers, "Unparseable plan test app.");

  fake.queueComplete({ text: "This is not a plan at all, just some prose the model wrote instead." });
  fake.queueStream({ chunks: ["<h1>Linear fallback app</h1>\n<p>Body content.</p>\n"], finish: "stop" });

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.ok(body.startsWith("<!doctype html>"));
  assert.ok(body.includes("<h1>Linear fallback app</h1>"), "the linear fallback's own content must render");
  // The linear path streams raw HTML directly — it never goes through the shell/skeleton
  // machinery the plan/fill path uses.
  assert.ok(!body.includes('class="anyapp-skeleton"'), "a linear-fallback document has no skeletons");

  assert.equal(fake.requestCount(), 2, "the failed planner call, then the linear fallback call");

  const row = await queryGeneration(scratch.databaseUrl, id);
  assert.equal(row?.status, "complete");
});

/**
 * C15 — an aborted planner call must not fall back to linear. The HTTP and database outcome cannot show it: an already-aborted
 * signal makes even a wrong fallback self-abort with no network call. Only the server log line "planning failed, falling back to
 * linear" distinguishes them (servers.logs("studio"), added for this and H5).
 */
test("C15 — planner call aborted: does NOT fall back to linear, row goes back to pending", async (t) => {
  const { servers, scratch, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers, "Abort during planning test app.");

  // Only one response is queued. That alone cannot tell "skipped" from "attempted then self-aborted"; it still catches a coarser
  // regression such as the fallback using a fresh signal.
  const plannerHandle = fake.queueComplete({ text: PLAN_TEXT, delayMs: 4000 });

  const controller = new AbortController();
  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders(), signal: controller.signal });
  assert.equal(res.status, 200);
  const reader = res.body!.getReader();
  await reader.read(); // the doctype/padding, already flushed before planning even starts

  await plannerHandle.connected; // the planner request has genuinely reached the fake provider
  controller.abort();
  await reader.cancel().catch(() => {});

  await waitUntil(async () => (await queryGeneration(scratch.databaseUrl, id))?.status === "pending", {
    message: "row reset to pending after the planner call was aborted",
  });

  // Give a wrongly-triggered fallback a moment it would need to actually make its own call.
  await new Promise((r) => setTimeout(r, 300));

  assert.equal(
    fake.requestCount(),
    1,
    "an aborted planner call must not be followed by a linear-fallback call",
  );
  assert.equal(fake.requests()[0]!.aborted, true, "the planner request itself must be recorded as aborted");

  const row = await queryGeneration(scratch.databaseUrl, id);
  assert.equal(row?.status, "pending");
  assert.equal(row?.document, null);

  // Pins the guard: without `if (isAbortError(error)) throw error`, the catch logs this line before calling runLinearFallback.
  assert.ok(
    !servers.logs("studio").includes("falling back to linear"),
    "an aborted planner call must never enter the linear-fallback branch",
  );
});

test("C16 — fill call fails after the shell was written: error banner appended, not replacing, prior output; row failed", async (t) => {
  const { servers, scratch, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers, "Partial fill failure test app.");

  fake.queueComplete({ text: PLAN_TEXT });
  // The header slot completes; the body slot is mid-write when the finish reason arrives. The open response is appended to, not replaced.
  fake.queueStream({
    chunks: ["===SLOT header===\n<h1>Partial success</h1>\n===SLOT body===\n<p>unfinished"],
    finish: "content_filter",
  });

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  assert.equal(res.status, 200);
  const body = await res.text();

  const shellIndex = body.indexOf('<style id="anyapp-css">');
  const headerSwapIndex = body.indexOf('swap("header")');
  const bannerIndex = body.indexOf("Generation failed:");
  assert.notEqual(shellIndex, -1, "the shell must have been written");
  assert.notEqual(headerSwapIndex, -1, "the header slot must have been fully written and swapped before the failure");
  assert.notEqual(bannerIndex, -1, "the error banner must be present");
  assert.ok(shellIndex < headerSwapIndex, "shell precedes slot content");
  assert.ok(
    headerSwapIndex < bannerIndex,
    "the error banner must be appended after the already-streamed content, not in place of it",
  );

  const row = await queryGeneration(scratch.databaseUrl, id);
  assert.equal(row?.status, "failed");
});
