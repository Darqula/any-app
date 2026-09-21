/**
 * Cases E1-E7: the streaming-transport invariants (content visible from byte one) that a buffering middleware
 * could break without any functional test noticing.
 */
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { INTERNAL_SECRET_HEADER } from "@any-app/protocol";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { extractPreview, grantQuery } from "../harness/preview";

const INTERNAL_SECRET = "wire-format-internal-secret";

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

const FILL_TEXT = "===SLOT header===\n<h1>Hello</h1>\n===SLOT body===\n<p>World</p>\n";

interface Stack {
  scratch: Awaited<ReturnType<typeof createScratchDatabase>>;
  fake: FakeProvider;
  servers: Awaited<ReturnType<typeof startServers>>;
}

async function setup(t: TestContext): Promise<Stack> {
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
    },
  });
  t.after(() => servers.stop());

  return { scratch, fake, servers };
}

async function createGeneration(
  servers: Stack["servers"],
  prompt = "Wire format test app.",
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

/** Queues a normal, fast plan+fill pair — the common fixture for the invariants that don't
 * care about timing (E1, E2, E3, E6, E7). */
async function queueHappyPath(fake: FakeProvider): Promise<void> {
  fake.queueComplete({ text: PLAN_TEXT });
  fake.queueStream({ chunks: [FILL_TEXT], finish: "stop" });
}


test("E1 — first bytes of any generated response: <!doctype html>, nothing before it", async (t) => {
  const { servers, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers);
  await queueHappyPath(fake);

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  const body = await res.text();
  assert.ok(body.startsWith("<!doctype html>"), `body must start with the doctype, got: ${body.slice(0, 40)}`);
});

test("E2 — response headers carry no Content-Encoding (compression must never be added)", async (t) => {
  const { servers, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers);
  await queueHappyPath(fake);

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  await res.text();
  assert.equal(res.headers.get("content-encoding"), null);
});

test("E3 — response headers: Transfer-Encoding chunked, no Content-Length", async (t) => {
  const { servers, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers);
  await queueHappyPath(fake);

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  assert.equal(res.headers.get("transfer-encoding"), "chunked");
  assert.equal(res.headers.get("content-length"), null);
  await res.text();
});

/**
 * E4 — verified two ways before trusting it: deleting res.flushHeaders() still passes (the next write flushes headers anyway), but adding a
 * buffering middleware turned it red (shell at 2142ms vs the <500ms required). So it enforces "the response streams unbuffered to the client"
 * (what compression would break), by asserting shell/content arrival time, not that flushHeaders() ran.
 */
test("E4 — headers and the shell arrive well before a fake that delays its first fill chunk ~2s (flushHeaders() regression guard)", async (t) => {
  const { servers, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers);
  fake.queueComplete({ text: PLAN_TEXT });
  fake.queueStream({ chunks: [{ text: FILL_TEXT, delayMs: 2000 }], finish: "stop" });

  const start = Date.now();
  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  const headersAt = Date.now() - start;
  assert.equal(res.status, 200);

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let shellAt: number | null = null;
  let contentAt: number | null = null;
  while (contentAt === null) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (shellAt === null && buffer.includes('<style id="anyapp-css">')) shellAt = Date.now() - start;
    if (buffer.includes("<h1>Hello</h1>")) contentAt = Date.now() - start;
  }

  assert.ok(headersAt < 500, `response headers took ${headersAt}ms — flushHeaders() may not be taking effect`);
  assert.ok(
    shellAt !== null && shellAt < 500,
    `shell arrived at ${shellAt}ms — should be near-instant, well before the delayed fill chunk`,
  );
  assert.ok(
    contentAt !== null && contentAt >= 1800,
    `delayed content arrived at ${contentAt}ms — expected it to honour the fake's ~2s delay`,
  );
});

test("E5 — at least 1KB is sent before the first content chunk, so the browser starts parsing immediately", async (t) => {
  const { servers, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers);
  await queueHappyPath(fake);

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  const reader = res.body!.getReader();
  const received: Buffer[] = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) throw new Error("stream ended before the expected content chunk ever arrived");
    if (value) received.push(Buffer.from(value));
    const text = Buffer.concat(received).toString("utf8");
    const idx = text.indexOf("<h1>Hello</h1>");
    if (idx !== -1) {
      const bytesBeforeContent = Buffer.byteLength(text.slice(0, idx), "utf8");
      assert.ok(
        bytesBeforeContent >= 1024,
        `only ${bytesBeforeContent} bytes arrived before the first content chunk`,
      );
      break;
    }
  }
});

test("E6 — the shell arrives before the fill call starts (checked against the fake provider's own request timestamps)", async (t) => {
  const { servers, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers);
  await queueHappyPath(fake);

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let shellObservedAt: number | null = null;
  while (shellObservedAt === null) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (buffer.includes('<style id="anyapp-css">')) shellObservedAt = Date.now();
  }
  // Drain the rest so the connection closes cleanly before the test returns.
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }

  assert.ok(shellObservedAt !== null, "the shell must have been observed in the stream");
  const requests = fake.requests();
  assert.equal(requests.length, 2, "planner then fill");
  const fillRequestAt = requests[1]!.receivedAt;
  // Same process, same clock as the in-process fake, so Date.now() from both sides is comparable.
  assert.ok(
    shellObservedAt! <= fillRequestAt,
    `the shell was observed client-side at ${shellObservedAt}, but the fill request only reached ` +
      `the provider at ${fillRequestAt} — the shell must be written before the fill call starts`,
  );
});

test("E7 — slot templates appear after the shell script (swap() must be defined before anything calls it)", async (t) => {
  const { servers, fake } = await setup(t);
  const { id, grant } = await createGeneration(servers);
  await queueHappyPath(fake);

  const res = await fetch(streamUrl(servers, id, grant), { headers: authHeaders() });
  const body = await res.text();

  // A token from the emitted swap runtime's source, present in the <script>, not merely in comments.
  const runtimeIndex = body.indexOf("function rerunScripts");
  const firstTemplateIndex = body.indexOf('<template id="c-');
  assert.notEqual(runtimeIndex, -1, "the swap runtime script must be present in the document");
  assert.notEqual(firstTemplateIndex, -1, "at least one slot template must be present");
  assert.ok(
    runtimeIndex < firstTemplateIndex,
    "the runtime script defining swap() must precede any slot template whose swap() call depends on it",
  );
});
