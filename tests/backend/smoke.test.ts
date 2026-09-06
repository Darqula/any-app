/**
 * Proves the harness itself works end to end. Not part of the real backend suite (see
 * .docs/tests-backend.md for that) — these are cases C1, D1, plus a standalone check of
 * harness/db.ts's scratch-database lifecycle and restricted-role guarantee.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { createScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";

const { Pool } = pg;

test("GET /health on both spawned servers returns the right JSON (C1, D1)", async (t) => {
  const scratch = await createScratchDatabase();
  t.after(() => scratch.drop());

  const [studioPort, sandboxPort] = await findFreePorts(2);
  const servers = await startServers({
    databaseUrl: scratch.databaseUrl,
    sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
    ports: { studio: studioPort!, sandbox: sandboxPort! },
  });
  t.after(() => servers.stop());

  const studioHealth = await (await fetch(`${servers.studioOrigin}/health`)).json();
  assert.deepStrictEqual(studioHealth, { ok: true, service: "studio" });

  const sandboxHealth = await (await fetch(`${servers.sandboxOrigin}/health`)).json();
  assert.deepStrictEqual(sandboxHealth, { ok: true, service: "sandbox" });
});

test("scratch database: migrate() runs and the restricted role is actually restricted", async (t) => {
  const scratch = await createScratchDatabase();
  t.after(() => scratch.drop());

  // createScratchDatabase() already asserts this internally (and throws loudly if it does
  // not hold), but the point of this test is to prove that guarantee from the outside too,
  // using nothing but the connection strings the harness handed back.
  const restricted = new Pool({ connectionString: scratch.sandboxDatabaseUrl });
  t.after(() => restricted.end());

  const { rows } = await restricted.query("select count(*) from records");
  assert.equal(rows[0]?.count, "0");

  await assert.rejects(
    () => restricted.query("select count(*) from generations"),
    /permission denied/i,
    "restricted role must not be able to read generations",
  );

  await assert.rejects(
    () => restricted.query("select count(*) from provider_credentials"),
    /permission denied/i,
    "restricted role must not be able to read provider_credentials",
  );
});
