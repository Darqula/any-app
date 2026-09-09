# @any-app/tests — harness contract

This package is test **infrastructure**, not the test suites themselves. `.docs/tests-backend.md`
and `.docs/tests-frontend.md` describe what should eventually be tested; this README describes
what you have to build it with. Read this before writing a single case.

Everything here was built and verified end to end on this machine (Windows, Postgres in the
shared `my-postgres` container, Node 22). Three smoke tests exist to prove it actually works:
`backend/smoke.test.ts` (cases C1/D1, plus a standalone check of the scratch-database
lifecycle) and `frontend/smoke.spec.ts` (case A1). Run them before you doubt something in this
document — they're cheap.

```powershell
npm run test:backend    # node:test, ephemeral ports, ~5-10s
npm run test:frontend   # Playwright, real localhost:3000 / *.apps.localhost:3001, ~7-10s
npm run test            # both, sequentially — see "Ports" below for why never concurrently
```

## Env-var precedence (verified empirically — don't re-derive this)

`process.loadEnvFile()` (what `packages/store/src/env.ts`'s `loadEnv()` calls) does **NOT**
override a variable already present in `process.env`. Confirmed with:

```js
process.env.FOO = "fromParent";
process.loadEnvFile(".env");   // .env contains FOO=fromFile
process.env.FOO;               // still "fromParent"
```

So a variable set directly in a spawned child's `env` always wins over anything a `.env` file
sets. That alone would be enough to make `startServers`/`createScratchDatabase` correct — but
both still ALSO write every resolved variable into a generated `.env` in an isolated scratch
directory and set `cwd` there, per the task brief's instruction to prefer that shape regardless
of which way precedence went. Two reasons this still matters even though the "just pass env
directly" half already works:

- It means a spawned server's `loadEnv()` walk (`.env`, `../../.env`, `../../../.env` relative
  to its `cwd`) never finds the **real** repo-root `.env` at all, so a stray var this harness
  forgot to override (there shouldn't be any — see the default table below) can't leak the
  real `OPENAI_API_KEY`/`ANTHROPIC_API_KEY` into a test process by accident.
- It's correct regardless of Node ever changing this precedence in a future version.

**A second, separate finding, specific to `harness/db.ts`:** cache-busting a dynamic
`import()` (appending `?t=...` to the specifier) only busts *that one module's* cache entry —
not its own relatively-imported dependencies. `@any-app/store`'s `index.ts` re-exports `pool`
from `./db`, and `./db`'s resolved URL is identical on every import regardless of how
`index.ts` itself was loaded, so a second cache-busted import of `@any-app/store` in the same
process silently reuses the **first** call's `pool` (bound to the first `DATABASE_URL`). This
is why `createScratchDatabase()` runs `migrate()` in a **child process**
(`packages/store/src/migrate-cli.ts`, the same entry `npm run migrate` already uses) instead of
importing `@any-app/store` in-process, and why `db.ts` and `seed.ts` talk to Postgres with raw
`pg` directly rather than through `@any-app/store` or `@any-app/records`. Net effect for you:
**`createScratchDatabase()` is safe to call more than once in the same test process** (it does
not share any singleton across calls) — verified by the backend smoke test, which calls it
twice in one `node --test` file.

## Windows loopback quirk (verified empirically — this is obstacle 3, made concrete)

On this machine, binding to hostname `"localhost"` (what `apps/studio` does) resolves to
**`::1` only** — a client connecting via `127.0.0.1` gets `ECONNREFUSED` against it. `apps/sandbox`
binds `"127.0.0.1"` explicitly, and the reverse holds: connecting via bare `"localhost"` prefers
`::1` and gets refused there. Both are real, current behavior, confirmed with a throwaway probe
server — not a hypothetical. Consequently:

- Always reach **studio** via `http://localhost:<port>`, never `127.0.0.1`.
- Always reach **sandbox's own origin** (`/health`, `/preview/:id`) via `http://127.0.0.1:<port>`,
  never bare `localhost`.
- Per-app origins (`<id>.apps.localhost:<port>`) are unaffected — confirmed separately that
  `*.apps.localhost` resolves straight to `127.0.0.1` (not `::1`) with no hosts-file entry,
  which is exactly where sandbox listens. This holds for both Chromium and plain Node `fetch`.

`RunningServers.studioOrigin` / `.sandboxOrigin` / `.appOrigin(id)` already encode all of this —
use them rather than reconstructing origins yourself.

## `harness/ports.ts`

```ts
findFreePort(): Promise<number>
findFreePorts(count: number): Promise<number[]>
```

Binds to `127.0.0.1:0`, reads back the assigned port, releases it. Small TOCTOU race between
release and the real server binding it — acceptable for test tooling. **Never pass port `0`
to `startServers`** — both servers log the port they were *told*, not whatever the OS actually
picked, so a `0` is undiscoverable afterward.

## `harness/db.ts`

```ts
createScratchDatabase(): Promise<{
  databaseUrl: string;         // superuser connection to a fresh, migrated anyapp_test_<rand> db
  sandboxDatabaseUrl: string;  // anyapp_sandbox_test role's connection to that same db
  dbName: string;
  drop(): Promise<void>;       // drops only the database, never the role, never `anyapp`
}>

readSuperuserDatabaseUrl(): string   // reads DATABASE_URL out of the real repo-root .env
                                       // WITHOUT ever setting it on process.env
SANDBOX_TEST_ROLE = "anyapp_sandbox_test"   // the fixed, cluster-global role name
```

What it does, in order: `CREATE DATABASE anyapp_test_<random>` as the superuser → ensures
`anyapp_sandbox_test` exists cluster-wide (idempotent `DO $$ ... EXCEPTION WHEN
duplicate_object` block, fixed dev password, never touched by `drop()`) → runs the project's
real `migrate()` against the new database, out-of-process (see the precedence section above
for why) → grants that role `select, insert, update, delete on records` and `usage on schema
public`, on this database only → **verifies** the role can read `records` but gets
`permission denied` on `generations` and `provider_credentials`, throwing loudly (not a
warning) if either check fails. That verification is not optional or a nice-to-have — backend
case K22 depends on it actually holding, and it is checked fresh on every call, never assumed.

Never touches the real `anyapp` database. `drop()` terminates any lingering backend
connections on the scratch database first (a just-stopped server's pool can take a moment to
release sockets), then drops it.

## `harness/servers.ts`

```ts
startServers(opts: {
  databaseUrl: string;
  sandboxDatabaseUrl: string;
  ports: { studio: number; sandbox: number };   // required — see ports.ts above
  env?: Record<string, string>;                 // overrides layered on top of safe defaults
}): Promise<{
  studioOrigin: string;        // http://localhost:<port> — always this hostname, see above
  sandboxOrigin: string;       // http://127.0.0.1:<port> — always this hostname, see above
  appOriginTemplate: string;   // http://{id}.apps.localhost:<port>
  appOrigin(id: string): string;
  studioPort: number;
  sandboxPort: number;
  stop(): Promise<void>;       // kills both process trees, removes scratch env dirs
}>
```

Spawns `apps/studio/src/index.ts` and `apps/sandbox/src/index.ts` as real child processes
under `tsx` (there is no in-process/supertest-style path — see "Known obstacles" below) and
polls both `/health` endpoints (up to 30s) before resolving. If a server exits before
answering healthy, the error includes its captured stdout+stderr.

**`stop()` reliably kills the whole process tree on Windows.** Verified empirically: `tsx`
(non-`watch` mode) re-execs itself as a **separate child OS process**
(`node --require preflight.cjs --import loader.mjs ...`) — the pid `spawn()` hands you is the
wrapper, not the one actually running `index.ts`. `child.kill()` alone only kills the wrapper
and orphans the real process. `stop()` uses `taskkill /PID <pid> /T /F` (the whole tree) — a
full three-suite run followed by a process-list check left zero stray `node.exe` processes.

**Two port modes**, both going through the same `ports` param — there's no separate mode flag:

- **Ephemeral** (backend suite): `{ studio: await findFreePort(), sandbox: await findFreePort() }`.
- **Fixed real origins** (frontend suite): `{ studio: 3000, sandbox: 3001 }` — see
  `frontend/global-setup.ts` for the working example. Required because `swapRuntime` bakes
  `STUDIO_PUBLIC_URL` into every generated document (checked against `event.origin` on every
  `postMessage`), and the data API derives its host check from `SANDBOX_APP_ORIGIN_TEMPLATE`.

### Default env, and what you must override yourself

Every var in the "Callers must be able to override" list from the task brief is settable via
`opts.env`. Safe defaults ship for everything else so a smoke run never touches a real
provider:

| Var | Default | Notes |
|---|---|---|
| `DATABASE_URL`, `SANDBOX_DATABASE_URL` | from `opts` | required, no default |
| `STUDIO_PORT`, `SANDBOX_PORT` | from `opts.ports` | |
| `STUDIO_INTERNAL_URL`, `STUDIO_PUBLIC_URL` | `http://localhost:<studio port>` | |
| `SANDBOX_APP_ORIGIN_TEMPLATE` | `http://{id}.apps.localhost:<sandbox port>` | |
| `INTERNAL_SECRET` | `"test-internal-secret"` | |
| `CREDENTIAL_KEY`, `APP_TOKEN_SECRET` | fresh random 32-byte base64, per call | required at boot or the server refuses to start |
| `PREVIEW_TIMEOUT_MS` | `900000` | |
| `LLM_PROVIDER` / `LLM_MODEL` / `LLM_MAX_TOKENS` | `openai` / `test-harness-placeholder-model` / `1000` | **see below — this is load-bearing** |
| `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `ANTHROPIC_API_KEY`, `ANTHROPIC_BASE_URL` | `""` (unset) | no real provider by default |

**Why `LLM_MODEL` still has a default, even though this is fixed now:** `packages/generator/src/roles.ts`'s
`roleConfig()` throws a plain `Error` — not `NoCredentialError` — if no model is configured
for a role at all (`LLM_MODEL` / `LLM_<ROLE>_MODEL` both unset). This used to propagate out of
`missingCredentials()` (which only caught `NoCredentialError`) and turn a plain empty-state
page load into a 500 — see testing-review.md **S3**, fixed 2026-09-01: `missingCredentials()`
now catches that too and reports it the same way as a missing credential (a banner, not a
crash). The placeholder default here stays regardless, since a real deployment should always
have a model configured and this harness has no reason to be the one exception.

## `harness/seed.ts`

```ts
seedGeneration(databaseUrl: string, input: {
  prompt?: string;                 // default: "seeded generation"
  status?: "pending" | "streaming" | "complete" | "failed";  // default: "complete"
  document: string;                // required — the flat assembled HTML
  plan?: unknown;                  // a FilledApp shape, or omit for a pre-Phase-2-shaped row
  error?: string | null;
}): Promise<{ id: string; appToken(secret: string): string }>

mintAppToken(appId: string, secret: string): string   // re-exported from @any-app/protocol
```

This is the frontend suite's main lever. `apps/studio/src/internal.ts`'s stream route returns
a `complete` row's stored `document` **before** it claims the row and **before** it resolves
any credential — so a seeded row renders through the whole stack with no provider configured
at all. Use it for every case `tests-frontend.md`'s "Seeding instead of generating" names (B1–B10,
C1/E5/E7, H1–H4) instead of driving a real generation.

`seedGeneration` opens and closes its own short-lived `pg.Pool` per call — like `db.ts`, it
never imports `@any-app/store`, so it's safe to call repeatedly against different scratch
databases in one process.

`appToken(secret)` needs the same `APP_TOKEN_SECRET` you passed (or let default) into
`startServers` — grab it from the same `opts.env` object you built, or pass a fixed one
explicitly to both if a test needs to compute a token before starting the servers.

## Ports: which suite owns what, and why they can't run concurrently

- **Backend suite**: ephemeral ports only, via `findFreePorts`. Never binds `3000`/`3001`.
- **Frontend suite**: the real `localhost:3000` / `*.apps.localhost:3001`, hardcoded in
  `frontend/global-setup.ts`. Cannot randomize — see `startServers`'s port-mode note above.

Because the frontend suite claims the real dev ports, it **cannot run at the same time as**
the backend suite (irrelevant — different ports) **or `npm run dev`** (relevant — same ports,
and `npm run dev` points at the real `anyapp` database). The root `test` script runs
`test:backend && test:frontend` — sequentially, on purpose, per the task brief. Don't
parallelize it.

## Known obstacles (from the task brief, resolved — here's how)

1. **Env precedence** — see above. Resolved via explicit `env` + a scratch-directory `.env`,
   belt and suspenders.
2. **Module-scope side effects** — `packages/store/src/db.ts` builds a `Pool` from
   `requireEnv("DATABASE_URL")` at module scope; `apps/*/src/index.ts` call `app.listen()` at
   module scope with no exported app factory. No in-process supertest-style testing is
   possible. `servers.ts` spawns real child processes; `db.ts`/`seed.ts` avoid the singleton
   entirely by talking to Postgres with raw `pg` and running `migrate()` in a child process —
   see the precedence section above for the specific caching trap this sidesteps.
3. **`localhost` → `::1` on Windows** — see above. Baked into `RunningServers`'s returned
   origins; use them rather than hand-rolling URLs.

## `harness/fake-provider.ts`

A real HTTP server (plain `node:http`, ephemeral port, no new dependency) that speaks both
wire formats the two provider adapters (`packages/generator/src/providers/{openai,anthropic}.ts`)
parse: OpenAI chat-completions SSE on `POST /chat/completions`, and Anthropic Messages SSE on
`POST /v1/messages` — plus their non-streaming counterparts, since `planner`/`edit`/`router`
all call `completeText` and only `fill` streams. Built as **one scripted core with two
serialisers**, not two servers — see `.docs/tests-backend.md`'s "harness decision" section for
why. `tests/backend/fake-provider.test.ts` is the proof this is faithful: it imports the
*real* adapters (`createOpenAIProvider` / `createAnthropicProvider`, by relative path — they
are not part of `@any-app/generator`'s public `exports`) and runs them against this fixture,
rather than asserting on what the fixture merely wrote to a socket.

```ts
startFakeProvider(): Promise<FakeProvider>

interface FakeProvider {
  baseUrl: string;                 // e.g. http://127.0.0.1:54321 — the bare API prefix;
                                    // each SDK appends its own endpoint path itself
  requestCount(): number;
  requests(): CapturedRequest[];   // every request received, matched or not, in order
  queueStream(script?: StreamScript): StreamHandle;
  queueComplete(script?: CompleteScript): CompleteHandle;
  queueError(script: ErrorScript): CompleteHandle;
  emit(text: string, delayMs?: number): Promise<void>;   // sugar — see below
  close(): Promise<void>;
}

interface CapturedRequest {
  format: "openai" | "anthropic";
  method: string; path: string;
  headers: Record<string, string>;
  body: any;              // the full parsed request body — assert on system-prompt
                           // placement (G9) or anything else actually sent from here
  system: string | null;  // convenience extraction of the above
  receivedAt: number;
  aborted: boolean;       // true once the client socket closed before this fake finished
                           // writing its response — see backend C10
}

interface StreamHandle {
  connected: Promise<CapturedRequest>;
  emit(text: string, delayMs?: number): Promise<void>;   // one delta/text_delta event
  finish(opts?: { finish?: FinishKind; stopDetails?: StopDetailsSpec; usage?: UsageSpec }): Promise<void>;
  done: Promise<void>;
}

interface CompleteHandle {
  connected: Promise<CapturedRequest>;
  done: Promise<void>;
}

// FinishKind = "stop" | "content_filter" | "refusal" — "content_filter" is OpenAI-only,
// "refusal" is Anthropic-only; the serialiser throws a clear error rather than emit a wire
// shape that provider doesn't have (see fake-provider.ts's openaiFinishReason /
// anthropicStopReason).
```

**Queueing is FIFO, across both endpoints.** A queued response is matched to the *next*
incoming request regardless of which path it lands on — queue responses in the exact order
you expect `planner` → `fill` → ... to call out (`queueComplete` for a non-streaming role,
`queueStream` for `fill`). A request landing with the queue empty gets a clear 500 explaining
why, rather than hanging — that is almost always a sign the test queued responses in the
wrong order, or one fewer/more than the code path actually calls.

**Two ways to drive a stream — pick per test, not per fixture:**

- **Auto-play** — pass `chunks` (a `(string | { text, delayMs })[]`). Each chunk is sent as
  its own delta event, in order, honoring its own `delayMs` (the knob backend E4 needs — "a
  fake that delays its first chunk 2s"), then the stream finishes on its own. This is what
  almost every backend case wants.
- **Manual / explicit chunk-driving** — omit `chunks` entirely (not even `[]` — see the
  gotcha below) and drive the returned `StreamHandle` yourself: `await handle.emit(text)` for
  each piece, then `await handle.finish()` when done. This is the frontend suite's
  requirement (`tests-frontend.md`'s Harness section: "explicit `await fake.emit(chunk)`
  chunk-driving... rather than racing against real timing") — it lets a test hold a response
  open, assert an intermediate render state, then release the next chunk. `fake.emit(text)`
  (top-level, no handle needed) is sugar for "emit into the most recently queued stream that
  is still open" — reach for the handle's own `.emit()` instead when a test juggles more than
  one stream.

  **Gotcha:** `chunks: []` and omitting `chunks` are different modes. `chunks: []` is
  auto-play with zero content chunks (the empty-response shape, or a refusal with no text) —
  it finishes itself. Omitting `chunks` leaves the handle open indefinitely; nothing finishes
  it but your own `handle.finish()` call. `close()` force-ends anything still open at
  teardown so a forgotten `finish()` cannot hang a test process, but a real test should still
  call it.

**Splitting a marker across chunk boundaries** — the actual mechanic backend A6 and the
`===SLOT id===` contract care about — is just splitting the *text*, not the transport: two
`emit()` calls (or two entries in `chunks`) whose concatenation is the marker, e.g.
`chunks: ["===SLO", "T timer===\n<div>...</div>\n"]`. Each becomes one complete, well-formed
SSE frame; what the real adapter sees split is the accumulated delta text, exactly like a
real model's output arriving in arbitrary pieces.

**Error shapes:**

```ts
fake.queueStream({ chunks: ["partial "], finish: "content_filter" });   // OpenAI refusal
fake.queueStream({ chunks: [], finish: "refusal",
  stopDetails: { type: "refusal", category: "policy_violation" } });    // Anthropic, WITH
fake.queueStream({ chunks: [], finish: "refusal" });                    // Anthropic, WITHOUT
fake.queueStream({ chunks: [] });                                       // empty response
fake.queueError({ status: 500 });                                       // HTTP 500
```

`queueError`'s `retryable` option (default `false`) sets the `x-should-retry` response
header — both the OpenAI and Anthropic SDKs check this header *before* falling back to their
own status-code retry heuristic (confirmed by reading both SDKs' `shouldRetry()` in
`node_modules`). Leaving it at the default means one scripted error is exactly one request;
without it, a scripted 500 would silently become up to three requests, non-deterministically
delayed by the SDK's own backoff — pass `true` only when a test deliberately wants to exercise
that retry behavior.

**Worked example** — pointing `startServers` at the fixture, the whole integration point:

```ts
const fake = await startFakeProvider();
t.after(() => fake.close());

const servers = await startServers({
  databaseUrl: scratch.databaseUrl,
  sandboxDatabaseUrl: scratch.sandboxDatabaseUrl,
  ports: { studio: studioPort, sandbox: sandboxPort },
  env: {
    LLM_PROVIDER: "openai",
    LLM_MODEL: "fake-model",
    OPENAI_API_KEY: "test-key",
    OPENAI_BASE_URL: fake.baseUrl,       // simplest case — every role uses the fake
    // Or, to point only one role at the fake (backend G13 — an unconfigured role must still
    // fail cleanly, before any HTTP call) and leave another's default (no credential)
    // behavior intact:
    // LLM_FILL_PROVIDER: "openai", LLM_FILL_MODEL: "fake-model",
    // LLM_FILL_MAX_TOKENS: "2000",
  },
});
t.after(() => servers.stop());

fake.queueComplete({ text: PLAN_TEXT });                 // planner
fake.queueStream({ chunks: FILL_CHUNKS, finish: "stop" }); // fill

const res = await fetch(`${servers.studioOrigin}/internal/generations/${id}/stream`, {
  headers: { [INTERNAL_SECRET_HEADER]: "test-internal-secret" },
});
```

See `tests/backend/studio-stream.test.ts` (case C7) for the full working version of this,
including how to extract a generation id from `POST /generations`'s response and how to
assert on the persisted row afterward.

**A cleanup-order trap worth knowing before writing more cases**: `t.after()` hooks run in
**registration order** (confirmed empirically — Node does not reverse them the way some other
test runners' teardown does). `createScratchDatabase()`'s `drop()` runs
`pg_terminate_backend` on every other connection to the scratch database; if a test opens its
own `pg.Pool` to that database and defers closing it via a `t.after()` registered *after*
`scratch.drop()`'s, that pool is still open when `drop()` runs, and the resulting unsolicited
termination fires the pool's `"error"` event — with nothing listening for it, that crashes
the whole test process (this was caught live writing `studio-stream.test.ts`'s C7 case).
Close such a pool inline (`try { ... } finally { await pool.end(); }`) before the test
function returns, rather than deferring it, and the ordering question never comes up.

## Adding real test cases

- Follow `backend/smoke.test.ts`'s shape: `node:test`, `t.after(...)` for cleanup (not a
  shared top-level `before`/`after` unless a whole file's cases genuinely share one scratch
  database on purpose).
- Follow `frontend/smoke.spec.ts` / `global-setup.ts`'s shape for anything needing seeded rows
  or the real origins. A spec that only needs `D1`–`D11` (the `swap()` runtime, unit-tested
  against a static page) needs neither — see `tests-frontend.md`'s suggested order.
- `npm run typecheck` at the repo root must stay green — `tests/**/*.ts` is included in the
  root `tsconfig.json`.
