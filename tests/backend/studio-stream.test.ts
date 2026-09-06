/**
 * Backend case C7 only (`.docs/tests-backend.md`): the happy path, full stream, driven
 * end to end through a real studio process against the fake provider fixture — 200, body
 * has the doctype, then skeletons, then templates and swaps, and the row ends `complete`.
 *
 * Deliberately does not implement the rest of section C (C1/C4-C6/C8-C16) — that is a later
 * task. This exists to prove the fixture actually drives a real generation through studio,
 * not to be the full C-section suite.
 *
 * Hits `/internal/generations/:id/stream` directly (with the internal secret header), the
 * same way sandbox's `/preview/:id` does internally — sandbox is not needed for this case
 * (see section C vs. D in tests-backend.md: C is studio-only), so it is started by
 * `startServers` but never addressed.
 *
 * The final DB check opens its own short-lived `pg.Pool` and closes it *inline*, before the
 * test function returns, rather than deferring the close via `t.after()`. `t.after()` hooks
 * run in registration order (confirmed empirically — Node does not reverse them), so a pool
 * closed via a `t.after()` registered after `scratch.drop()`'s would still be open when
 * `drop()` runs `pg_terminate_backend` on every other connection to the scratch database;
 * the resulting unsolicited termination fires `pool`'s `"error"` event, and with nothing
 * listening for it, that crashes the whole test process. Closing inline sidesteps the
 * ordering question entirely instead of depending on it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { INTERNAL_SECRET_HEADER } from "@any-app/protocol";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { startFakeProvider } from "../harness/fake-provider";

const { Pool } = pg;

const INTERNAL_SECRET = "c7-internal-secret";

// A minimal, well-formed planner response — see planner.ts's parsePlan for the exact
// section-header contract (`===NAME===`, alone on its own line).
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

// Split across three chunks at arbitrary (not marker-aligned) boundaries — a realistic
// streaming shape, not a single flush — see slot-stream.ts's `===SLOT id===` contract.
const FILL_CHUNKS = [
  "===SLOT head",
  'er===\n<h1>Welcome to the Test App</h1>\n===SLOT bod',
  "y===\n<p>This is the main content area.</p>\n",
];

test("C7 — happy path, full stream: 200, doctype then skeletons then templates/swaps, row complete", async (t) => {
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

  // Planner (completeText) then fill (streamText) — FIFO, matching the exact order
  // internal.ts calls them in.
  fake.queueComplete({ text: PLAN_TEXT });
  fake.queueStream({ chunks: FILL_CHUNKS, finish: "stop" });

  const createRes = await fetch(`${servers.studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt: "Build a tiny test app with a header and body." }).toString(),
  });
  assert.equal(createRes.status, 200);
  const createBody = await createRes.text();
  const idMatch = createBody.match(/\/preview\/([0-9a-f-]{36})"/);
  assert.ok(idMatch, `expected an iframe src containing /preview/<uuid> in: ${createBody}`);
  const id = idMatch![1]!;

  const streamRes = await fetch(`${servers.studioOrigin}/internal/generations/${id}/stream`, {
    headers: { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET },
  });
  assert.equal(streamRes.status, 200);
  const body = await streamRes.text();

  // --- Ordering: doctype, then skeletons, then templates/swaps ---------------------------
  assert.ok(body.startsWith("<!doctype html>"), "response must start with the doctype, nothing before it");

  const skeletonIndex = body.indexOf('class="anyapp-skeleton"');
  const headerTemplateIndex = body.indexOf('<template id="c-header">');
  const bodyTemplateIndex = body.indexOf('<template id="c-body">');
  assert.notEqual(skeletonIndex, -1, "skeletons must be present");
  assert.notEqual(headerTemplateIndex, -1, "header slot template must be present");
  assert.notEqual(bodyTemplateIndex, -1, "body slot template must be present");
  assert.ok(skeletonIndex < headerTemplateIndex, "skeletons must render before any slot template");
  assert.ok(headerTemplateIndex < bodyTemplateIndex, "sequential fill lands slots in plan/shell order");

  // --- Each slot's template is closed and swapped -----------------------------------------
  assert.ok(body.includes("<h1>Welcome to the Test App</h1>"), "header content must be present");
  assert.ok(body.includes("<p>This is the main content area.</p>"), "body content must be present");
  assert.ok(body.includes('</template><script>swap("header")</script>'), "header slot must be closed and swapped");
  assert.ok(body.includes('</template><script>swap("body")</script>'), "body slot must be closed and swapped");
  assert.ok(
    body.indexOf('swap("header")') < body.indexOf('swap("body")'),
    "swap calls land in plan/shell order under sequential fill",
  );

  // --- Only the two scripted calls happened (planner, then fill) -------------------------
  assert.equal(fake.requestCount(), 2);

  // --- The row is persisted as complete ---------------------------------------------------
  const pool = new Pool({ connectionString: scratch.databaseUrl });
  try {
    const { rows } = await pool.query("select status, document from generations where id = $1", [id]);
    assert.equal(rows[0]?.status, "complete");
    assert.ok(typeof rows[0]?.document === "string" && rows[0].document.startsWith("<!doctype html>"));
  } finally {
    await pool.end();
  }
});
