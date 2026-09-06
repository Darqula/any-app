/**
 * B1–B12 — store and database. Spec: .docs/tests-backend.md section B.
 * Target: packages/store/src/{generations,migrate}.ts, against a real, migrated scratch
 * Postgres database (packages/store/migrations/*.sql via harness/db.ts's createScratchDatabase()).
 *
 * All twelve cases share ONE scratch database, created once for the whole file (see the
 * top-level `before`/`after` below) rather than one per test — deliberate, per the README's
 * carve-out ("not a shared top-level before/after unless a whole file's cases genuinely
 * share one scratch database on purpose"): every case here exercises the same store layer
 * against the same schema, and per-test isolation is achieved by giving each test its own
 * fresh `generations` row via `createGeneration`, not by paying for a fresh migrate() child
 * process (several seconds each) twelve times over.
 *
 * `@any-app/store` is imported dynamically, inside `before`, AFTER `process.env.DATABASE_URL`
 * is pointed at the scratch database — `packages/store/src/db.ts` builds its `Pool` from
 * `requireEnv("DATABASE_URL")` at module scope, so a static top-level import (which ESM
 * hoists and evaluates before any of this file's own code runs) would bind to whatever
 * `DATABASE_URL` happened to be in `process.env` first, not our scratch database. See the
 * README's "Module-scope side effects" obstacle and harness/db.ts's own doc comment for the
 * same trap from the other direction (why db.ts never imports `@any-app/store` at all).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createScratchDatabase } from "../harness/db";
import type { ScratchDatabase } from "../harness/db";

let scratch: ScratchDatabase;
let store: typeof import("@any-app/store");

before(async () => {
  scratch = await createScratchDatabase();
  process.env.DATABASE_URL = scratch.databaseUrl;
  store = await import("@any-app/store");
});

after(async () => {
  // Close the store's own singleton pool before dropping the database — see the README's
  // "cleanup-order trap": a pool still open when drop() runs gets an unsolicited
  // pg_terminate_backend, which fires the pool's "error" event and crashes the process if
  // nothing is listening. Doing both here, in order, in one place sidesteps the ordering
  // question entirely rather than relying on t.after() registration order.
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
 * B2 — a failing migration: the transaction rolls back and the file is not recorded.
 *
 * Drives the REAL `migrate()` against a throwaway migrations directory in the OS temp dir.
 * This was previously only a contract check (the same begin/insert/commit sequence hand-run
 * against Postgres, which proved Postgres's atomicity but not that `migrate.ts` still
 * contained the try/catch) because `migrationsDir` was a module-scope constant derived from
 * `import.meta.url`, and the only alternative was writing a deliberately-broken `.sql` into
 * the real, shared `packages/store/migrations/` — where every concurrent
 * `createScratchDatabase()` would have picked it up. `migrate()` now takes an optional
 * directory (testing-review.md S7), so the real function can be pointed somewhere private.
 *
 * The good file is applied first and must survive; the bad one must leave nothing behind —
 * neither its own half-applied table nor a `schema_migrations` row.
 */
test("B2 — a failing migration rolls back and is not recorded, while earlier files stay applied", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "anyapp-b2-"));
  try {
    await writeFile(path.join(dir, "001_b2_good.sql"), "create table b2_good (id int);", "utf8");
    // Two statements in one file: the first succeeds, the second fails on the duplicate
    // name. That is what makes this a rollback test and not just an "it threw" test — the
    // table created by the first statement must be gone too.
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
  const gen = await store.createGeneration("b3 test");
  const claimed = await store.claimForGeneration(gen.id);
  assert.equal(claimed, true);
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "streaming");
});

/**
 * B4 — the regression test for review finding F1. Two genuinely concurrent connections (via
 * `Promise.all`, which issues both `claimForGeneration` calls before either resolves — the
 * pool hands out two separate physical connections for two concurrent queries) racing on one
 * row: exactly one must return true. A sequential pair of `await`s would pass even against
 * the old non-atomic (select-then-update) code, which is exactly the trap this avoids.
 */
test("B4 — two claimForGeneration calls in parallel on one row: exactly one returns true", async () => {
  const gen = await store.createGeneration("b4 test");
  const [a, b] = await Promise.all([store.claimForGeneration(gen.id), store.claimForGeneration(gen.id)]);
  const winners = [a, b].filter(Boolean).length;
  assert.equal(winners, 1, `exactly one of two truly concurrent claims must win, got ${winners}`);

  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "streaming");
});

/**
 * B4 verification (not a spec case on its own): proves the Promise.all-concurrent-race
 * methodology used above actually has teeth, by racing a deliberately non-atomic "old style"
 * claim (read status, sleep to widen the race window, then write) against itself on a fresh
 * row on the SAME database. If this methodology could not catch a non-atomic implementation,
 * B4 passing would tell us nothing. It does catch it: both calls win the race below.
 */
test("B4 verification — the same race methodology catches a deliberately non-atomic twin", async () => {
  const gen = await store.createGeneration("b4 buggy twin");

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
  const gen = await store.createGeneration("b5 test");
  assert.equal(await store.claimForGeneration(gen.id), true);
  assert.equal(await store.claimForGeneration(gen.id), false);
});

test("B6 — claimForGeneration on a complete row: returns false", async () => {
  const gen = await store.createGeneration("b6 test");
  await store.markComplete(gen.id, "<html>done</html>");
  assert.equal(await store.claimForGeneration(gen.id), false);
});

test("B7 — claimForGeneration on a failed row: returns true — retry after failure is intended", async () => {
  const gen = await store.createGeneration("b7 test");
  await store.markFailed(gen.id, "boom");
  assert.equal(await store.claimForGeneration(gen.id), true);
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "streaming");
});

test("B8 — resetForRetry: status back to pending, claimable again", async () => {
  const gen = await store.createGeneration("b8 test");
  assert.equal(await store.claimForGeneration(gen.id), true);
  await store.resetForRetry(gen.id);
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "pending");
  assert.equal(await store.claimForGeneration(gen.id), true);
});

test("B9 — markComplete: sets document, clears error", async () => {
  const gen = await store.createGeneration("b9 test");
  await store.markFailed(gen.id, "an earlier error");
  await store.markComplete(gen.id, "<html>b9 done</html>");
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "complete");
  assert.equal(row?.document, "<html>b9 done</html>");
  assert.equal(row?.error, null);
});

test("B10 — markFailed: sets error, leaves any earlier document alone", async () => {
  const gen = await store.createGeneration("b10 test");
  await store.markComplete(gen.id, "<html>keep me</html>");
  await store.markFailed(gen.id, "b10 boom");
  const row = await store.getGeneration(gen.id);
  assert.equal(row?.status, "failed");
  assert.equal(row?.error, "b10 boom");
  assert.equal(row?.document, "<html>keep me</html>");
});

test("B11 — markCompleteWithPlan: stores document and plan; plan round-trips through JSONB unchanged", async () => {
  const gen = await store.createGeneration("b11 test");
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

test("B12 — listRecentGenerations: newest first, respects the limit", async () => {
  // Runs last in the file on purpose (node:test runs top-level tests in one file
  // sequentially, in declaration order, by default — no other test is inserting rows
  // concurrently) so the three newest rows in the whole shared scratch database are
  // deterministically our own last three inserts.
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const gen = await store.createGeneration(`b12-${i}`);
    ids.push(gen.id);
    await new Promise((r) => setTimeout(r, 15)); // created_at has ~1ms resolution; keep inserts distinct
  }

  const recent = await store.listRecentGenerations(3);
  assert.equal(recent.length, 3);
  assert.deepEqual(
    recent.map((r) => r.id),
    [ids[4], ids[3], ids[2]],
  );
});
