/**
 * L: accounts and sessions, M: ownership/visibility/grants, N: usage and limits. L is store-level and shares one
 * scratch database; M and N need the HTTP surface (cookies, grant param, internal route), so each case has its own database and servers.
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
 * usage_events are written in a finally that runs after res.end(), so a client can see the response complete a tick before the row lands.
 * Polling makes the assertion reliable (a bare query failed once in a full run and never alone).
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
    // Fields that decode to zero-length buffers (Buffer.from base64 drops invalid characters). Without the length guard they verify for ANY
    // password: an authentication bypass, not an exception.
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

  // getGenerationForOwner had no production caller and was deleted. Raw ownership columns are read through the unscoped getGeneration,
  // which a production route must not use but a test asserting row state should.
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

/** Drives a real generation (POST /generations plus the internal stream) for a cookie, or a fresh anonymous owner if none. */
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
  assert.equal(res.status, 200);
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

  // The real attack: a model-written app on <id>.apps.example.com posting to example.com is same-site and cross-origin, so a browser
  // sends this header. cross-site (M12) is the easier case; this one needs the guard, now that SameSite=Strict is gone.
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

  // The owner's frame must advertise the share page, not the htmx fragment route (F3: M4 passed on a body while the browser experience broke).
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


async function deleteApp(stack: Stack, id: string, cookie?: string): Promise<globalThis.Response> {
  return fetch(`${stack.servers.studioOrigin}/generations/${id}`, {
    method: "DELETE",
    headers: cookie ? { cookie } : {},
  });
}

async function scalar(databaseUrl: string, sql: string, params: unknown[]): Promise<string | null> {
  const pool = new Pool({ connectionString: databaseUrl });
  try {
    const { rows } = await pool.query(sql, params);
    return rows[0] ? String(Object.values(rows[0])[0]) : null;
  } finally {
    await pool.end();
  }
}

test("M14 — the owner can delete an app: 200, the row and its records are gone, the frame 404s afterwards", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M14 owner's app");

  const pool = new Pool({ connectionString: stack.scratch.databaseUrl });
  try {
    await pool.query(`insert into records (app_id, collection, data) values ($1, 'notes', '{"a":1}')`, [owner.id]);
  } finally {
    await pool.end();
  }

  const res = await deleteApp(stack, owner.id, owner.cookie);
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "", "a successful delete sends an empty body — the page removes the row itself");

  assert.equal(await scalar(stack.scratch.databaseUrl, `select count(*) from generations where id = $1`, [owner.id]), "0");
  assert.equal(await scalar(stack.scratch.databaseUrl, `select count(*) from records where app_id = $1`, [owner.id]), "0");

  const frame = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/frame`, { headers: { cookie: owner.cookie } });
  assert.equal(frame.status, 404);
  const again = await deleteApp(stack, owner.id, owner.cookie);
  assert.equal(again.status, 404, "deleting an already-deleted app is a 404, not a 500");
});

test("M15 — another owner (or no cookie) cannot delete a private app: 404, and the app is untouched", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M15 owner's app");
  const other = await generateAs(stack, "M15 someone else's app");

  for (const cookie of [undefined, other.cookie]) {
    const res = await deleteApp(stack, owner.id, cookie);
    assert.equal(res.status, 404);
  }
  assert.equal(await scalar(stack.scratch.databaseUrl, `select count(*) from generations where id = $1`, [owner.id]), "1");

  // A non-uuid id is a 404 too, not a Postgres "invalid input syntax" 500.
  assert.equal((await deleteApp(stack, "not-a-uuid", owner.cookie)).status, 404);
});

test("M16 — a generation still streaming cannot be deleted (409) until its row goes stale; usage events and remixes survive a delete", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M16 owner's app");
  const usageBefore = await waitForUsageEvents(stack.scratch.databaseUrl, owner.id);
  assert.ok(usageBefore.length > 0, "the fixture generation must have recorded usage");

  const pool = new Pool({ connectionString: stack.scratch.databaseUrl });
  try {
    await pool.query(`update generations set status = 'streaming', updated_at = now() where id = $1`, [owner.id]);
    const busy = await deleteApp(stack, owner.id, owner.cookie);
    assert.equal(busy.status, 409);
    assert.match(await busy.text(), /Still generating/);
    assert.equal(await scalar(stack.scratch.databaseUrl, `select count(*) from generations where id = $1`, [owner.id]), "1");

    // A row stuck in `streaming` by a crashed process must not be undeletable forever.
    await pool.query(`update generations set updated_at = now() - interval '1 hour' where id = $1`, [owner.id]);
    await pool.query(`update generations set status = 'complete' where id = $1`, [owner.id]); // restore for the fork below
    const fork = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/fork`, {
      method: "POST",
      headers: { cookie: owner.cookie },
    });
    assert.equal(fork.status, 200);
    await pool.query(`update generations set status = 'streaming', updated_at = now() - interval '1 hour' where id = $1`, [owner.id]);

    const res = await deleteApp(stack, owner.id, owner.cookie);
    assert.equal(res.status, 200);

    const { rows: usageAfter } = await pool.query(`select 1 from usage_events where generation_id is null and role = $1`, [usageBefore[0]!.role]);
    assert.ok(usageAfter.length > 0, "usage_events rows survive with generation_id set null, so the monthly cap still counts them");
    const { rows: forks } = await pool.query(`select forked_from from generations where forked_from is null and id <> $1`, [owner.id]);
    assert.ok(forks.length > 0, "a remix survives its source's deletion, with forked_from set null");
  } finally {
    await pool.end();
  }
});

test("M17 — GET /generations returns the sidebar list fragment for the caller only, uncached, so the page can refresh it live", async (t) => {
  const stack = await setupM(t);
  const mine = await generateAs(stack, "M17 mine");
  const theirs = await generateAs(stack, "M17 theirs");

  const res = await fetch(`${stack.servers.studioOrigin}/generations`, { headers: { cookie: mine.cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  const body = await res.text();
  assert.ok(body.includes(`data-id="${mine.id}"`), "the caller's own app is listed, keyed by id");
  assert.ok(!body.includes(theirs.id), "another owner's app must never appear in this owner's list");
  assert.ok(!body.includes("<html"), "it is a fragment, not a page");

  // No cookie -> a fresh anonymous owner with nothing yet: the empty state, never someone else's rows.
  const anon = await (await fetch(`${stack.servers.studioOrigin}/generations`)).text();
  assert.ok(anon.includes("No apps yet"));
});

test("M18 — while a follow-up edit runs the sidebar list shows \"updating\" and the app cannot be deleted; both clear when it finishes", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M18 owner's app");
  const list = async () =>
    (await fetch(`${stack.servers.studioOrigin}/generations`, { headers: { cookie: owner.cookie } })).text();
  assert.match(await list(), /status-complete/);

  stack.fake.queueComplete({ text: "<p>edited</p>", delayMs: 1500 });
  const edit = fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/edits`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ instruction: "change it", target: "alpha" }).toString(),
  });
  await new Promise((r) => setTimeout(r, 500)); // the edit is in its (delayed) model call

  const during = await list();
  assert.match(during, /status-updating">updating</, "the persisted status is still complete; the badge comes from the in-memory tracker");
  assert.doesNotMatch(during, /status-complete/);
  const refused = await deleteApp(stack, owner.id, owner.cookie);
  assert.equal(refused.status, 409);
  assert.equal(await scalar(stack.scratch.databaseUrl, `select count(*) from generations where id = $1`, [owner.id]), "1");

  const done = await edit;
  assert.equal(done.status, 200);
  await done.text();
  assert.match(await list(), /status-complete/, "the flag is cleared once the edit (and its usage write) is done");
  assert.equal((await deleteApp(stack, owner.id, owner.cookie)).status, 200);
});

test("M19 — the conversation log: prompt first, then the build result and each follow-up; owner-only; cursor-based; deleted with the app", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M19 a weekly planner");
  const messages = async (after: number, cookie?: string) =>
    fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/messages?after=${after}`, { headers: cookie ? { cookie } : {} });

  // The frame route renders the whole conversation (prompt as message zero) into the log.
  const frame = await (await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/frame`, { headers: { cookie: owner.cookie } })).text();
  assert.ok(frame.includes(`id="chat-log"`) && frame.includes(`data-app="${owner.id}"`));
  assert.ok(frame.includes("M19 a weekly planner"), "message zero is the prompt");
  assert.match(frame, /Built &quot;Accounts Test App&quot; with 1 region\./, "the finished build is recorded, escaped");

  // A follow-up: the user's line and the outcome are both recorded, after the build message.
  stack.fake.queueComplete({ text: "<p>edited</p>" });
  const edit = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/edits`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ instruction: "<b>make it bigger</b>", target: "alpha" }).toString(),
  });
  assert.equal(edit.status, 200);
  await edit.text();
  const all = await (await messages(0, owner.cookie)).text();
  assert.match(all, /&lt;b&gt;make it bigger&lt;\/b&gt;/, "user text is escaped, never interpreted as markup");
  assert.ok(all.includes("Updated alpha."));
  assert.ok(!all.includes("M19 a weekly planner"), "the prompt is rendered by frame/create, never re-sent by the poll");
  assert.match(all, /chat-user/);

  // Cursor: nothing after the newest seq.
  const seqs = [...all.matchAll(/data-seq="(\d+)"/g)].map((m) => Number(m[1]));
  assert.ok(seqs.length >= 3, "build result, user follow-up, edit result");
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), "oldest first");
  const none = await (await messages(Math.max(...seqs), owner.cookie)).text();
  assert.ok(!none.includes("data-seq"), "nothing newer than the newest message");

  // A failed edit is recorded as an error the user can read back.
  stack.fake.queueError({ status: 500 });
  const bad = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/edits`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ instruction: "this fails", target: "alpha" }).toString(),
  });
  assert.equal(bad.status, 500);
  assert.match(await (await messages(Math.max(...seqs), owner.cookie)).text(), /chat-error/);

  // Owner-only: no cookie / another owner get a 404 and no content; a non-owner's frame gets
  // an empty, hidden log rather than the owner's history.
  const other = await generateAs(stack, "M19 someone else");
  assert.equal((await messages(0)).status, 404);
  assert.equal((await messages(0, other.cookie)).status, 404);
  await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/visibility`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ visibility: "unlisted" }).toString(),
  });
  const sharedFrame = await (await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/frame`, { headers: { cookie: other.cookie } })).text();
  assert.ok(sharedFrame.includes(`data-app=""`) && !sharedFrame.includes("M19 a weekly planner"));

  // Deleting the app deletes its conversation (cascade), leaving no orphan rows.
  assert.equal(await scalar(stack.scratch.databaseUrl, `select count(*) from messages where generation_id = $1`, [owner.id]) !== "0", true);
  assert.equal((await deleteApp(stack, owner.id, owner.cookie)).status, 200);
  assert.equal(await scalar(stack.scratch.databaseUrl, `select count(*) from messages where generation_id = $1`, [owner.id]), "0");
});

test("M20 — a stylesheet edit that comes back unchanged is refused honestly (422), saves nothing, and is logged as an error, not \"Updated styling.\"", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M20 owner's app");
  const version = () => scalar(stack.scratch.databaseUrl, `select version from generations where id = $1`, [owner.id]);
  const before = await version();

  // The plan's stylesheet is ".card{padding:8px}" (PLAN_TEXT). A model told to return it
  // untouched when the request needs a new control gives exactly that back.
  stack.fake.queueComplete({ text: ".card{padding:8px}" });
  const res = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/edits`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ instruction: "add a dark theme switch", target: "css" }).toString(),
  });
  assert.equal(res.status, 422);
  const body = await res.text();
  assert.match(body, /came back unchanged/);
  assert.doesNotMatch(body, /Updated/);
  assert.equal(await version(), before, "no new version is saved for a no-op");

  const log = await (await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/messages?after=0`, { headers: { cookie: owner.cookie } })).text();
  assert.match(log, /chat-error/);
  assert.doesNotMatch(log, /Updated styling/);

  // A real change still goes through, and does bump the version.
  stack.fake.queueComplete({ text: ".card{padding:16px}" });
  const ok = await fetch(`${stack.servers.studioOrigin}/generations/${owner.id}/edits`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
    body: new URLSearchParams({ instruction: "more padding", target: "css" }).toString(),
  });
  assert.equal(ok.status, 200);
  assert.notEqual(await version(), before);
});

test("M21 — the page frame is editable: a caption can be removed, damaged regions are refused, and no-op edits are not reported as updates", async (t) => {
  const stack = await setupM(t);
  const owner = await generateAs(stack, "M21 owner's app");
  const url = `${stack.servers.studioOrigin}/generations/${owner.id}/edits`;
  const post = (fields: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", cookie: owner.cookie },
      body: new URLSearchParams(fields).toString(),
    });
  const shell = () => scalar(stack.scratch.databaseUrl, `select plan->>'shell' from generations where id = $1`, [owner.id]);
  const version = () => scalar(stack.scratch.databaseUrl, `select version from generations where id = $1`, [owner.id]);

  // 1. Add a caption to the frame (the region placeholder must survive untouched).
  stack.fake.queueComplete({ text: `<p class="cap">Played across a chessboard</p>\n<div data-slot="alpha"></div>` });
  const added = await post({ instruction: "add a caption", target: "@shell" });
  assert.equal(added.status, 200);
  const addedBody = await added.text();
  assert.match(addedBody, /"type":"reload"/, "a frame edit tells the page to reload the preview; it cannot be patched in place");
  assert.match(addedBody, /Updated the page frame\./);
  assert.match((await shell())!, /Played across a chessboard/);
  const v1 = await version();

  // 2. Remove it again — the case that failed live: text in the frame, no region owns it.
  stack.fake.queueComplete({ text: `<div data-slot="alpha"></div>` });
  assert.equal((await post({ instruction: "remove the caption", target: "@shell" })).status, 200);
  assert.doesNotMatch((await shell())!, /chessboard/);
  const v2 = await version();
  assert.notEqual(v2, v1);

  // The persisted document (what a reload serves) carries the new frame, region content intact.
  const doc = await scalar(stack.scratch.databaseUrl, `select document from generations where id = $1`, [owner.id]);
  assert.doesNotMatch(doc!, /chessboard/);
  assert.match(doc!, /<p>hi<\/p>/);

  // 3. A rewrite that loses the region placeholder is refused and saves nothing.
  stack.fake.queueComplete({ text: `<h1>No regions here</h1>` });
  const damaged = await post({ instruction: "simplify", target: "@shell" });
  assert.equal(damaged.status, 502);
  assert.match(await damaged.text(), /damaged the page's regions/);
  assert.equal(await version(), v2);

  // 4. An unchanged frame, and an unchanged region, are 422s — not "Updated".
  stack.fake.queueComplete({ text: `<div data-slot="alpha"></div>` });
  const sameShell = await post({ instruction: "change nothing", target: "@shell" });
  assert.equal(sameShell.status, 422);
  assert.doesNotMatch(await sameShell.text(), /Updated/);

  stack.fake.queueComplete({ text: "<p>hi</p>" });
  const sameSlot = await post({ instruction: "remove the caption", target: "alpha" });
  assert.equal(sameSlot.status, 422);
  assert.match(await sameSlot.text(), /Nothing changed in &quot;alpha&quot;/);
  assert.equal(await version(), v2, "no-op edits never bump the version");
});

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
