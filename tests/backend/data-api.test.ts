/**
 * Section K: per-app tokens and the data API (K1-K25). Needs Postgres and the sandbox role, no model.
 * All cases share one scratch database and server pair (per-case would take minutes); each mints its own app id, so it has
 * its own row scope and rate-limit bucket. Only K15 depends on order and restores what it breaks.
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


function token(appId: string, secret = APP_TOKEN_SECRET, mode: "rw" | "ro" = "rw"): string {
  return mintAppToken(appId, mode, secret);
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


test("K1 — no Authorization header -> 401", async () => {
  const { origin } = freshApp();
  const res = await get(origin, "", "/notes");
  assert.equal(res.status, 401);
});


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


test("K3 — app A's valid token presented on app B's host -> 403", async () => {
  const a = freshApp();
  const b = freshApp();
  const res = await get(b.origin, a.token, "/notes"); // A's token, B's host
  assert.equal(res.status, 403);
});

// Holds on A's own host too, so it would survive deleting K3's host check: scope comes from the token.

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

// The highest-value case: without app.set("query parser", "extended") (apps/sandbox/src/index.ts), where[status]=open parses as a
// flat key and every row comes back, so exactly one "open" row is the assertion that matters.

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


test("K7 — where[done]=true matches a stored boolean true", async () => {
  const { origin, token: t } = freshApp();
  assert.equal((await post(origin, t, "todos", { done: true, label: "finished" })).status, 201);
  assert.equal((await post(origin, t, "todos", { done: false, label: "pending" })).status, 201);

  const res = await get(origin, t, "/todos?where[done]=true");
  const payload = (await res.json()) as { records: { data: { done: boolean; label: string } }[] };
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0]!.data.label, "finished");
});


test("K8 — where[count]=3 matches a stored number", async () => {
  const { origin, token: t } = freshApp();
  assert.equal((await post(origin, t, "items", { count: 3 })).status, 201);
  assert.equal((await post(origin, t, "items", { count: 5 })).status, 201);

  const res = await get(origin, t, "/items?where[count]=3");
  const payload = (await res.json()) as { records: { data: { count: number } }[] };
  assert.equal(payload.records.length, 1);
  assert.equal(payload.records[0]!.data.count, 3);
});


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

// Regression: the cursor embedded a JS Date's toString(), which Postgres rejected on page two.
// records/db.ts now parses timestamptz as an ISO string.

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

// Regression: rows in the same millisecond but different microseconds must both survive paging. Inserted as admin,
// the only way to land two rows in one millisecond.

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

// decodeCursor rejects both malformed shapes before any query runs.

test("K13 — malformed cursor -> 400", async () => {
  const { origin, token: t } = freshApp();

  const plain = await get(origin, t, "/notes?cursor=x");
  assert.equal(plain.status, 400);

  const garbage = Buffer.from("garbage|nope", "utf8").toString("base64url");
  const encoded = await get(origin, t, `/notes?cursor=${encodeURIComponent(garbage)}`);
  assert.equal(encoded.status, 400);
});


test("K14 — non-uuid :id -> 404, clean body", async () => {
  const { origin, token: t } = freshApp();
  const res = await get(origin, t, "/notes/not-a-uuid");
  assert.equal(res.status, 404);
  const body = await res.json();
  assert.deepStrictEqual(body, { error: "not found" });
});

// Forced by renaming `records` for one request through the superuser connection; restored in a finally.

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


test("K16 — invalid collection name -> 400", async () => {
  const { origin, token: t } = freshApp();
  const getRes = await get(origin, t, "/Bad-Name");
  assert.equal(getRes.status, 400);
  const postRes = await post(origin, t, "Bad-Name", { x: 1 });
  assert.equal(postRes.status, 400);
});

// Pre-filled to 999 rows directly (skipping the rate limiter and 999 HTTP writes); the boundary is crossed through real POSTs.

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

// Regression: the terminal error handler answered 500 for everything, hiding express.json's 413.

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

// Separate from K20: both are zero rows from one UPDATE, and one shared 404 would report an over-size PATCH as "not found".

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


test("K20 — PATCH against a genuinely missing id -> 404", async () => {
  const { origin, token: t } = freshApp();
  const res = await patch(origin, t, "grow", randomUUID(), { x: 1 });
  assert.equal(res.status, 404);
});


// Not "the 61st write is a 429": the bucket refills continuously, so where the first 429 lands depends on how long the burst takes
// (flaky when run concurrently). Asserts what is contractual: a sustained burst is cut off, not before capacity, and reads still work.
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

// Rendered through renderShellHead directly: a pure function of the plan whose module has no side effects.

test("K24 — a plan with no collections carries neither the data runtime nor a token", () => {
  const plan: AppPlan = {
    title: "Static app",
    css: "body{margin:0}",
    shell: "<main></main>",
    script: "",
    slots: [],
    collections: [], // <-- the case under test
  };
  const doc = renderShellHead(plan, "http://localhost:3000");
  assert.doesNotMatch(doc, /anyapp\.data/);
  assert.doesNotMatch(doc, /TOKEN\s*=/);
});

// Every render emits APP_TOKEN_PLACEHOLDER and the per-viewer token is substituted at send time. Checks that two
// renders embed identical placeholder text and that mintAppToken is pure, so a viewer's token survives edits.

test("K25 — the placeholder embedded in a document is identical across independent render passes, and the token derived from it is a pure function of (id, mode, secret)", () => {
  const id = randomUUID();
  const plan: AppPlan = {
    title: "App with data",
    css: "",
    shell: "<main></main>",
    script: "",
    slots: [],
    collections: [{ name: "notes", description: "notes" }],
  };

  // Shaped like internal.ts's generate-time call.
  const generateDoc = renderShellHead(plan, "http://localhost:3000");
  // Shaped like edits.ts's edit-time call.
  const editDoc = renderFullHead(plan, "http://localhost:3000");

  const extract = (doc: string): string => {
    const m = /var TOKEN = "([^"]+)"/.exec(doc);
    assert.ok(m, "expected to find an embedded TOKEN placeholder in the rendered document");
    return m![1]!;
  };

  const fromGenerate = extract(generateDoc);
  const fromEdit = extract(editDoc);
  assert.equal(fromGenerate, fromEdit, "both render passes must embed the exact same placeholder");
  assert.equal(fromGenerate, "{{ANYAPP_TOKEN}}", "and it must be the documented placeholder, not a live token");

  assert.equal(
    mintAppToken(id, "rw", APP_TOKEN_SECRET),
    mintAppToken(id, "rw", APP_TOKEN_SECRET),
    "the token derived at generate time and again at edit time must be byte-identical for the same id/mode/secret",
  );
});


test("K26 — a read-only token: GET succeeds, POST/PATCH/DELETE all 403 'this token is read-only'", async () => {
  const { id, origin } = freshApp();
  const rw = token(id, APP_TOKEN_SECRET, "rw");
  const ro = token(id, APP_TOKEN_SECRET, "ro");

  // Seed one row with the rw token first — the ro token must still be able to read it.
  const created = await post(origin, rw, "notes", { text: "seeded by rw" });
  assert.equal(created.status, 201);
  const recordId = (await created.json() as { id: string }).id;

  const list = await get(origin, ro, "/notes");
  assert.equal(list.status, 200, "reads must succeed on a read-only token");
  const payload = (await list.json()) as { records: { id: string }[] };
  assert.equal(payload.records.length, 1);

  const write = await post(origin, ro, "notes", { text: "should be rejected" });
  assert.equal(write.status, 403);
  assert.match((await write.json() as { error: string }).error, /read-only/);

  const patchRes = await patch(origin, ro, "notes", recordId, { text: "nope" });
  assert.equal(patchRes.status, 403);

  const deleteRes = await fetch(dataUrl(origin, `/notes/${recordId}`), {
    method: "DELETE",
    headers: { authorization: `Bearer ${ro}` },
  });
  assert.equal(deleteRes.status, 403);

  // The row is untouched by any of the rejected attempts.
  const stillThere = await get(origin, rw, `/notes/${recordId}`);
  assert.equal(stillThere.status, 200);
  assert.equal((await stillThere.json() as { data: { text: string } }).data.text, "seeded by rw");
});

test("K27 — an rw and a ro token for the SAME app id never verify as each other", async () => {
  const { id, origin } = freshApp();
  const rw = token(id, APP_TOKEN_SECRET, "rw");
  const ro = token(id, APP_TOKEN_SECRET, "ro");
  assert.notEqual(rw, ro);

  // Splicing ro's mode onto rw's signed body (or vice versa) must not verify — mode is
  // signed, not merely carried; see app-token.test.ts's A8.4b for the unit-level version.
  const rwWithRoMode = rw.replace(".rw.", ".ro.");
  const res = await get(origin, rwWithRoMode, "/notes");
  assert.equal(res.status, 401);
});
