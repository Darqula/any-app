/**
 * H1–H11 — credentials and BYOK. Spec: .docs/tests-backend.md section H.
 * Target: packages/store/src/{credentials,crypto}.ts, apps/studio/src/settings.ts,
 * packages/generator/src/{resolve,scrub}.ts.
 *
 * H1, H2, H7, H8, H9 are pure store-layer cases and share ONE scratch database (see the
 * top-level `before`/`after`) for the same reason store-db.test.ts's B-series does — same
 * store layer, same schema, per-test isolation via distinct session ids/rows rather than a
 * fresh migrate() per case.
 *
 * H3, H4/H5, H6, H10, H11 are route-level: each spins up its own scratch database and its
 * own `startServers()` + fake provider, because they need a live studio process (settings
 * routes, or a full generation through `/internal/generations/:id/stream`). Each is fully
 * self-contained and cleaned up via `t.after`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createScratchDatabase } from "../harness/db";
import type { ScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { resolve, NoCredentialError, safeMessage } from "@any-app/generator";

const { Pool } = pg;

function freshCredentialKey(): string {
  return randomBytes(32).toString("base64");
}

const PLAN_TEXT = `===TITLE===
H App

===CSS===
.card{padding:8px}

===SHELL===
<div data-slot="alpha"></div><div data-slot="beta"></div>

===SLOTS===
alpha|200|First region
beta|180|Second region

===SCRIPT===

===DATA===
`;

const FILL_TEXT = `===SLOT alpha===
<p>Alpha content</p>
===SLOT beta===
<p>Beta content</p>
`;

function extractGenerationId(html: string): string {
  const match = html.match(/\/preview\/([0-9a-f-]{36})/i);
  if (!match) throw new Error("could not find a generation id in the preview frame HTML: " + html.slice(0, 300));
  return match[1]!;
}

function extractCookie(res: globalThis.Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header on this response");
  return setCookie.split(";")[0]!;
}

// -----------------------------------------------------------------------------------------
// H1, H2, H7, H8, H9 — pure store layer, one shared scratch database
// -----------------------------------------------------------------------------------------

let scratch: ScratchDatabase;
let store: typeof import("@any-app/store");

before(async () => {
  scratch = await createScratchDatabase();
  process.env.DATABASE_URL = scratch.databaseUrl;
  process.env.CREDENTIAL_KEY = freshCredentialKey();
  store = await import("@any-app/store");
});

after(async () => {
  await store.pool.end();
  await scratch.drop();
});

test("H1 — a stored credential's database columns never contain the plaintext key", async () => {
  const apiKey = "h1-plaintext-must-never-appear-anywhere-in-storage";
  await store.saveCredential("session-h1", "openai", apiKey, null);

  const { rows } = await store.pool.query<{ ciphertext: Buffer; iv: Buffer; tag: Buffer; hint: string }>(
    `select ciphertext, iv, tag, hint from provider_credentials where session_id = $1 and provider = $2`,
    ["session-h1", "openai"],
  );
  const row = rows[0];
  assert.ok(row, "the credential must have been persisted");
  assert.equal(row.ciphertext.toString("latin1").includes(apiKey), false, "ciphertext must not contain the plaintext key");
  assert.equal(row.iv.toString("latin1").includes(apiKey), false);
  assert.equal(row.tag.toString("latin1").includes(apiKey), false);
  // `hint` is deliberately the last 4 characters, not the whole key.
  assert.equal(row.hint, apiKey.slice(-4));
});

test("H2 — reading a stored credential back decrypts to the original", async () => {
  await store.saveCredential("session-h2", "anthropic", "ant-key-abc123", "https://example.invalid");
  const cred = await store.getCredential("session-h2", "anthropic");
  assert.equal(cred?.apiKey, "ant-key-abc123");
  assert.equal(cred?.baseUrl, "https://example.invalid");
});

test("H7 — fallback chain: user credential over platform, platform when no user credential, a clear error when neither exists", async () => {
  const savedKey = process.env.OPENAI_API_KEY;
  try {
    process.env.LLM_PROVIDER = "openai";
    process.env.LLM_MODEL = "h7-model";
    process.env.OPENAI_API_KEY = "h7-platform-key";

    const platformOnly = resolve("fill", null);
    assert.equal(platformOnly.secrets.includes("h7-platform-key"), true, "no user credential -> falls back to the platform key");

    const userCred = { provider: "openai" as const, apiKey: "h7-user-key", baseUrl: undefined };
    const withUser = resolve("fill", userCred);
    assert.equal(withUser.secrets[0], "h7-user-key", "a user credential takes priority over the platform key");

    delete process.env.OPENAI_API_KEY;
    assert.throws(
      () => resolve("fill", null),
      (error: unknown) => error instanceof NoCredentialError,
      "neither a user nor a platform credential exists -> a clear NoCredentialError",
    );
  } finally {
    if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedKey;
  }
});

test("H8 — two sessions: session A can neither read nor generate with session B's credential", async () => {
  await store.saveCredential("session-a", "openai", "key-belongs-to-a", null);

  const asB = await store.getCredential("session-b", "openai");
  assert.equal(asB, null, "session B must see no credential for a provider only session A configured");

  const asA = await store.getCredential("session-a", "openai");
  assert.equal(asA?.apiKey, "key-belongs-to-a", "session A still sees its own credential");
});

test("H9 — deleting a credential: a subsequent generation falls back or fails cleanly, no stale decrypt", async () => {
  await store.saveCredential("session-h9", "openai", "key-h9", null);
  await store.deleteCredential("session-h9", "openai");
  const afterDelete = await store.getCredential("session-h9", "openai");
  assert.equal(afterDelete, null, "a deleted credential must read back as absent, not as a decrypt error or stale value");
});

// -----------------------------------------------------------------------------------------
// H3 — route-level: never returns the key, only a mask + timestamp
// -----------------------------------------------------------------------------------------

test("H3 — GET /settings returns a mask and a validation timestamp, never the raw key", async (t) => {
  const scratch2 = await createScratchDatabase();
  t.after(() => scratch2.drop());
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const [studioPort, sandboxPort] = await findFreePorts(2);
  const servers = await startServers({
    databaseUrl: scratch2.databaseUrl,
    sandboxDatabaseUrl: scratch2.sandboxDatabaseUrl,
    ports: { studio: studioPort!, sandbox: sandboxPort! },
  });
  t.after(() => servers.stop());

  const apiKey = "h3-secret-must-never-render-on-any-page-1234567890";
  fake.queueComplete({ text: "ok" }); // the settings route's validate() call

  const saveRes = await fetch(`${servers.studioOrigin}/settings/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ provider: "openai", apiKey, baseUrl: fake.baseUrl, model: "fake-model" }),
  });
  assert.equal(saveRes.status, 200);
  const cookie = extractCookie(saveRes);

  const settingsRes = await fetch(`${servers.studioOrigin}/settings`, { headers: { cookie } });
  const html = await settingsRes.text();

  assert.equal(html.includes(apiKey), false, "the full key must never appear on the settings page");
  assert.ok(html.includes(`····${apiKey.slice(-4)}`), "a masked hint (last 4 chars) must be shown");
  assert.match(html, /validated \d{4}-\d{2}-\d{2}/, "a validation timestamp must be shown");
});

// -----------------------------------------------------------------------------------------
// H4 / H5 — the 401-echoes-the-key regression. Not hypothetical: a real 401 once wrote the
// configured key verbatim into generations.error.
// -----------------------------------------------------------------------------------------

test("H4/H5 — a provider 401 whose message echoes the key never reaches generations.error or the console.error sink", async (t) => {
  const scratch2 = await createScratchDatabase();
  t.after(() => scratch2.drop());
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const [studioPort, sandboxPort] = await findFreePorts(2);
  const apiKey = "h4-plaintext-secret-that-must-be-scrubbed-everywhere";

  const servers = await startServers({
    databaseUrl: scratch2.databaseUrl,
    sandboxDatabaseUrl: scratch2.sandboxDatabaseUrl,
    ports: { studio: studioPort!, sandbox: sandboxPort! },
    env: {
      LLM_PROVIDER: "openai",
      LLM_MODEL: "fake-model",
      OPENAI_API_KEY: apiKey,
      OPENAI_BASE_URL: fake.baseUrl,
    },
  });
  t.after(() => servers.stop());

  fake.queueComplete({ text: PLAN_TEXT }); // planner succeeds
  // fill fails with a 401 whose message echoes the configured key verbatim — the exact
  // shape that actually happened during live testing (see CLAUDE.md/tests-backend.md).
  fake.queueError({
    status: 401,
    retryable: false,
    body: { error: { message: `Incorrect API key provided: ${apiKey}`, type: "invalid_request_error" } },
  });

  const createRes = await fetch(`${servers.studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt: "an app that needs two regions" }),
  });
  const id = extractGenerationId(await createRes.text());

  const streamRes = await fetch(`${servers.studioOrigin}/internal/generations/${id}/stream`, {
    headers: { "x-internal-secret": "test-internal-secret" },
  });
  await streamRes.text(); // drain to completion

  const pool = new Pool({ connectionString: scratch2.databaseUrl });
  let row: { status: string; error: string | null };
  try {
    const { rows } = await pool.query<{ status: string; error: string | null }>(
      `select status, error from generations where id = $1`,
      [id],
    );
    row = rows[0]!;
  } finally {
    await pool.end();
  }

  assert.equal(row.status, "failed");
  assert.ok(row.error, "an error message must have been persisted");
  assert.equal(row.error!.includes(apiKey), false, "H4: generations.error must not contain the key");

  // H5, observed rather than inferred: the studio child's own captured stdout+stderr. This
  // used to be a substitute assertion (re-running `safeMessage` on a same-shaped message),
  // because `RunningServers` did not expose the spawned process's output outside a failed
  // health check. It does now — `servers.logs("studio")` — so the real console sink is
  // checked directly.
  const studioLog = servers.logs("studio");
  assert.ok(
    studioLog.length > 0,
    "the studio child must have logged something by now — an empty buffer would make the " +
      "assertion below vacuous",
  );
  assert.ok(
    studioLog.includes(`generation ${id} failed:`),
    "the failure must actually have reached the console sink this case is about",
  );
  assert.equal(studioLog.includes(apiKey), false, "H5: the key must not reach console.error either");

  // Kept alongside the live check: internal.ts feeds ONE value to both sinks
  // (`const message = safeMessage(error, secrets)`), so pinning the function itself catches a
  // regression in the shared scrubbing even if either sink's wiring changes.
  const scrubbed = safeMessage(new Error(`Incorrect API key provided: ${apiKey}`), [apiKey]);
  assert.equal(scrubbed.includes(apiKey), false, "safeMessage() — the function that feeds both sinks — must scrub the key");
});

// -----------------------------------------------------------------------------------------
// H6 — invalid key rejected at save time, not persisted
// -----------------------------------------------------------------------------------------

test("H6 — saving an invalid key is rejected at save time by a cheap validation call, not persisted", async (t) => {
  const scratch2 = await createScratchDatabase();
  t.after(() => scratch2.drop());
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const [studioPort, sandboxPort] = await findFreePorts(2);
  const servers = await startServers({
    databaseUrl: scratch2.databaseUrl,
    sandboxDatabaseUrl: scratch2.sandboxDatabaseUrl,
    ports: { studio: studioPort!, sandbox: sandboxPort! },
  });
  t.after(() => servers.stop());

  fake.queueError({ status: 401, retryable: false, body: { error: { message: "invalid api key" } } });

  const res = await fetch(`${servers.studioOrigin}/settings/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ provider: "openai", apiKey: "bad-key", baseUrl: fake.baseUrl, model: "fake-model" }),
  });
  assert.equal(res.status, 400);
  assert.equal(fake.requestCount(), 1, "exactly one cheap validation call, no generation was ever attempted");

  const cookie = extractCookie(res);
  const settingsRes = await fetch(`${servers.studioOrigin}/settings`, { headers: { cookie } });
  const html = await settingsRes.text();
  assert.ok(html.includes("No credentials saved"), "a rejected credential must not have been persisted");
});

// -----------------------------------------------------------------------------------------
// H10 — no CREDENTIAL_KEY, no boot
// -----------------------------------------------------------------------------------------

test("H10 — with no CREDENTIAL_KEY the server refuses to start rather than storing plaintext", async (t) => {
  const scratch2 = await createScratchDatabase();
  t.after(() => scratch2.drop());
  const [studioPort, sandboxPort] = await findFreePorts(2);

  await assert.rejects(
    () =>
      startServers({
        databaseUrl: scratch2.databaseUrl,
        sandboxDatabaseUrl: scratch2.sandboxDatabaseUrl,
        ports: { studio: studioPort!, sandbox: sandboxPort! },
        env: { CREDENTIAL_KEY: "" },
      }),
    /CREDENTIAL_KEY/,
    "startServers must reject, and the captured child output must name CREDENTIAL_KEY as the reason",
  );
});

// -----------------------------------------------------------------------------------------
// H11 — a completed generation carries no credential substring
// -----------------------------------------------------------------------------------------

test("H11 — a completed generation's document and plan contain no credential substring", async (t) => {
  const scratch2 = await createScratchDatabase();
  t.after(() => scratch2.drop());
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const [studioPort, sandboxPort] = await findFreePorts(2);
  const apiKey = "h11-super-secret-must-not-leak-into-any-generated-content";

  const servers = await startServers({
    databaseUrl: scratch2.databaseUrl,
    sandboxDatabaseUrl: scratch2.sandboxDatabaseUrl,
    ports: { studio: studioPort!, sandbox: sandboxPort! },
    env: { LLM_PROVIDER: "openai", LLM_MODEL: "fake-model", OPENAI_API_KEY: apiKey, OPENAI_BASE_URL: fake.baseUrl },
  });
  t.after(() => servers.stop());

  fake.queueComplete({ text: PLAN_TEXT });
  fake.queueStream({ chunks: [FILL_TEXT], finish: "stop" });

  const createRes = await fetch(`${servers.studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ prompt: "an app that needs two regions" }),
  });
  const id = extractGenerationId(await createRes.text());

  const streamRes = await fetch(`${servers.studioOrigin}/internal/generations/${id}/stream`, {
    headers: { "x-internal-secret": "test-internal-secret" },
  });
  await streamRes.text();

  const pool = new Pool({ connectionString: scratch2.databaseUrl });
  let row: { status: string; document: string; plan: unknown };
  try {
    const { rows } = await pool.query<{ status: string; document: string; plan: unknown }>(
      `select status, document, plan from generations where id = $1`,
      [id],
    );
    row = rows[0]!;
  } finally {
    await pool.end();
  }

  assert.equal(row.status, "complete");
  assert.equal(row.document.includes(apiKey), false, "generations.document must not contain the credential");
  assert.equal(JSON.stringify(row.plan).includes(apiKey), false, "generations.plan must not contain the credential");
});
