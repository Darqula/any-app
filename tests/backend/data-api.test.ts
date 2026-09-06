/**
 * Section K — per-app tokens and the data API (K1–K25). Needs Postgres and the
 * `anyapp_sandbox` role, but no model and no fake provider — this is HTTP plus Postgres.
 * See .docs/tests-backend.md's "K. Per-app tokens and the data API" for the prose behind
 * each case.
 *
 * All 25 cases share ONE scratch database and ONE running server pair, created once in a
 * file-level `before`/`after` — the README explicitly allows this when a whole file's cases
 * genuinely share one scratch database on purpose, and spinning up two fresh child-process
 * servers per case (25 times) would make this suite take minutes instead of seconds. Cases
 * do not interfere with each other because every case mints its own fresh app id
 * (`crypto.randomUUID()`) and therefore gets its own row-scope AND its own rate-limit bucket
 * (`packages/records/src/quota.ts`'s buckets are keyed by `${appId}:${kind}`) — nothing here
 * relies on test execution order except K15, which is written to restore what it breaks
 * before it returns control (see that case).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pg from "pg";
import { createScratchDatabase } from "../harness/db";
import type { ScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import type { RunningServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { mintAppToken } from "../harness/seed";
// Imported directly (not through a running server) for K24/K25 — see those cases' comments
// for why a document's shape is testable this way without a model.
import { renderShellHead, renderFullHead } from "../../apps/studio/src/shell";
import type { AppPlan } from "@any-app/protocol";

const { Pool } = pg;

let scratch: ScratchDatabase;
let servers: RunningServers;
let admin: InstanceType<typeof Pool>; // superuser pg.Pool, for setup/inspection only
const APP_TOKEN_SECRET = "k-series-fixed-app-token-secret";

before(async () => {
  scratch = await createScratchDatabase();
  admin = new Pool({ connectionString: scratch.databaseUrl });
  const [studioPort, sandboxPort] = await findFreePorts(2);
  servers = await startServers({
    databaseUrl: scratch.databaseUrl,
    sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
    ports: { studio: studioPort!, sandbox: sandboxPort! },
    env: { APP_TOKEN_SECRET },
  });
});

after(async () => {
  await admin.end();
  await servers.stop();
  await scratch.drop();
});

// --- helpers --------------------------------------------------------------------------

function token(appId: string, secret = APP_TOKEN_SECRET): string {
  return mintAppToken(appId, secret);
}

/** `origin` is the app's own per-app origin (`servers.appOrigin(appId)`) unless a case is
 * deliberately testing a cross-app-origin mismatch (K3). */
function dataUrl(origin: string, pathAndQuery: string): string {
  return `${origin}/data${pathAndQuery}`;
}

async function post(origin: string, bearer: string, collection: string, body: unknown): Promise<Response> {
  return fetch(dataUrl(origin, `/${collection}`), {
    method: "POST",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(origin: string, bearer: string, pathAndQuery: string): Promise<Response> {
  return fetch(dataUrl(origin, pathAndQuery), {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  });
}

async function patch(origin: string, bearer: string, collection: string, id: string, body: unknown): Promise<Response> {
  return fetch(dataUrl(origin, `/${collection}/${id}`), {
    method: "PATCH",
    headers: { authorization: `Bearer ${bearer}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Fresh app id + its own valid token + its own per-app origin — full isolation per case. */
function freshApp(): { id: string; token: string; origin: string } {
  const id = randomUUID();
  return { id, token: token(id), origin: servers.appOrigin(id) };
}

// ---------------------------------------------------------------------------------------
// K1 — no Authorization header at all -> 401
// ---------------------------------------------------------------------------------------

test("K1 — no Authorization header -> 401", async () => {
  const { origin } = freshApp();
  const res = await get(origin, "", "/notes");
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------------------
// K2 — token signed with the wrong secret, or one MAC character changed -> 401
// ---------------------------------------------------------------------------------------

test("K2 — token signed with the wrong secret -> 401", async () => {
  const { id, origin } = freshApp();
  const wrongToken = token(id, "a-completely-different-secret");
  const res = await get(origin, wrongToken, "/notes");
  assert.equal(res.status, 401);
});

test("K2 — one MAC character changed -> 401", async () => {
  const { origin, token: good } = freshApp();
  const dot = good.lastIndexOf(".");
  const mac = good.slice(dot + 1);
  const flippedChar = mac[0] === "a" ? "b" : "a";
  const tampered = `${good.slice(0, dot + 1)}${flippedChar}${mac.slice(1)}`;
  assert.notEqual(tampered, good);
  const res = await get(origin, tampered, "/notes");
  assert.equal(res.status, 401);
});

// ---------------------------------------------------------------------------------------
// K3 — app A's valid token presented on app B's host -> 403 (host cross-check)
// ---------------------------------------------------------------------------------------

test("K3 — app A's valid token presented on app B's host -> 403", async () => {
  const a = freshApp();
  const b = freshApp();
  const res = await get(b.origin, a.token, "/notes"); // A's token, B's host
  assert.equal(res.status, 403);
});

// ---------------------------------------------------------------------------------------
// K4 — app A's token, asking for a collection app B owns -> empty list, not an error.
// Deliberately separate from K3: this holds even on A's OWN (correct) host, so it would
// still hold if K3's host check were deleted entirely — scope comes from the token, not
// from the host check, which is defence in depth only.
// ---------------------------------------------------------------------------------------

test("K4 — app A's token against a collection app B populated -> empty list, no error", async () => {
  const a = freshApp();
  const b = freshApp();

  const created = await post(b.origin, b.token, "notes", { owner: "b" });
  assert.equal(created.status, 201);

  // A's OWN host, A's OWN token — no host mismatch in play at all here.
  const res = await get(a.origin, a.token, "/notes");
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { records: unknown[]; nextCursor: string | null };
  assert.deepStrictEqual(payload.records, []);
  assert.equal(payload.nextCursor, null);
});

// ---------------------------------------------------------------------------------------
// K5 — rows created by A are never returned to B under any query
// ---------------------------------------------------------------------------------------

test("K5 — rows created by A never come back to B", async () => {
  const a = freshApp();
  const b = freshApp();

  for (let i = 0; i < 3; i++) {
    assert.equal((await post(a.origin, a.token, "notes", { n: i })).status, 201);
  }

  const res = await get(b.origin, b.token, "/notes");
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { records: unknown[] };
  assert.deepStrictEqual(payload.records, [], "B must see none of A's rows");
});

// ---------------------------------------------------------------------------------------
// K6 — where[status]=open actually filters. THE highest-value case in the document: Express
// 5 defaults to a query parser with no bracket-notation support, so `where[status]=open`
// would parse as one flat key literally named "where[status]", req.query.where would be
// undefined, parseWhere would return {}, and `data @> '{}'::jsonb` matches every row. If
// `app.set("query parser", "extended")` were deleted from apps/sandbox/src/index.ts, this
// assertion (exactly one "open" row back, not both) would fail: both rows would come back,
// `records.length` would be 2 instead of 1, and `records[0]!.data.status` would not even
// need to be "open" to sneak past a weaker assertion. Reasoned through, not assumed.
// ---------------------------------------------------------------------------------------

test("K6 — where[status]=open actually filters (Express 5 query-parser regression guard)", async () => {
  const { origin, token: t } = freshApp();
  assert.equal((await post(origin, t, "tasks", { status: "open", title: "a" })).status, 201);
  assert.equal((await post(origin, t, "tasks", { status: "closed", title: "b" })).status, 201);

  const res = await get(origin, t, "/tasks?where[status]=open");
  assert.equal(res.status, 200);
  const payload = (await res.json()) as { records: { data: { status: string; title: string } }[] };
  assert.equal(payload.records.length, 1, "expected exactly the one open row — if this is 2, bracket-notation parsing regressed");
  assert.equal(payload.records[0]!.data.status, "open");
  assert.equal(payload.records[0]!.data.title, "a");
});

// ---------------------------------------------------------------------------------------
// K7 — where[done]=true against a stored boolean -> matches (string/boolean coercion)
// ---------------------------------------------------------------------------------------

test("K7 — where[done]=true matches a stored boolean true", async () => {
  const { origin, token: t } = freshApp();
  assert.equal((await post(origin, t, "todos", { done: true, label: "finished" })).status, 201);
  assert.equal((await post(origin, t, "todos", { done: false, label: "pending" })).status, 201);

  const res = await get(origin, t, "/todos?where[done]=true");
  const payload = (await res.json()) as { records: { data: { done: boolean; label: string } }[] };
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0]!.data.label, "finished");
});

// ---------------------------------------------------------------------------------------
// K8 — where[count]=3 against a stored number -> matches
// ---------------------------------------------------------------------------------------

test("K8 — where[count]=3 matches a stored number", async () => {
  const { origin, token: t } = freshApp();
  assert.equal((await post(origin, t, "items", { count: 3 })).status, 201);
  assert.equal((await post(origin, t, "items", { count: 5 })).status, 201);

  const res = await get(origin, t, "/items?where[count]=3");
  const payload = (await res.json()) as { records: { data: { count: number } }[] };
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0]!.data.count, 3);
});

// ---------------------------------------------------------------------------------------
// K9 — no where at all -> returns everything, newest first
// ---------------------------------------------------------------------------------------

test("K9 — no where -> everything, newest first", async () => {
  const { origin, token: t } = freshApp();
  for (let i = 1; i <= 3; i++) {
    assert.equal((await post(origin, t, "log", { n: i })).status, 201);
  }
  const res = await get(origin, t, "/log");
  const payload = (await res.json()) as { records: { data: { n: number } }[] };
  assert.equal(payload.records.length, 3);
  assert.deepStrictEqual(payload.records.map((r) => r.data.n), [3, 2, 1]);
});

// ---------------------------------------------------------------------------------------
// K10 — limit of 0, -1, 1000, "abc" -> clamped to 1-100, default 25, no throw
// ---------------------------------------------------------------------------------------

test("K10 — limit is clamped to 1-100, defaults to 25, never throws", async () => {
  const { id, origin, token: t } = freshApp();
  // 120 rows, inserted directly — a real HTTP creation loop would need 120 write calls
  // against a 60-writes/min bucket, which is exactly the trap K17's prose warns about.
  await admin.query(
    `insert into records (app_id, collection, data)
     select $1, 'bulk', jsonb_build_object('n', g) from generate_series(1, 120) g`,
    [id],
  );

  const zero = await get(origin, t, "/bulk?limit=0");
  assert.equal(zero.status, 200);
  assert.equal(((await zero.json()) as { records: unknown[] }).records.length, 1, "limit=0 clamps to 1");

  const negative = await get(origin, t, "/bulk?limit=-1");
  assert.equal(negative.status, 200);
  assert.equal(((await negative.json()) as { records: unknown[] }).records.length, 1, "limit=-1 clamps to 1");

  const huge = await get(origin, t, "/bulk?limit=1000");
  assert.equal(huge.status, 200);
  assert.equal(((await huge.json()) as { records: unknown[] }).records.length, 100, "limit=1000 clamps to 100");

  const nonNumeric = await get(origin, t, "/bulk?limit=abc");
  assert.equal(nonNumeric.status, 200);
  assert.equal(((await nonNumeric.json()) as { records: unknown[] }).records.length, 25, "limit=abc falls back to the default 25");

  const noLimit = await get(origin, t, "/bulk");
  assert.equal(noLimit.status, 200);
  assert.equal(((await noLimit.json()) as { records: unknown[] }).records.length, 25, "no limit param defaults to 25");
});

// ---------------------------------------------------------------------------------------
// K11 — paging with cursor to the end: every row seen exactly once, nextCursor null on the
// final page.
//
// FIXED (was found live, left red on purpose — see testing-review.md S1 for the original
// root-cause writeup). The second page of any paginated request 500'd: `encodeCursor`
// interpolated `row.created_at`, typed `string` but actually a JS `Date` (pg auto-converts
// `timestamptz`, OID 1184), so the template literal called `Date.prototype.toString()` —
// e.g. `"Mon Sep 01 2026 11:18:56 GMT+0500 (...)"` — which round-tripped past
// `decodeCursor`'s own guard (it only checked `Date.parse`, which accepts that shape too)
// and reached Postgres as a `timestamptz` bind parameter it does not accept
// (`time zone "gmt+0500" not recognized`, SQLSTATE 22023). Fixed by having
// `packages/records/src/db.ts` register a type parser for OID 1184 so `timestamptz` arrives
// as a real ISO string (making `RecordRow.created_at: string`'s type honest instead of
// aspirational), plus tightening `decodeCursor`'s guard to the exact ISO-instant shape as
// defence in depth. This case now passes.
// ---------------------------------------------------------------------------------------

test("K11 — paging to the end sees every row exactly once, ends with nextCursor null", async () => {
  const { origin, token: t } = freshApp();
  const total = 55;
  for (let i = 0; i < total; i++) {
    assert.equal((await post(origin, t, "page", { n: i })).status, 201);
  }

  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const query = cursor ? `/page?limit=20&cursor=${encodeURIComponent(cursor)}` : `/page?limit=20`;
    const res = await get(origin, t, query);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { records: { id: string }[]; nextCursor: string | null };
    for (const record of payload.records) {
      assert.equal(seen.has(record.id), false, "must never see the same row twice while paging");
      seen.add(record.id);
    }
    pages++;
    cursor = payload.nextCursor;
    if (cursor === null) break;
    assert.ok(pages < 20, "paging did not terminate — possible infinite loop");
  }

  assert.equal(seen.size, total);
});

// ---------------------------------------------------------------------------------------
// K11-R — regression test for S1-R (testing-review.md): two rows sharing the same
// millisecond but differing in microseconds must both survive pagination. The first fix for
// S1 (routing `timestamptz` through a JS `Date`) silently truncated to millisecond
// resolution — Postgres itself stores microseconds — so a page-boundary row with a same-
// millisecond, earlier-microsecond neighbour would drop that neighbour off both pages with
// no error. K11 above cannot catch this: its rows arrive via sequential HTTP requests, so
// they are milliseconds apart by construction. This inserts directly via the superuser
// `admin` pool instead, the only way to put two rows inside one millisecond on purpose.
// ---------------------------------------------------------------------------------------

test("K11-R — same-millisecond, different-microsecond rows both survive pagination", async () => {
  const { id: appId, token: t, origin } = freshApp();
  const rows = [
    { id: randomUUID(), createdAt: "2026-01-01 00:00:00.500999+00" }, // newest of the pair
    { id: randomUUID(), createdAt: "2026-01-01 00:00:00.500001+00" }, // same ms, older µs
    { id: randomUUID(), createdAt: "2025-01-01 00:00:00.000000+00" }, // far older, own page
  ];
  for (const row of rows) {
    await admin.query(
      `insert into records (id, app_id, collection, data, created_at, updated_at)
       values ($1, $2, 'msprecision', '{}'::jsonb, $3, $3)`,
      [row.id, appId, row.createdAt],
    );
  }

  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  for (;;) {
    const query = cursor
      ? `/msprecision?limit=1&cursor=${encodeURIComponent(cursor)}`
      : `/msprecision?limit=1`;
    const res = await get(origin, t, query);
    assert.equal(res.status, 200);
    const payload = (await res.json()) as { records: { id: string }[]; nextCursor: string | null };
    for (const record of payload.records) seen.add(record.id);
    pages++;
    cursor = payload.nextCursor;
    if (cursor === null) break;
    assert.ok(pages < 10, "paging did not terminate — possible infinite loop");
  }

  assert.equal(seen.size, rows.length, "the same-millisecond pair must not be dropped");
  for (const row of rows) assert.ok(seen.has(row.id), `missing row ${row.id}`);
});

// ---------------------------------------------------------------------------------------
// K12 — a short page (fewer rows than limit) -> nextCursor is null, not a cursor onto an
// empty page
// ---------------------------------------------------------------------------------------

test("K12 — short page: nextCursor is null, not a cursor onto an empty page", async () => {
  const { origin, token: t } = freshApp();
  for (let i = 0; i < 5; i++) {
    assert.equal((await post(origin, t, "short", { n: i })).status, 201);
  }
  const res = await get(origin, t, "/short?limit=20");
  const payload = (await res.json()) as { records: unknown[]; nextCursor: string | null };
  assert.equal(payload.records.length, 5);
  assert.equal(payload.nextCursor, null);
});

// ---------------------------------------------------------------------------------------
// K13 — malformed cursor -> 400, no 500, nothing reaches Postgres. decodeCursor rejects
// both cases before listRecords is ever called (records.ts's decodeCursor validates the id
// half against UUID_PATTERN and the timestamp half against the exact ISO-instant shape), so
// a 400 here proves the request never got as far as a query.
// ---------------------------------------------------------------------------------------

test("K13 — malformed cursor -> 400", async () => {
  const { origin, token: t } = freshApp();

  const plain = await get(origin, t, "/notes?cursor=x");
  assert.equal(plain.status, 400);

  const garbage = Buffer.from("garbage|nope", "utf8").toString("base64url");
  const encoded = await get(origin, t, `/notes?cursor=${encodeURIComponent(garbage)}`);
  assert.equal(encoded.status, 400);
});

// ---------------------------------------------------------------------------------------
// K14 — :id that is not a uuid -> 404, no 500, no stack trace in the body
// ---------------------------------------------------------------------------------------

test("K14 — non-uuid :id -> 404, clean body", async () => {
  const { origin, token: t } = freshApp();
  const res = await get(origin, t, "/notes/not-a-uuid");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepStrictEqual(body, { error: "not found" });
});

// ---------------------------------------------------------------------------------------
// K15 — any unexpected DB error -> {"error":"internal error"}, never Express's default
// stack trace. Forced by renaming the `records` table out from under the sandbox's pool for
// the span of one request, using the superuser connection — restored in a `finally` before
// this test returns, so no other case ever sees the broken table.
// ---------------------------------------------------------------------------------------

test("K15 — an unexpected DB error returns a clean {error: internal error}, no stack trace", async () => {
  const { origin, token: t } = freshApp();
  await admin.query("alter table records rename to records_tmp_k15");
  try {
    const res = await get(origin, t, "/notes");
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.deepStrictEqual(body, { error: "internal error" });
    const text = JSON.stringify(body);
    assert.doesNotMatch(text, /at /, "response body must not contain a stack trace");
    assert.doesNotMatch(text, /\.ts:\d+/, "response body must not leak a source location");
  } finally {
    await admin.query("alter table records_tmp_k15 rename to records");
  }
});

// ---------------------------------------------------------------------------------------
// K16 — invalid collection name -> 400
// ---------------------------------------------------------------------------------------

test("K16 — invalid collection name -> 400", async () => {
  const { origin, token: t } = freshApp();
  const getRes = await get(origin, t, "/Bad-Name");
  assert.equal(getRes.status, 400);
  const postRes = await post(origin, t, "Bad-Name", { x: 1 });
  assert.equal(postRes.status, 400);
});

// ---------------------------------------------------------------------------------------
// K17 — create past MAX_RECORDS_PER_APP -> 409. Pre-filled to 999 rows directly (bypassing
// both the write-rate limiter and the time cost of 999 real HTTP writes — see the prose
// under K in tests-backend.md), then the boundary itself is crossed through two real HTTP
// POSTs so the actual route code is what's asserted against.
// ---------------------------------------------------------------------------------------

test("K17 — creating past MAX_RECORDS_PER_APP -> 409, row count does not grow past it", async () => {
  const { id, origin, token: t } = freshApp();
  await admin.query(
    `insert into records (app_id, collection, data)
     select $1, 'quota', '{}'::jsonb from generate_series(1, 999)`,
    [id],
  );

  const ok = await post(origin, t, "quota", { note: "the 1000th row" });
  assert.equal(ok.status, 201, "the 1000th row must still be accepted");

  const overQuota = await post(origin, t, "quota", { note: "the 1001st row" });
  assert.equal(overQuota.status, 409);

  const { rows } = await admin.query<{ count: string }>(
    "select count(*)::text as count from records where app_id = $1",
    [id],
  );
  assert.equal(rows[0]!.count, "1000", "quota must not let the row count grow past the limit");
});

// ---------------------------------------------------------------------------------------
// K18 — request body over MAX_RECORD_BYTES -> 413
//
// FIXED (was found live, left red on purpose — see testing-review.md S2 for the original
// root-cause writeup). `express.json({ limit: ... })` (data.ts) correctly rejects an
// oversized body — internally via `raw-body`/`body-parser`, which construct a real
// `PayloadTooLargeError` with `.status === 413` and hand it to `next(err)` — but the
// terminal error-handling middleware used to answer 500 for every error unconditionally,
// never reading `err.status`/`err.statusCode`, so a genuine 413 was indistinguishable from
// an actual unexpected server error (K15). Fixed by having that handler pass a numeric
// `status`/`statusCode` in the 4xx range straight through instead of collapsing it to 500;
// 5xx stays opaque. This case now passes.
// ---------------------------------------------------------------------------------------

test("K18 — request body over MAX_RECORD_BYTES -> 413", async () => {
  const { origin, token: t } = freshApp();
  const oversized = { big: "x".repeat(70_000) }; // > 65_536-byte MAX_RECORD_BYTES limit
  const res = await post(origin, t, "notes", oversized);
  assert.equal(
    res.status,
    413,
    "an oversized request body should be rejected with 413 Payload Too Large",
  );
});

// ---------------------------------------------------------------------------------------
// K19 — repeated distinct-key PATCHes, each under the cap: the one that pushes the row over
// the cap gets 413, not 404, and the row does not grow. Deliberately separate from K20 —
// both are zero-rows-back from one UPDATE, and collapsing them into a single 404 would make
// an over-size PATCH report "not found" for a record that plainly exists.
// ---------------------------------------------------------------------------------------

test("K19 — a cumulative PATCH that would exceed MAX_RECORD_BYTES gets 413, not 404", async () => {
  const { origin, token: t } = freshApp();
  const created = await post(origin, t, "grow", {});
  assert.equal(created.status, 201);
  const { id } = (await created.json()) as { id: string };

  const chunk = "x".repeat(4000);
  let sawLimit = false;
  let lastGoodData: unknown = {};
  for (let i = 0; i < 30 && !sawLimit; i++) {
    const res = await patch(origin, t, "grow", id, { [`f${i}`]: chunk });
    if (res.status === 200) {
      lastGoodData = ((await res.json()) as { data: unknown }).data;
      continue;
    }
    assert.equal(res.status, 413, `expected 413 once the cumulative size exceeds the cap, got ${res.status}`);
    sawLimit = true;
  }
  assert.ok(sawLimit, "never hit the size cap across 30 growing patches — chunk size or cap assumption is off");

  // The row must not have grown from the rejected patch — it should still match whatever
  // the last SUCCESSFUL patch left it as.
  const after = await get(origin, t, "/grow/" + id);
  assert.equal(after.status, 200);
  const afterData = ((await after.json()) as { data: unknown }).data;
  assert.deepStrictEqual(afterData, lastGoodData);
});

// ---------------------------------------------------------------------------------------
// K20 — PATCH against a genuinely missing id -> 404 (distinguished from K19)
// ---------------------------------------------------------------------------------------

test("K20 — PATCH against a genuinely missing id -> 404", async () => {
  const { origin, token: t } = freshApp();
  const res = await patch(origin, t, "grow", randomUUID(), { x: 1 });
  assert.equal(res.status, 404);
});

// ---------------------------------------------------------------------------------------
// K21 — write rate limit exceeded -> 429, and reads still work (buckets are per kind)
// ---------------------------------------------------------------------------------------

// Deliberately NOT "the 61st write is a 429". `quota.ts`'s bucket refills *continuously* —
// 60 writes/min is one token per second, credited on every call from elapsed wall-clock time,
// not reset in fixed windows. So the exact index of the first 429 is a function of how long
// the burst takes: 61 sequential HTTP round trips well under a second see no refill and the
// 61st is rejected, but the same loop slowed past a second (which is exactly what happens
// when `node --test` runs this file concurrently with others) has a token or more back and
// sails past 61. That made this case the main source of intermittent backend-suite failures
// while it asserted the exact index — the limiter was behaving exactly as designed each time.
//
// What is actually contractual: a sustained burst gets cut off, it is not cut off before the
// documented capacity, and reads keep working. All three are asserted below, none of them
// depend on the burst's wall-clock duration.
test("K21 — write rate limit: a sustained burst is cut off after ~60/min, reads unaffected", async () => {
  const { origin, token: t } = freshApp();
  const CAPACITY = 60;
  const CAP = 300; // generous stop: at 1 token/s refill, any burst faster than 1 req/s converges
  let firstRejectedAt = -1;

  for (let i = 0; i < CAP; i++) {
    const res = await post(origin, t, "spam", { i });
    if (res.status === 429) {
      firstRejectedAt = i;
      break;
    }
    assert.equal(res.status, 201, `write ${i} should be either 201 or 429, got ${res.status}`);
  }

  assert.notEqual(firstRejectedAt, -1, "a sustained write burst must eventually be rate-limited");
  assert.ok(
    firstRejectedAt >= CAPACITY,
    `the limiter must not cut in before its documented capacity — first 429 at write ${firstRejectedAt}, capacity ${CAPACITY}`,
  );

  // Reads are a separate bucket (300/min) and must still work right after writes were cut off.
  const read = await get(origin, t, "/spam?limit=1");
  assert.equal(read.status, 200);
});

// ---------------------------------------------------------------------------------------
// K22 — anyapp_sandbox role against generations / provider_credentials -> permission denied
// ---------------------------------------------------------------------------------------

test("K22 — the restricted role cannot read generations or provider_credentials", async () => {
  const restricted = new Pool({ connectionString: scratch.sandboxDatabaseUrl });
  try {
    await assert.rejects(
      () => restricted.query("select count(*) from generations"),
      /permission denied/i,
    );
    await assert.rejects(
      () => restricted.query("select count(*) from provider_credentials"),
      /permission denied/i,
    );
    // And confirm it's not simply broken outright — records must still work.
    const { rows } = await restricted.query("select count(*) from records");
    assert.ok(rows[0]);
  } finally {
    await restricted.end();
  }
});

// ---------------------------------------------------------------------------------------
// K23 — response body of any data route contains no app_id — it is scope, not payload
// ---------------------------------------------------------------------------------------

test("K23 — no data route's response body contains app_id", async () => {
  const { origin, token: t } = freshApp();

  const created = await post(origin, t, "priv", { note: "hi" });
  assert.equal(created.status, 201);
  const createdBody = await created.text();
  assert.doesNotMatch(createdBody, /"app_id"/);
  const { id } = JSON.parse(createdBody) as { id: string };

  const list = await get(origin, t, "/priv");
  assert.doesNotMatch(await list.text(), /"app_id"/);

  const single = await get(origin, t, `/priv/${id}`);
  assert.doesNotMatch(await single.text(), /"app_id"/);

  const patched = await patch(origin, t, "priv", id, { note: "updated" });
  assert.doesNotMatch(await patched.text(), /"app_id"/);

  const put = await fetch(dataUrl(origin, `/priv/${id}`), {
    method: "PUT",
    headers: { authorization: `Bearer ${t}`, "content-type": "application/json" },
    body: JSON.stringify({ note: "replaced" }),
  });
  assert.doesNotMatch(await put.text(), /"app_id"/);
});

// ---------------------------------------------------------------------------------------
// K24 — a document rendered for a plan with no collections contains neither the data
// runtime nor a token.
//
// Rendered directly through apps/studio/src/shell.ts's own renderShellHead — the same
// function internal.ts and edits.ts call — rather than through a live generation, since
// this section needs no model: renderShellHead's behaviour (inlining dataRuntime(token)
// only when plan.collections.length > 0) is a pure function of its plan argument, and
// shell.ts imports nothing but @any-app/protocol, so importing it directly here carries no
// side effects (no Postgres, no env, no credentials).
// ---------------------------------------------------------------------------------------

test("K24 — a plan with no collections carries neither the data runtime nor a token", () => {
  const plan: AppPlan = {
    title: "Static app",
    css: "body{margin:0}",
    shell: "<main></main>",
    script: "",
    slots: [],
    collections: [], // <-- the case under test
  };
  const doc = renderShellHead(plan, "http://localhost:3000", mintAppToken(randomUUID(), APP_TOKEN_SECRET));
  assert.doesNotMatch(doc, /anyapp\.data/);
  assert.doesNotMatch(doc, /TOKEN\s*=/);
});

// ---------------------------------------------------------------------------------------
// K25 — a document rendered twice for one app (generate, then edit) carries the same token
// both times.
//
// Full end-to-end coverage of this ("generate through the real route, then edit through the
// real route, compare") needs a live model call on the edit path (edits.ts's regenerateCss/
// regenerateSlot/fillSlot all call the provider) — outside this section's no-model,
// no-fake-provider scope (the fake provider fixture is a separate agent's deliverable; see
// tests/README.md's "Placeholder" section). What IS testable without a model is the
// property both call sites actually rely on: `mintAppToken(id, secret)` is a pure function
// of its two arguments, so calling it from two independent render passes — one shaped like
// internal.ts's generate-time render (renderShellHead), one shaped like edits.ts's edit-time
// render (renderFullHead) — must yield byte-identical tokens embedded in each document, and
// both must match a direct, independent computation of the same token.
// ---------------------------------------------------------------------------------------

test("K25 — the token embedded in a document is identical across independent render passes", () => {
  const id = randomUUID();
  const plan: AppPlan = {
    title: "App with data",
    css: "",
    shell: "<main></main>",
    script: "",
    slots: [],
    collections: [{ name: "notes", description: "notes" }],
  };

  // Shaped like internal.ts's generate-time call (mintAppToken(id, secret), then
  // renderShellHead).
  const generateToken = mintAppToken(id, APP_TOKEN_SECRET);
  const generateDoc = renderShellHead(plan, "http://localhost:3000", generateToken);

  // Shaped like edits.ts's edit-time call (mintAppToken(id, secret) again — "minted from
  // the id, not read back off the old document", per edits.ts's own comment — then
  // renderFullHead).
  const editToken = mintAppToken(id, APP_TOKEN_SECRET);
  const editDoc = renderFullHead(plan, "http://localhost:3000", editToken);

  const extract = (doc: string): string => {
    const m = /var TOKEN = "([^"]+)"/.exec(doc);
    assert.ok(m, "expected to find an embedded TOKEN in the rendered document");
    return m![1]!;
  };

  const fromGenerate = extract(generateDoc);
  const fromEdit = extract(editDoc);
  assert.equal(fromGenerate, fromEdit, "the same app id must embed the same token on every render");
  assert.equal(fromGenerate, mintAppToken(id, APP_TOKEN_SECRET), "and it must match a fresh direct computation");
});
