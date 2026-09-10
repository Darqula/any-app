/**
 * L — accounts and sessions, M — ownership/visibility/grants, N — usage and limits.
 * Spec: impl-phase-6.md step 9's L/M/N sections. Target: packages/store/src/{users,sessions,
 * passwords,claim,generations,usage}.ts, packages/protocol/src/view-grant.ts, apps/studio/src/
 * {auth,index,internal,edits}.ts.
 *
 * L is pure store-layer, sharing ONE scratch database (same reasoning as store-db.test.ts's
 * B-series and credentials.test.ts's H1/H2/H7-H9). M and N are route-level: each case spins
 * up its own scratch database + servers, because they need the real HTTP surface (cookies,
 * the view-grant query param, the internal route's grant check).
 */
import { test, before, after } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import pg from "pg";
import { createScratchDatabase } from "../harness/db";
import type { ScratchDatabase } from "../harness/db";
import { startServers } from "../harness/servers";
import { findFreePorts } from "../harness/ports";
import { startFakeProvider } from "../harness/fake-provider";
import type { FakeProvider } from "../harness/fake-provider";
import { extractPreview, grantQuery } from "../harness/preview";
import { mintViewGrant, VIEW_GRANT_TTL_MS } from "@any-app/protocol";

const { Pool } = pg;

const PLAN_TEXT = `===TITLE===
Accounts Test App
===CSS===
.card{padding:8px}
===SHELL===
<div data-slot="alpha"></div>
===SLOTS===
alpha|200|One region
`;
const FILL_TEXT = "===SLOT alpha===\n<p>hi</p>\n";

function extractCookie(res: globalThis.Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header on this response");
  return setCookie.split(";")[0]!;
}
function cookieValue(cookie: string): string {
  return cookie.split("=")[1]!;
}

/**
 * `internal.ts`/`edits.ts` write `usage_events` in an outer `finally` block that runs AFTER
 * `res.end()` (see internal.ts's flushUsage doc comment) — the client's `fetch()` can observe
 * the response as fully complete a tick or two before that write actually lands in Postgres,
 * since the two are racing independent async operations, not sequenced by anything the client
 * can see. Polling briefly (rather than querying once, immediately after `.text()` resolves)
 * is what makes a usage_events assertion right after a stream/edit response reliable instead
 * of occasionally flaky under load — confirmed live: a bare single query here failed once in
 * a full-suite run and never failed in isolation, which is exactly this race's signature.
 */
async function waitForUsageEvents(
  databaseUrl: string,
  generationId: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ role: string; billable: boolean; prompt_tokens: number }[]> {
  const { timeoutMs = 5000 } = opts;
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { rows } = await pool.query<{ role: string; billable: boolean; prompt_tokens: number }>(
        `select role, billable, prompt_tokens from usage_events where generation_id = $1 order by created_at`,
        [generationId],
      );
      if (rows.length > 0 || Date.now() >= deadline) return rows;
      await new Promise((r) => setTimeout(r, 50));
    }
  } finally {
    await pool.end();
  }
}

// -----------------------------------------------------------------------------------------
// L — accounts and sessions (pure store layer, one shared scratch database)
// -----------------------------------------------------------------------------------------

let scratch: ScratchDatabase;
let store: typeof import("@any-app/store");

before(async () => {
  scratch = await createScratchDatabase();
  process.env.DATABASE_URL = scratch.databaseUrl;
  // L4 exercises saveCredential/getCredential, which need CREDENTIAL_KEY (crypto.ts) —
  // same pattern as credentials.test.ts's H-series freshCredentialKey().
  process.env.CREDENTIAL_KEY = randomBytes(32).toString("base64");
  store = await import("@any-app/store");
});

after(async () => {
  await store.pool.end();
  await scratch.drop();
});

test("L1 — hashPassword/verifyPassword round trip; a malformed stored hash returns false, not a throw", async () => {
  const hash = await store.hashPassword("correct horse battery staple");
  assert.equal(await store.verifyPassword("correct horse battery staple", hash), true);
  assert.equal(await store.verifyPassword("wrong password", hash), false);

  for (const malformed of [
    "",
    "not-a-hash",
    "scrypt$abc$8$1$salt$hash",
    "bcrypt$10$salt$hash",
    // A stored value whose salt/hash fields decode (via
    // Buffer.from(x, "base64"), which silently drops invalid characters) to zero-length
    // buffers. Without the length guard in passwords.ts, ALL of these return true for ANY
    // password — an authentication bypass, not a thrown error.
    "scrypt$32768$8$1$$",
    "scrypt$32768$8$1$AAAA$",
    "scrypt$32768$8$1$!!!!$!!!!",
  ]) {
    await assert.doesNotReject(async () => {
      const ok = await store.verifyPassword("anything", malformed);
      assert.equal(ok, false, `must return false, not accept every password: ${malformed}`);
    }, `verifyPassword must not throw on a malformed stored value: ${malformed}`);
  }
});

test("L2 — createUser: duplicate email returns null, not a thrown error", async () => {
  const email = `l2-${Date.now()}@example.invalid`;
  const first = await store.createUser(email, "password123");
  assert.ok(first);
  const second = await store.createUser(email.toUpperCase(), "different-password"); // case-insensitive too
  assert.equal(second, null, "a duplicate email (case-insensitive) must return null, not throw");
});

test("L3 — authenticate: wrong password and unknown email both return null, never say which", async () => {
  const email = `l3-${Date.now()}@example.invalid`;
  await store.createUser(email, "the-real-password");

  assert.equal(await store.authenticate(email, "wrong-password"), null);
  assert.equal(await store.authenticate(`nobody-${Date.now()}@example.invalid`, "anything"), null);
  const ok = await store.authenticate(email, "the-real-password");
  assert.equal(ok?.email, email.toLowerCase());
});

test("L4 — claimAnonymousWork: re-keys an anonymous session's generations and credentials to the new user, and only that session's rows", async () => {
  const anonSessionId = `l4-anon-${Date.now()}`;
  const otherAnonSessionId = `l4-other-${Date.now()}`;
  const anon = { kind: "anon" as const, sessionId: anonSessionId };
  const other = { kind: "anon" as const, sessionId: otherAnonSessionId };

  const gen = await store.createGeneration("l4 anonymous work", anon);
  const otherGen = await store.createGeneration("l4 someone else's anonymous work", other);
  await store.saveCredential(anon, "openai", "l4-anon-key", null);

  const user = await store.createUser(`l4-${Date.now()}@example.invalid`, "password123");
  assert.ok(user);
  await store.claimAnonymousWork(anonSessionId, user.id);

  // getGenerationForOwner had no production caller and its own doc
  // comment falsely claimed one ("every studio route uses this one") — deleted rather than
  // kept as a convenience only this test used. `getGeneration` (unscoped) + a direct
  // ownership-column check is what a production route would never do (see index.ts's own
  // "never call this from a studio route" comment on getGeneration), but is exactly right
  // for a test asserting on raw row state.
  const claimedRow = await store.getGeneration(gen.id);
  assert.equal(claimedRow?.owner_id, user.id, "the anonymous session's generation must now belong to the new user");
  assert.equal(claimedRow?.session_id, null, "and no longer carry the old session id");

  // The other anonymous session's work stays reachable through the real, owner-scoped
  // listing function — listRecentGenerations(other) is what a studio route actually calls.
  const stillAnonList = await store.listRecentGenerations(other, 20);
  assert.equal(stillAnonList.length, 1, "a DIFFERENT anonymous session's work must be untouched by someone else's claim");
  assert.equal(stillAnonList[0]!.id, otherGen.id);

  const claimedCred = await store.getCredential({ kind: "user", userId: user.id, sessionId: "unused" }, "openai");
  assert.equal(claimedCred?.apiKey, "l4-anon-key", "the credential must be re-keyed too, same transaction");
});

// -----------------------------------------------------------------------------------------
// M — ownership, visibility, grants (route-level, own scratch db + servers per case)
// -----------------------------------------------------------------------------------------

interface Stack {
  scratch: ScratchDatabase;
  fake: FakeProvider;
  servers: Awaited<ReturnType<typeof startServers>>;
  secret: string;
}

async function setupM(t: TestContext): Promise<Stack> {
  const scratchM = await createScratchDatabase();
  t.after(() => scratchM.drop());
  const fake = await startFakeProvider();
  t.after(() => fake.close());
  const secret = "m-series-fixed-app-token-secret";
  const [studioPort, sandboxPort] = await findFreePorts(2);
  const servers = await startServers({
    databaseUrl: scratchM.databaseUrl,
    sandboxDatabaseUrl: scratchM.sandboxDatabaseUrl,
    ports: { studio: studioPort!, sandbox: sandboxPort! },
    env: {
      LLM_PROVIDER: "openai",
      LLM_MODEL: "fake-model",
      OPENAI_API_KEY: "test-key",
      OPENAI_BASE_URL: fake.baseUrl,
      LLM_FILL_MODE: "sequential",
      APP_TOKEN_SECRET: secret,
    },
  });
  t.after(() => servers.stop());
  return { scratch: scratchM, fake, servers, secret };
}

/** Drives a full generation (through the real POST /generations + internal stream) for the
 *  given cookie (or none, for a fresh anonymous owner), returning the id/grant/cookie used. */
async function generateAs(
  stack: Stack,
  prompt: string,
  cookie?: string,
): Promise<{ id: string; grant: string; cookie: string }> {
  const createRes = await fetch(`${stack.servers.studioOrigin}/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(cookie ? { cookie } : {}),
    },
    body: new URLSearchParams({ prompt }).toString(),
  });
  const usedCookie = cookie ?? extractCookie(createRes);
  const { id, grant } = extractPreview(await createRes.text());

  stack.fake.queueComplete({ text: PLAN_TEXT });
  stack.fake.queueStream({ chunks: [FILL_TEXT], finish: "stop" });
  const streamRes = await fetch(
    `${stack.servers.studioOrigin}/internal/generations/${id}/stream${grantQuery(grant)}`,
    { headers: { "x-internal-secret": "test-internal-secret" } },
  );
  await streamRes.text();
  return { id, grant, cookie: usedCookie };
}

test("M1 — another owner's private app 404s on the frame route (never a distinguishing 403)", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M1 owner's app");

  const res = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/frame`); // no cookie -> a different, fresh anon session
  assert.equal(res.status, 404);
});

test("M2 — another owner cannot edit a private app: 404, not 403 or 500", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M2 owner's app");

  const res = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/edits`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, // no cookie
    body: new URLSearchParams({ instruction: "change it" }).toString(),
  });
  assert.equal(res.status, 404);
});

test("M3 — the owner CAN view and edit their own private app", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M3 owner's app");

  const frameRes = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/frame`, {
    headers: { cookie: owner.cookie },
  });
  assert.equal(frameRes.status, 200);
  const frameBody = await frameRes.text();
  assert.ok(frameBody.includes("edit-form"), "the owner's own frame must include the edit form");
});

test("M4 — an unlisted app is viewable by a non-owner (remix control, not edit form) but not editable by them", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M4 unlisted app");

  const setVis = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ visibility: "unlisted" }).toString(),
  });
  assert.equal(setVis.status, 200);

  // A different (fresh, cookie-less) viewer.
  const frameRes = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/frame`);
  assert.equal(frameRes.status, 200, "unlisted must be viewable without being the owner");
  const body = await frameRes.text();
  assert.ok(body.includes("Remix this app"), "a non-owner viewer gets the remix control");
  assert.ok(!body.includes("edit-form"), "a non-owner viewer must not get the owner's edit form");

  const editRes = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/edits`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" }, // still no cookie -> different session
    body: new URLSearchParams({ instruction: "change it" }).toString(),
  });
  assert.equal(editRes.status, 404, "viewing an unlisted app does not grant edit rights");
});

test("M5 — internal stream route: private app, no grant -> 404; with the owner's own grant -> 200", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M5 private app");

  const noGrant = await fetch(`${stack.servers.studioOrigin}/internal/generations/${owner.id}/stream`, {
    headers: { "x-internal-secret": "test-internal-secret" },
  });
  assert.equal(noGrant.status, 404);

  const withGrant = await fetch(
    `${stack.servers.studioOrigin}/internal/generations/${owner.id}/stream${grantQuery(owner.grant)}`,
    { headers: { "x-internal-secret": "test-internal-secret" } },
  );
  assert.equal(withGrant.status, 200);
});

test("M6 — a grant minted for app A is rejected when presented for app B", async (t) => {
  const stack = await setupM(t);
  const appA = await generateAs(stack, "M6 app A");
  const appB = await generateAs(stack, "M6 app B");

  // appA's own grant, but requesting appB's stream — verifyViewGrant's appId won't match.
  const res = await fetch(
    `${stack.servers.studioOrigin}/internal/generations/${appB.id}/stream${grantQuery(appA.grant)}`,
    { headers: { "x-internal-secret": "test-internal-secret" } },
  );
  assert.equal(res.status, 404);
});

test("M7 — an expired grant is rejected, and a tampered grant is rejected", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M7 private app");

  const expiredGrant = mintViewGrant(owner.id, "rw", Date.now() - 1000, stack.secret);
  const expiredRes = await fetch(
    `${stack.servers.studioOrigin}/internal/generations/${owner.id}/stream${grantQuery(expiredGrant)}`,
    { headers: { "x-internal-secret": "test-internal-secret" } },
  );
  assert.equal(expiredRes.status, 404, "an expired grant must be rejected, same as a missing one");

  const tampered = owner.grant.slice(0, -2) + (owner.grant.slice(-2) === "AA" ? "BB" : "AA");
  const tamperedRes = await fetch(
    `${stack.servers.studioOrigin}/internal/generations/${owner.id}/stream${grantQuery(tampered)}`,
    { headers: { "x-internal-secret": "test-internal-secret" } },
  );
  assert.equal(tamperedRes.status, 404);
});

test("M8 — fork: copies the plan (not the document), the fork's document carries no trace of the source's app token, and the fork starts private and owned by the forker", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M8 source app");

  const setVis = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ visibility: "unlisted" }).toString(),
  });
  assert.equal(setVis.status, 200);

  // A different viewer forks it.
  const forkRes = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/fork`, {
    method: "POST",
  });
  assert.equal(forkRes.status, 200);
  const forkerCookie = extractCookie(forkRes);
  const redirect = forkRes.headers.get("hx-redirect");
  assert.ok(redirect, "expected an HX-Redirect to the fork's own frame");
  const forkId = redirect!.match(/\/generations\/([0-9a-f-]{36})\/frame/)?.[1];
  assert.ok(forkId, `expected a uuid in the redirect target: ${redirect}`);
  assert.notEqual(forkId, owner.id, "the fork must be a NEW row, not the source's own id");

  const pool = new Pool({ connectionString: stack.scratch.databaseUrl });
  try {
    const { rows } = await pool.query<{
      document: string;
      visibility: string;
      owner_id: string | null;
      session_id: string | null;
      forked_from: string;
    }>(`select document, visibility, owner_id, session_id, forked_from from generations where id = $1`, [forkId]);
    const row = rows[0]!;
    assert.equal(row.visibility, "private", "a fork starts private regardless of the source's visibility");
    assert.equal(row.forked_from, owner.id);
    // The source's own live token embedded in ITS document (extracted from the owner's own
    // frame render) must never appear in the fork's document.
    const sourceStreamRes = await fetch(
      `${stack.servers.studioOrigin}/internal/generations/${owner.id}/stream${grantQuery(owner.grant)}`,
      { headers: { "x-internal-secret": "test-internal-secret" } },
    );
    const sourceDoc = await sourceStreamRes.text();
    const sourceTokenMatch = /var TOKEN = "([^"]+)"/.exec(sourceDoc);
    if (sourceTokenMatch) {
      assert.equal(row.document.includes(sourceTokenMatch[1]!), false, "the fork's stored document must not contain the source's live token");
    }
    // The fork's own stored document is placeholder-only (never a live token) — same
    // invariant as K25.
    assert.ok(row.document.includes("{{ANYAPP_TOKEN}}") || !row.document.includes("anyapp.data"), "the fork's stored document must carry the placeholder, not a live token, if it has a data runtime at all");
  } finally {
    await pool.end();
  }

  // The forker (not the source owner) owns it — the forker's own cookie can view+edit it.
  const forkFrame = await fetch(`${stack.servers.studioOrigin}/generations/${forkId}/frame`, {
    headers: { cookie: forkerCookie },
  });
  assert.equal(forkFrame.status, 200, `forker must be able to view their own fork, got ${forkFrame.status}`);
});

test("M9 — a signed-in user's own BYOK credential is used for their generation (billable=false), and the internal route inserts no throwaway sessions row", async (t) => {
  const stack = await setupM(t);

  const email = `m9-${Date.now()}@example.invalid`;
  const signupRes = await fetch(`${stack.servers.studioOrigin}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: "password123" }).toString(),
  });
  const cookie = extractCookie(signupRes);

  stack.fake.queueComplete({ text: "ok" }); // satisfies build(credential).validate(model)
  const credRes = await fetch(`${stack.servers.studioOrigin}/settings/credentials`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({
      provider: "openai",
      apiKey: "m9-byok-key",
      baseUrl: stack.fake.baseUrl,
      model: "fake-model",
    }).toString(),
  });
  assert.equal(credRes.status, 200);

  const pool = new Pool({ connectionString: stack.scratch.databaseUrl });
  try {
    const before = await pool.query<{ n: string }>(`select count(*)::text as n from sessions`);

    const createRes = await fetch(`${stack.servers.studioOrigin}/generations`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ prompt: "M9 BYOK generation" }).toString(),
    });
    const { id, grant } = extractPreview(await createRes.text());

    stack.fake.queueComplete({ text: PLAN_TEXT });
    stack.fake.queueStream({ chunks: [FILL_TEXT], finish: "stop" });
    const streamRes = await fetch(
      `${stack.servers.studioOrigin}/internal/generations/${id}/stream${grantQuery(grant)}`,
      { headers: { "x-internal-secret": "test-internal-secret" } },
    );
    await streamRes.text();

    const after = await pool.query<{ n: string }>(`select count(*)::text as n from sessions`);
    assert.equal(
      after.rows[0]!.n,
      before.rows[0]!.n,
      "the internal stream route must not insert a throwaway sessions row",
    );

    const rows = await waitForUsageEvents(stack.scratch.databaseUrl, id);
    assert.ok(rows.length > 0, "expected usage events for this generation");
    assert.ok(rows.every((r) => r.billable === false), "a generation on the user's own BYOK credential must never be billable");
  } finally {
    await pool.end();
  }
});

test("M10 — an expired-but-well-signed grant for an unlisted app the caller owns does not silently serve a read-only document", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M10 unlisted app");

  const setVis = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ visibility: "unlisted" }).toString(),
  });
  assert.equal(setVis.status, 200);

  const expiredOwnGrant = mintViewGrant(owner.id, "rw", Date.now() - 1000, stack.secret);
  const res = await fetch(
    `${stack.servers.studioOrigin}/internal/generations/${owner.id}/stream${grantQuery(expiredOwnGrant)}`,
    { headers: { "x-internal-secret": "test-internal-secret" } },
  );
  assert.equal(res.status, 200); // still a normal page response, not a 4xx/5xx
  const body = await res.text();
  assert.match(body, /expired/i, "must say the link expired, not silently render the app read-only");
  // The real document (and any live token) must not be in this response at all.
  assert.equal(body.includes('id="anyapp-css"'), false, "must not render the actual app content on an expired grant");
});

test("M11 — a complete row whose plan is not a FilledApp returns 409 on fork, not 500", async (t) => {
  const stack = await setupM(t);

  const pool = new Pool({ connectionString: stack.scratch.databaseUrl });
  let id: string;
  try {
    // A Phase-2-era-shaped plan: has SOME fields, but not the ones isFilledApp requires
    // (content/collections) — exactly the shape the fork route's cast used to trust blindly.
    const { rows } = await pool.query<{ id: string }>(
      `insert into generations (prompt, status, document, plan, visibility)
       values ($1, 'complete', $2, $3, 'unlisted') returning id`,
      ["M11 not-a-filled-app", "<!doctype html><html></html>", JSON.stringify({ title: "incomplete" })],
    );
    id = rows[0]!.id;
  } finally {
    await pool.end();
  }

  const forkRes = await fetch(`${stack.servers.studioOrigin}/generations/${id}/fork`, { method: "POST" });
  assert.equal(forkRes.status, 409, "must be a clean 409, not a 500 from an unsound cast inside forkGeneration");
});

test("M12 — a mutating request with Sec-Fetch-Site: cross-site is refused even with a valid owner cookie, and leaves state unchanged", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M12 owner's app");

  const res = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/visibility`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      cookie: owner.cookie,
      "sec-fetch-site": "cross-site",
    },
    body: new URLSearchParams({ visibility: "public" }).toString(),
  });
  assert.equal(res.status, 403);

  const pool = new Pool({ connectionString: stack.scratch.databaseUrl });
  try {
    const { rows } = await pool.query<{ visibility: string }>(`select visibility from generations where id = $1`, [owner.id]);
    assert.equal(rows[0]?.visibility, "private", "the cross-site request must not have changed visibility");
  } finally {
    await pool.end();
  }
});

test("M12b — a mutating request with Sec-Fetch-Site: same-site is refused too, not just cross-site", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M12b owner's app");

  // This is the ACTUAL attack shape F2/R1 exist for — a generated (model-written, untrusted)
  // app on <id>.apps.example.com posting back to example.com is same-site, cross-origin, so a
  // real browser sends exactly this header. `cross-site` (M12 above) is the easier case that
  // SameSite=Lax alone would already catch; this is the one that needs the guard, now that
  // SameSite=Strict is gone (R1).
  const res = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/visibility`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      cookie: owner.cookie,
      "sec-fetch-site": "same-site",
    },
    body: new URLSearchParams({ visibility: "public" }).toString(),
  });
  assert.equal(res.status, 403);

  const pool = new Pool({ connectionString: stack.scratch.databaseUrl });
  try {
    const { rows } = await pool.query<{ visibility: string }>(`select visibility from generations where id = $1`, [owner.id]);
    assert.equal(rows[0]?.visibility, "private", "the same-site request must not have changed visibility");
  } finally {
    await pool.end();
  }
});

test("M13 — GET /apps/:id: an unlisted app renders the full share page with no cookie; a private app 404s; the owner's frame links to it", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M13 shared app");

  const setVis = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ visibility: "unlisted" }).toString(),
  });
  assert.equal(setVis.status, 200);

  // A different (fresh, cookie-less) visitor — the actual shape of someone opening a link
  // from Slack or email, which is what this whole route exists for (F3).
  const sharedRes = await fetch(`${stack.servers.studioOrigin}/apps/${owner.id}`);
  assert.equal(sharedRes.status, 200);
  const sharedBody = await sharedRes.text();
  assert.match(sharedBody, /<!doctype html>/i, "must be a real standalone page, not a bare fragment");
  assert.match(sharedBody, /htmx\.min\.js/, "must load htmx itself — the frame-route fragment relies on the host page for this");
  assert.match(sharedBody, /Remix this app/, "a non-owner visitor must get the remix control");

  // The same app, private: must 404 exactly like it doesn't exist — never a distinguishing
  // status (M1's rule, applied to this route too).
  const setPrivate = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ visibility: "private" }).toString(),
  });
  assert.equal(setPrivate.status, 200);
  const privateRes = await fetch(`${stack.servers.studioOrigin}/apps/${owner.id}`);
  assert.equal(privateRes.status, 404);

  // The owner's own frame response must advertise this page as the share link, not the
  // htmx-fragment frame route — that mismatch was F3's whole failure mode (M4 passed on a
  // fetch body while the real browser experience 404'd/broke).
  await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ visibility: "unlisted" }).toString(),
  });
  const ownerFrame = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/frame`, {
    headers: { cookie: owner.cookie },
  });
  const ownerFrameBody = await ownerFrame.text();
  assert.ok(
    ownerFrameBody.includes(`/apps/${owner.id}`),
    "the owner's share link must point at the real /apps/:id page, not /generations/:id/frame",
  );
});

// -----------------------------------------------------------------------------------------
// N — usage and limits
// -----------------------------------------------------------------------------------------

test("N1 — a completed generation on the platform credential writes billable usage_events rows", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "N1 usage test");

  const rows = await waitForUsageEvents(stack.scratch.databaseUrl, owner.id);
  assert.ok(rows.length >= 2, "expected at least a planner and a fill usage event");
  assert.ok(rows.every((r) => r.billable === true), "every event must be billable — the platform credential was used, no BYOK");
  assert.ok(rows.every((r) => r.prompt_tokens > 0), "usage rows must carry real token counts");
  assert.ok(rows.some((r) => r.role === "planner"));
  assert.ok(rows.some((r) => r.role === "fill"));
});

test("N2 — a monthly cap already at/over the limit blocks a NEW generation before it ever claims the row or calls the provider", async (t) => {
  const stack = await setupM(t);

  // Sign up a real account so it has a userId to attach a monthly_token_limit to, and a
  // generation row owned by that account.
  const email = `n2-${Date.now()}@example.invalid`;
  const signupRes = await fetch(`${stack.servers.studioOrigin}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: "password123" }).toString(),
  });
  const cookie = extractCookie(signupRes);

  const createRes = await fetch(`${stack.servers.studioOrigin}/generations`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
    body: new URLSearchParams({ prompt: "N2 capped generation" }).toString(),
  });
  const { id, grant } = extractPreview(await createRes.text());

  const pool = new Pool({ connectionString: stack.scratch.databaseUrl });
  try {
    // A cap of 0: billableTokensThisMonth is always >= 0, so this trips deterministically
    // regardless of any prior usage this user might have.
    await pool.query(`update users set monthly_token_limit = 0 where email = $1`, [email.toLowerCase()]);

    const res = await fetch(
      `${stack.servers.studioOrigin}/internal/generations/${id}/stream${grantQuery(grant)}`,
      { headers: { "x-internal-secret": "test-internal-secret" } },
    );
    assert.equal(res.status, 200); // the route itself still answers 200 with an error banner
    const body = await res.text();
    assert.match(body, /Monthly token limit reached/);
    assert.equal(stack.fake.requestCount(), 0, "the cap must be enforced BEFORE any provider call");

    const { rows } = await pool.query<{ status: string }>(`select status from generations where id = $1`, [id]);
    assert.equal(rows[0]?.status, "failed", "the row is marked failed by the cap check, not left streaming");
  } finally {
    await pool.end();
  }
});

test("N3 — a monthly cap already at the limit also blocks an EDIT, not just a fresh generation", async (t) => {
  const stack = await setupM(t);

  const email = `n3-${Date.now()}@example.invalid`;
  const signupRes = await fetch(`${stack.servers.studioOrigin}/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password: "password123" }).toString(),
  });
  const cookie = extractCookie(signupRes);

  // A complete app owned by this same user, generated (and billed) BEFORE the cap is set.
  const owner = await generateAs(stack, "N3 capped edit target", cookie);

  const pool = new Pool({ connectionString: stack.scratch.databaseUrl });
  try {
    const before = await pool.query<{ version: number }>(`select version from generations where id = $1`, [owner.id]);

    await pool.query(`update users set monthly_token_limit = 0 where email = $1`, [email.toLowerCase()]);

    // `generateAs` already made 2 provider calls (planner + fill) for the initial
    // generation, above — the cap must add zero more, not start counting from zero.
    const requestsBeforeEdit = stack.fake.requestCount();
    const editRes = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/edits`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", cookie },
      body: new URLSearchParams({ instruction: "change it", target: "css" }).toString(),
    });
    assert.equal(editRes.status, 503);
    const body = await editRes.text();
    assert.match(body, /Monthly token limit reached/);
    assert.equal(
      stack.fake.requestCount(),
      requestsBeforeEdit,
      "the cap must be enforced before any provider call, including the router",
    );

    const after = await pool.query<{ version: number }>(`select version from generations where id = $1`, [owner.id]);
    assert.equal(after.rows[0]?.version, before.rows[0]?.version, "a refused edit must not bump the row's version");
  } finally {
    await pool.end();
  }
});
