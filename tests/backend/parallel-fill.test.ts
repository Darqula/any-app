/**
 * J6–J14 — fan-out retry and failure handling. Spec: .docs/tests-backend.md section J.
 * Target: packages/generator/src/parallel-fill.ts (`fillAllSlots`, and its unexported
 * internals `fillSlotWithRetry`/`prewarm`), plus apps/studio/src/internal.ts's parallel
 * branch for J10/J11. Continues fan-out.test.ts (J1–J5, asCompleted/limitConcurrency).
 *
 * `LLM_FILL_MODE` defaults to "sequential" (see CLAUDE.md) — every case here sets it
 * explicitly via env, never relying on a default.
 *
 * FINDING: `fillSlotWithRetry` (the function J6–J9 are nominally "of") is not exported —
 * not even from its own module (`parallel-fill.ts` exports only `SlotResult` and
 * `fillAllSlots`; `fillSlotWithRetry` and `prewarm` have no `export` keyword at all, unlike
 * `fan-out.ts`'s `asCompleted`/`limitConcurrency`, which fan-out.test.ts already reaches by
 * relative import). There is no seam to import it directly without a production code change.
 * J6–J9 are therefore driven through `fillAllSlots` (the one exported entry point) with a
 * single-slot plan, scripting the fake provider to make that slot's calls fail/succeed/empty
 * exactly as each case describes — this exercises the real `fillSlotWithRetry` code by
 * construction, just not in isolation from `fillAllSlots`'s thin wrapper around it.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { fillAllSlots, isAbortError } from "@any-app/generator";
import type { SlotResult } from "@any-app/generator";
import { slotErrorPlaceholder, isSlotErrorPlaceholder } from "@any-app/protocol";
import type { AppPlan } from "@any-app/protocol";

const { Pool } = pg;

/** Builds a minimal, valid `AppPlan` with `n` slots — bypasses the planner text format
 * entirely, since `fillAllSlots` takes a parsed `AppPlan`, not planner output. */
function planWithSlots(n: number): AppPlan {
  const ids = Array.from({ length: n }, (_, i) => `slot${i}`);
  return {
    title: "Test App",
    css: ".card{padding:8px}",
    shell: ids.map((id) => `<div data-slot="${id}"></div>`).join(""),
    script: "",
    slots: ids.map((id) => ({ id, height: 200, spec: `content for ${id}` })),
    collections: [],
  };
}

/** Saves and restores every listed env var around `fn` — see provider-adapters.test.ts's
 * identical helper for why this matters within one `node --test` process. */
async function withEnv<T>(overrides: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function fillEnv(fake: FakeProvider, extra: Record<string, string> = {}): Record<string, string> {
  return {
    LLM_PROVIDER: "openai",
    LLM_MODEL: "fake-model",
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: fake.baseUrl,
    LLM_FILL_SLOT_MAX_TOKENS: "500",
    ...extra,
  };
}

async function drain(gen: AsyncGenerator<SlotResult>): Promise<SlotResult[]> {
  const out: SlotResult[] = [];
  for await (const r of gen) out.push(r);
  return out;
}

// -----------------------------------------------------------------------------------------
// J6–J9 — fillSlotWithRetry, via fillAllSlots with a single-slot plan (< 3 slots, so no
// pre-warm complicates the queue — see J12 below for that behaviour on its own).
// -----------------------------------------------------------------------------------------

test("J6 — first call fails, second succeeds: one retry, failed:false", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  await withEnv(fillEnv(fake), async () => {
    const plan = planWithSlots(1);
    fake.queueError({ status: 500, retryable: false });
    fake.queueStream({ chunks: ["<p>ok</p>"], finish: "stop" });

    const results = await drain(fillAllSlots("an app", plan, null, 4));

    assert.equal(results.length, 1);
    assert.equal(results[0]!.failed, false);
    assert.equal(results[0]!.html, "<p>ok</p>");
    assert.equal(fake.requestCount(), 2, "one failed attempt + one successful retry");
  });
});

test("J7 — both calls fail: slotErrorPlaceholder content, failed:true, no throw", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  await withEnv(fillEnv(fake), async () => {
    const plan = planWithSlots(1);
    fake.queueError({ status: 500, retryable: false });
    fake.queueError({ status: 500, retryable: false });

    const results = await drain(fillAllSlots("an app", plan, null, 4)); // must not throw

    assert.equal(results.length, 1);
    assert.equal(results[0]!.failed, true);
    assert.equal(results[0]!.html, slotErrorPlaceholder(plan.slots[0]!.id));
    assert.equal(fake.requestCount(), 2);
  });
});

test("J8 — first call returns an empty string (after fence-stripping): retried, not treated as content", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  await withEnv(fillEnv(fake), async () => {
    const plan = planWithSlots(1);
    // A stream that emits real (non-empty) text, so the OpenAI adapter's own
    // "no content -> RefusalError" check never fires — the failure here is fillSlot's OWN
    // post-processing (fence-stripping) reducing real streamed text down to "", which is a
    // different code path from J7's provider-level error/RefusalError case.
    fake.queueStream({ chunks: ["```html\n```"], finish: "stop" });
    fake.queueStream({ chunks: ["<p>real content</p>"], finish: "stop" });

    const results = await drain(fillAllSlots("an app", plan, null, 4));

    assert.equal(results.length, 1);
    assert.equal(results[0]!.failed, false);
    assert.equal(results[0]!.html, "<p>real content</p>");
    assert.equal(fake.requestCount(), 2, "the empty-after-stripping first attempt must have triggered a retry");
  });
});

test("J9 — an abort mid-call throws rather than returning a placeholder", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  await withEnv(fillEnv(fake), async () => {
    const plan = planWithSlots(1);
    const handle = fake.queueStream(); // manual — stays open until we abort it
    const ac = new AbortController();

    const pumpPromise = drain(fillAllSlots("an app", plan, null, 4, ac.signal));

    await handle.connected;
    await handle.emit("partial content");
    ac.abort();

    await assert.rejects(
      () => pumpPromise,
      (error: unknown) => isAbortError(error),
      "an abort must propagate as a throw, not degrade into a placeholder result",
    );
  });
});

// -----------------------------------------------------------------------------------------
// J12 — no pre-warm below 3 slots
// -----------------------------------------------------------------------------------------

test("J12 — pre-warm is not called with fewer than 3 slots", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  await withEnv(fillEnv(fake), async () => {
    const plan = planWithSlots(2);
    fake.queueStream({ chunks: ["<p>a</p>"], finish: "stop" });
    fake.queueStream({ chunks: ["<p>b</p>"], finish: "stop" });

    const results = await drain(fillAllSlots("an app", plan, null, 4));

    assert.equal(results.length, 2);
    assert.equal(fake.requestCount(), 2, "exactly the 2 slot calls, no extra pre-warm round trip");
    assert.equal(
      fake.requests().every((r) => r.body.stream === true),
      true,
      "no non-streaming completeText call (which is what the pre-warm always is) was made",
    );
  });
});

// -----------------------------------------------------------------------------------------
// J13 — a pre-warm that throws RefusalError("empty response") is a success
// -----------------------------------------------------------------------------------------

test("J13 — a pre-warm that throws RefusalError('empty response') is treated as success (log, not warn); the fan-out proceeds", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  await withEnv(fillEnv(fake), async () => {
    const plan = planWithSlots(3); // >= 3 -> pre-warm runs

    fake.queueComplete({}); // prewarm: text omitted -> provider throws RefusalError("empty response")
    fake.queueStream({ chunks: ["<p>a</p>"], finish: "stop" });
    fake.queueStream({ chunks: ["<p>b</p>"], finish: "stop" });
    fake.queueStream({ chunks: ["<p>c</p>"], finish: "stop" });

    const logs: string[] = [];
    const warns: string[] = [];
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };
    console.warn = (...args: unknown[]) => {
      warns.push(args.map(String).join(" "));
    };

    let results: SlotResult[];
    try {
      results = await drain(fillAllSlots("an app", plan, null, 4));
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
    }

    assert.equal(results.length, 3);
    assert.equal(
      results.every((r) => !r.failed),
      true,
      "the fan-out must still succeed on all real slots after the pre-warm's expected empty response",
    );
    assert.ok(
      logs.some((l) => l.includes("cache pre-warm") && l.includes("empty response")),
      "the pre-warm's RefusalError must be logged at console.log — it is the EXPECTED outcome on a reasoning model",
    );
    assert.equal(
      warns.some((w) => w.includes("cache pre-warm")),
      false,
      "must NOT be logged at console.warn — that line is reserved for a genuine pre-warm failure, and a test asserting the pre-warm 'succeeds' in the RefusalError sense would be asserting the wrong thing",
    );
  });
});

// -----------------------------------------------------------------------------------------
// J14 — exact call count
// -----------------------------------------------------------------------------------------

test("J14 — a whole parallel run makes exactly slots.length + 1 provider calls (fan-out plus one pre-warm)", async (t) => {
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  await withEnv(fillEnv(fake), async () => {
    const plan = planWithSlots(4);
    fake.queueComplete({ text: "ok" }); // prewarm
    for (let i = 0; i < 4; i++) fake.queueStream({ chunks: [`<p>${i}</p>`], finish: "stop" });

    const results = await drain(fillAllSlots("an app", plan, null, 4));

    assert.equal(results.length, 4);
    assert.equal(fake.requestCount(), 5, "slots.length (4) + 1 pre-warm");
  });
});

// -----------------------------------------------------------------------------------------
// J10 / J11 — route-level: through the real /internal/generations/:id/stream, LLM_FILL_MODE
// = parallel, against the real database.
//
// LLM_FILL_CONCURRENCY is pinned to "1" for both — see the comment inline for why: it makes
// the fake provider's FIFO queue line up deterministically with plan order (4 near-
// simultaneous connections racing to be "next" in the queue is a real non-determinism this
// case has no reason to fight), while still exercising the real parallel code path
// (LLM_FILL_MODE=parallel, the real `fillAllSlots`, the real route branch) — concurrency
// level and code path are independent knobs.
// -----------------------------------------------------------------------------------------

// `visibility: 'unlisted'`, not the column's own `'private'` default (Phase 6) — J10/J11 hit
// `/internal/generations/:id/stream` directly with only the internal secret, no view grant,
// and the internal route now 404s a private app without one (see internal.ts). This helper
// never goes through the real ownership-tracking POST /generations route, so there is no
// real owner to mint a grant for in the first place; marking the row unlisted sidesteps the
// grant requirement entirely, which is correct here since these cases are about the fan-out
// fill path, not the sharing/visibility model.
async function insertPendingGeneration(databaseUrl: string, prompt: string): Promise<string> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query<{ id: string }>(
      `insert into generations (prompt, visibility) values ($1, 'unlisted') returning id`,
      [prompt],
    );
    return rows[0]!.id;
  } finally {
    await pool.end();
  }
}

async function readGeneration(
  databaseUrl: string,
  id: string,
): Promise<{ status: string; document: string | null; plan: any; error: string | null }> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(`select status, document, plan, error from generations where id = $1`, [id]);
    return rows[0];
  } finally {
    await pool.end();
  }
}

const PLAN_4_SLOTS = `===TITLE===
Four Regions

===CSS===
.c{}

===SHELL===
<div data-slot="a"></div><div data-slot="b"></div><div data-slot="c"></div><div data-slot="d"></div>

===SLOTS===
a|200|Region A
b|200|Region B
c|200|Region C
d|200|Region D

===SCRIPT===

===DATA===
`;

const PLAN_3_SLOTS = `===TITLE===
Three Regions

===CSS===
.c{}

===SHELL===
<div data-slot="x"></div><div data-slot="y"></div><div data-slot="z"></div>

===SLOTS===
x|200|Region X
y|200|Region Y
z|200|Region Z

===SCRIPT===

===DATA===
`;

test("J10 — route: one slot of four fails twice, the row still completes with three real regions and one placeholder", async (t) => {
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
      LLM_PROVIDER: "openai",
      LLM_MODEL: "fake-model",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: fake.baseUrl,
      LLM_FILL_MODE: "parallel",
      LLM_FILL_CONCURRENCY: "1",
    },
  });
  t.after(() => servers.stop());

  fake.queueComplete({ text: PLAN_4_SLOTS }); // planner
  fake.queueComplete({ text: "ok" }); // pre-warm (4 slots >= 3)
  fake.queueStream({ chunks: ["<p>A ok</p>"], finish: "stop" }); // a
  fake.queueError({ status: 500, retryable: false }); // b attempt 1
  fake.queueError({ status: 500, retryable: false }); // b attempt 2 -> placeholder
  fake.queueStream({ chunks: ["<p>C ok</p>"], finish: "stop" }); // c
  fake.queueStream({ chunks: ["<p>D ok</p>"], finish: "stop" }); // d

  const id = await insertPendingGeneration(scratch.databaseUrl, "four region app");
  const res = await fetch(`${servers.studioOrigin}/internal/generations/${id}/stream`, {
    headers: { "x-internal-secret": "test-internal-secret" },
  });
  const body = await res.text();

  const row = await readGeneration(scratch.databaseUrl, id);
  assert.equal(row.status, "complete");
  assert.ok(body.includes("<p>A ok</p>"));
  assert.ok(body.includes("<p>C ok</p>"));
  assert.ok(body.includes("<p>D ok</p>"));
  assert.equal(isSlotErrorPlaceholder(row.plan.content.b), true, "slot b must hold the error placeholder");
  assert.equal(isSlotErrorPlaceholder(row.plan.content.a), false);
  assert.equal(isSlotErrorPlaceholder(row.plan.content.c), false);
  assert.equal(isSlotErrorPlaceholder(row.plan.content.d), false);
});

test("J11 — route: every slot fails, the row ends failed with 'every region failed to generate'", async (t) => {
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
      LLM_PROVIDER: "openai",
      LLM_MODEL: "fake-model",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: fake.baseUrl,
      LLM_FILL_MODE: "parallel",
      LLM_FILL_CONCURRENCY: "1",
    },
  });
  t.after(() => servers.stop());

  fake.queueComplete({ text: PLAN_3_SLOTS }); // planner
  fake.queueComplete({ text: "ok" }); // pre-warm (3 slots >= 3)
  for (let i = 0; i < 3; i++) {
    fake.queueError({ status: 500, retryable: false }); // attempt 1
    fake.queueError({ status: 500, retryable: false }); // attempt 2
  }

  const id = await insertPendingGeneration(scratch.databaseUrl, "three region app, all failing");
  const res = await fetch(`${servers.studioOrigin}/internal/generations/${id}/stream`, {
    headers: { "x-internal-secret": "test-internal-secret" },
  });
  await res.text();

  const row = await readGeneration(scratch.databaseUrl, id);
  assert.equal(row.status, "failed");
  assert.equal(row.error, "every region failed to generate");
});
