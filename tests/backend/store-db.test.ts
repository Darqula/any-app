/**
 * B1-B12: store and database, against a real migrated scratch database. The file shares one database on
 * purpose (a migrate child process per case would cost seconds each); each case gets its own generations row. @any-app/store is imported
 * dynamically in `before`, after DATABASE_URL is set, because its pool is built at module scope.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createScratchDatabase } from "../harness/db";
import type { ScratchDatabase } from "../harness/db";
import type { Owner } from "@any-app/store";

let scratch: ScratchDatabase;
let store: typeof import("@any-app/store");

/** Every case in this file except B12 only cares that a row exists, not who owns it — one
 *  shared anonymous owner keeps them from having to think about it. */
const OWNER: Owner = { kind: "anon", sessionId: "store-db-test-owner" };

before(async () => {
  scratch = await createScratchDatabase();
  process.env.DATABASE_URL = scratch.databaseUrl;
  store = await import("@any-app/store");
});

after(async () => {
  // Close the store's pool before drop(): drop() terminates backends, and an open pool then crashes on its unhandled "error" event.
  await store.pool.end();
  await scratch.drop();
});

test("B1 — migrate() run twice: second run is a no-op, each file appears once in schema_migrations", async () => {
  const before1 = await store.pool.query("select name from schema_migrations order by name");
  await store.migrate();
  const after1 = await store.pool.query("select name from schema_migrations order by name");
  assert.deepEqual(after1.rows, before1.rows, "a no-op second run must not change the recorded set");

  const names = after1.rows.map((r: { name: string }) => r.name);
  assert.deepEqual(names, [...new Set(names)], "every migration file must appear at most once");
  assert.ok(names.length >= 5, "the five known migration files should all be recorded");

  await store.migrate();
  const after2 = await store.pool.query("select count(*) from schema_migrations");
  assert.equal(after2.rows[0].count, String(names.length), "a third run still changes nothing");
});

/**
 * B2 — a failing migration rolls back and is not recorded. Drives the real migrate() against a private temp directory,
 * so no broken .sql lands in the shared migrations that concurrent scratch databases apply.
 * The good file must survive; the bad one leaves neither its table nor a schema_migrations row.
 */
test("B2 — a failing migration rolls back and is not recorded, while earlier files stay applied", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "anyapp-b2-"));
  try {
    await writeFile(path.join(dir, "001_b2_good.sql"), "create table b2_good (id int);", "utf8");
    // Two statements: the first succeeds, the second fails on a duplicate name, so the first's table must be rolled back too.
    await writeFile(
      path.join(dir, "002_b2_broken.sql"),
      "create table b2_should_not_survive (id int);\ncreate table b2_should_not_survive (id int);",
      "utf8",
    );

    await assert.rejects(
      () => store.migrate(dir),
      "a malformed migration must propagate, not be swallowed",
    );

    const good = await store.pool.query(
      `select 1 from information_schema.tables where table_name = 'b2_good'`,
    );
    assert.equal(good.rowCount, 1, "the file that succeeded before the failure stays applied");
    const goodRecorded = await store.pool.query("select 1 from schema_migrations where name = $1", [
      "001_b2_good.sql",
    ]);
    assert.equal(goodRecorded.rowCount, 1, "and stays recorded");

    const recorded = await store.pool.query("select 1 from schema_migrations where name = $1", [
      "002_b2_broken.sql",
    ]);
    assert.equal(recorded.rowCount, 0, "a rolled-back file must not be recorded");

    const survived = await store.pool.query(
      `select 1 from information_schema.tables where table_name = 'b2_should_not_survive'`,
    );
    assert.equal(
      survived.rowCount,
      0,
      "the table from the first (otherwise-successful) statement in the failing file must roll back too",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("B3 — claimForGeneration on a pending row: returns true, status becomes streaming", async () => {
  const gen = await store.createGeneration("b3 test", OWNER);
  const claimed = await store.claimForGeneration(gen.id);
  assert.equal(claimed, true);
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "streaming");
});

/**
 * B4 — Promise.all issues both claims before either resolves, on two physical connections; exactly one must win.
 * Sequential awaits would pass even against the old select-then-update code.
 */
test("B4 — two claimForGeneration calls in parallel on one row: exactly one returns true", async () => {
  const gen = await store.createGeneration("b4 test", OWNER);
  const [a, b] = await Promise.all([store.claimForGeneration(gen.id), store.claimForGeneration(gen.id)]);
  const winners = [a, b].filter(Boolean).length;
  assert.equal(winners, 1, `exactly one of two truly concurrent claims must win, got ${winners}`);

  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "streaming");
});

/** B4 verification: the same methodology races a deliberately non-atomic claim and both callers win, proving the test can catch a regression. */
test("B4 verification — the same race methodology catches a deliberately non-atomic twin", async () => {
  const gen = await store.createGeneration("b4 buggy twin", OWNER);

  async function buggyReadThenWriteClaim(id: string): Promise<boolean> {
    const { rows } = await store.pool.query<{ status: string }>("select status from generations where id = $1", [id]);
    const status = rows[0]?.status;
    if (status !== "pending" && status !== "failed") return false;
    // The race window review finding F1 was about: a real concurrent caller can interleave
    // right here, between reading the old status and writing the new one.
    await new Promise((r) => setTimeout(r, 25));
    await store.pool.query("update generations set status = 'streaming' where id = $1", [id]);
    return true;
  }

  const [a, b] = await Promise.all([buggyReadThenWriteClaim(gen.id), buggyReadThenWriteClaim(gen.id)]);
  const winners = [a, b].filter(Boolean).length;
  assert.equal(winners, 2, "the non-atomic twin should let both concurrent callers win — proving this test methodology would have failed on the old code");
});

test("B5 — claimForGeneration on a streaming row: returns false", async () => {
  const gen = await store.createGeneration("b5 test", OWNER);
  assert.equal(await store.claimForGeneration(gen.id), true);
  assert.equal(await store.claimForGeneration(gen.id), false);
});

test("B6 — claimForGeneration on a complete row: returns false", async () => {
  const gen = await store.createGeneration("b6 test", OWNER);
  await store.markComplete(gen.id, "<html>done</html>");
  assert.equal(await store.claimForGeneration(gen.id), false);
});

test("B7 — claimForGeneration on a failed row: returns true — retry after failure is intended", async () => {
  const gen = await store.createGeneration("b7 test", OWNER);
  await store.markFailed(gen.id, "boom");
  assert.equal(await store.claimForGeneration(gen.id), true);
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "streaming");
});

test("B8 — resetForRetry: status back to pending, claimable again", async () => {
  const gen = await store.createGeneration("b8 test", OWNER);
  assert.equal(await store.claimForGeneration(gen.id), true);
  await store.resetForRetry(gen.id);
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "pending");
  assert.equal(await store.claimForGeneration(gen.id), true);
});

test("B9 — markComplete: sets document, clears error", async () => {
  const gen = await store.createGeneration("b9 test", OWNER);
  await store.markFailed(gen.id, "an earlier error");
  await store.markComplete(gen.id, "<html>b9 done</html>");
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "complete");
  assert.equal(row?.document, "<html>b9 done</html>");
  assert.equal(row?.error, null);
});

test("B10 — markFailed: sets error, leaves any earlier document alone", async () => {
  const gen = await store.createGeneration("b10 test", OWNER);
  await store.markComplete(gen.id, "<html>keep me</html>");
  await store.markFailed(gen.id, "b10 boom");
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "failed");
  assert.equal(row?.error, "b10 boom");
  assert.equal(row?.document, "<html>keep me</html>");
});

test("B11 — markCompleteWithPlan: stores document and plan; plan round-trips through JSONB unchanged", async () => {
  const gen = await store.createGeneration("b11 test", OWNER);
  const plan = {
    title: "B11 App",
    css: ".card{padding:8px}",
    shell: '<div data-slot="a"></div>',
    script: "",
    slots: [{ id: "a", height: 200, spec: "one thing | with a pipe" }],
    collections: [{ name: "notes", description: "user notes" }],
    content: { a: "<p>hi</p>" },
  };
  await store.markCompleteWithPlan(gen.id, "<html>b11 doc</html>", plan);
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "complete");
  assert.equal(row?.document, "<html>b11 doc</html>");
  assert.deepEqual(row?.plan, plan);
});

/** B12 — owner-scoped: newest first within one owner, and another owner's rows never appear. */
test("B12 — listRecentGenerations: newest first within one owner, respects the limit, and never returns another owner's rows", async () => {
  const b12Owner: Owner = { kind: "anon", sessionId: "b12-owner-a" };
  const otherOwner: Owner = { kind: "anon", sessionId: "b12-owner-b" };

  // One row for a different owner, interleaved first, so its presence (or absence) in the
  // results below is a real assertion, not an accident of insertion order.
  await store.createGeneration("b12-other-owner", otherOwner);
  await new Promise((r) => setTimeout(r, 15));

  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const gen = await store.createGeneration(`b12-${i}`, b12Owner);
    ids.push(gen.id);
    await new Promise((r) => setTimeout(r, 15)); // created_at has ~1ms resolution; keep inserts distinct
  }

  const recent = await store.listRecentGenerations(b12Owner, 3);
  assert.equal(recent.length, 3);
  assert.deepEqual(
    recent.map((r) => r.id),
    [ids[4], ids[3], ids[2]],
    "newest first, within this owner only",
  );

  const allForOwner = await store.listRecentGenerations(b12Owner, 20);
  assert.equal(allForOwner.length, 5, "exactly this owner's five rows, no more");
  assert.ok(
    allForOwner.every((r) => r.session_id === "b12-owner-a"),
    "every returned row must belong to this owner",
  );

  const otherList = await store.listRecentGenerations(otherOwner, 20);
  assert.equal(otherList.length, 1, "the other owner's list must contain only their own row");
  assert.equal(
    ids.includes(otherList[0]!.id),
    false,
    "none of b12Owner's rows may appear in another owner's list",
  );
});
