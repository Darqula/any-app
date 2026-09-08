/**
 * Covers the harness gap closed alongside the section-F quality sweep's log-capture work
 * (see `tests/quality/README.md`'s "Layout" entry for `planner-fail-<id>.json`): when a real
 * `PlanError` fires, `apps/studio/src/internal.ts`'s `capturePlannerFailure` must make the
 * exact raw planner text (and the failure reason) recoverable from disk, gated behind
 * `ANYAPP_PLANNER_RAW_DIR` so a plain `npm run dev` never writes or logs it.
 *
 * Same shape as `studio-routes.test.ts`'s C14 ("planner returns unparseable output: falls
 * back to linear") — this file exercises the identical PlanError trigger, but asserts on the
 * new capture artifact instead of (well, in addition to) the existing row/body assertions,
 * which is why it is a separate file rather than inserted into C14 itself.
 */
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { INTERNAL_SECRET_HEADER } from "@any-app/protocol";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";

const { Pool } = pg;

const INTERNAL_SECRET = "planner-raw-capture-internal-secret";

// Deliberately not a plan at all — the same trigger C14 uses (`parsePlan` throws `PlanError`
// with "plan is missing sections", since none of TITLE/CSS/SHELL/SLOTS parse out of prose).
const UNPARSEABLE_PLAN_TEXT =
  "This is not a plan at all, just some prose the model wrote instead — capture-test marker XYZZY.";

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

async function createGeneration(servers: Stack["servers"], prompt: string): Promise<string> {
  const res = await fetch(`${servers.studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt }).toString(),
  });
  const body = await res.text();
  const idMatch = body.match(/\/preview\/([0-9a-f-]{36})"/);
  assert.ok(idMatch, `expected an iframe src containing /preview/<uuid> in: ${body}`);
  return idMatch![1]!;
}

function authHeaders(): Record<string, string> {
  return { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET };
}

async function driveToCompletion(servers: Stack["servers"], id: string): Promise<{ status: number; body: string }> {
  const res = await fetch(`${servers.studioOrigin}/internal/generations/${id}/stream`, {
    headers: authHeaders(),
  });
  return { status: res.status, body: await res.text() };
}

test("planner raw-response capture — ANYAPP_PLANNER_RAW_DIR set: a PlanError writes planner-fail-<id>.json with the real reason and raw text", async (t) => {
  const captureDir = await mkdtemp(path.join(tmpdir(), "anyapp-planner-raw-"));
  t.after(() => rm(captureDir, { recursive: true, force: true }));

  const { servers, scratch, fake } = await setup(t, { ANYAPP_PLANNER_RAW_DIR: captureDir });
  const id = await createGeneration(servers, "Capture test app.");

  fake.queueComplete({ text: UNPARSEABLE_PLAN_TEXT });
  fake.queueStream({ chunks: ["<h1>Linear fallback app</h1>\n"], finish: "stop" });

  const { status, body } = await driveToCompletion(servers, id);
  assert.equal(status, 200);
  assert.ok(body.includes("<h1>Linear fallback app</h1>"), "generation must still complete via the linear fallback");

  const capturePath = path.join(captureDir, `planner-fail-${id}.json`);
  const raw = await readFile(capturePath, "utf8");
  const parsed = JSON.parse(raw) as { generationId: string; at: string; reason: string; raw: string };

  assert.equal(parsed.generationId, id, "capture must be keyed by the real generation id");
  assert.ok(!Number.isNaN(Date.parse(parsed.at)), "capture must carry a valid timestamp");
  assert.match(parsed.reason, /plan is missing sections/, "reason must be the real PlanError message, not a placeholder");
  assert.equal(
    parsed.raw,
    UNPARSEABLE_PLAN_TEXT,
    "raw must be the exact text the (fake) provider returned, captured before parsePlan was attempted",
  );

  const pool = new Pool({ connectionString: scratch.databaseUrl });
  let row: { status: string } | undefined;
  try {
    const { rows } = await pool.query<{ status: string }>("select status from generations where id = $1", [id]);
    row = rows[0];
  } finally {
    await pool.end();
  }
  assert.equal(row?.status, "complete", "the row itself still reflects the successful linear fallback, unchanged by capture");
});

test("planner raw-response capture — ANYAPP_PLANNER_RAW_DIR unset (default): no file is written, and the raw response never lands in server output", async (t) => {
  const { servers, fake } = await setup(t); // no ANYAPP_PLANNER_RAW_DIR — the npm-run-dev default
  const id = await createGeneration(servers, "No-capture test app.");

  fake.queueComplete({ text: UNPARSEABLE_PLAN_TEXT });
  fake.queueStream({ chunks: ["<h1>Linear fallback app</h1>\n"], finish: "stop" });

  const { status, body } = await driveToCompletion(servers, id);
  assert.equal(status, 200);
  assert.ok(body.includes("<h1>Linear fallback app</h1>"), "must still complete via the linear fallback when the switch is off");

  // The unchanged behavior this whole feature must preserve: the console line stays the
  // short, scrubbed PlanError message (see internal.ts's existing "falling back to linear"
  // warning) — never the full raw model response, and no trace of the capture machinery at
  // all when the env var is unset.
  const studioLog = servers.logs("studio");
  assert.ok(studioLog.includes("falling back to linear"), "the existing fallback log line must be unaffected");
  assert.ok(
    !studioLog.includes(UNPARSEABLE_PLAN_TEXT),
    "the raw planner response must never be dumped into normal server output when the debug switch is off",
  );
  assert.ok(
    !studioLog.includes("generationId"),
    "no capture-file-shaped payload should ever reach console output — capture is file-only, and only when armed",
  );
});
