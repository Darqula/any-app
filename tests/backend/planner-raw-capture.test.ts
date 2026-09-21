/**
 * capturePlannerFailure: a real PlanError must leave the raw planner text and the reason on disk, only when ANYAPP_PLANNER_RAW_DIR is set.
 * Same trigger as C14 but asserts the capture artifact, hence its own file. See tests/quality/README.md.
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
import { extractPreview, grantQuery } from "../harness/preview";

const { Pool } = pg;

const INTERNAL_SECRET = "planner-raw-capture-internal-secret";

// Not a plan at all: the C14 trigger (parsePlan throws "plan is missing sections").
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

async function createGeneration(servers: Stack["servers"], prompt: string): Promise<{ id: string; grant: string }> {
  const res = await fetch(`${servers.studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt }).toString(),
  });
  return extractPreview(await res.text());
}

function authHeaders(): Record<string, string> {
  return { [INTERNAL_SECRET_HEADER]: INTERNAL_SECRET };
}

async function driveToCompletion(
  servers: Stack["servers"],
  id: string,
  grant: string,
): Promise<{ status: number; body: string }> {
  const res = await fetch(`${servers.studioOrigin}/internal/generations/${id}/stream${grantQuery(grant)}`, {
    headers: authHeaders(),
  });
  return { status: res.status, body: await res.text() };
}

test("planner raw-response capture — ANYAPP_PLANNER_RAW_DIR set: a PlanError writes planner-fail-<id>.json with the real reason and raw text", async (t) => {
  const captureDir = await mkdtemp(path.join(tmpdir(), "anyapp-planner-raw-"));
  t.after(() => rm(captureDir, { recursive: true, force: true }));

  const { servers, scratch, fake } = await setup(t, { ANYAPP_PLANNER_RAW_DIR: captureDir });
  const { id, grant } = await createGeneration(servers, "Capture test app.");

  fake.queueComplete({ text: UNPARSEABLE_PLAN_TEXT });
  fake.queueStream({ chunks: ["<h1>Linear fallback app</h1>\n"], finish: "stop" });

  const { status, body } = await driveToCompletion(servers, id, grant);
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
  const { id, grant } = await createGeneration(servers, "No-capture test app.");

  fake.queueComplete({ text: UNPARSEABLE_PLAN_TEXT });
  fake.queueStream({ chunks: ["<h1>Linear fallback app</h1>\n"], finish: "stop" });

  const { status, body } = await driveToCompletion(servers, id, grant);
  assert.equal(status, 200);
  assert.ok(body.includes("<h1>Linear fallback app</h1>"), "must still complete via the linear fallback when the switch is off");

  // Unchanged behaviour: the console line stays the short scrubbed message, never the raw response, with no trace of the capture when unset.
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
