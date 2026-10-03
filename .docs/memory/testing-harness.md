# Test harness: traps

Background for `tests/harness/`. The contract, interfaces and worked examples are `tests/README.md`; run the
suites from `tests/` and never concurrently. The frontend suite needs the real ports 3000/3001, so it fails
confusingly if `npm run dev` is running (seeded rows go to the scratch database while the browser talks to the
dev server's database).

- **Migrations run in a child process.** `@any-app/store`'s pool is a module-scope singleton bound to the first
  `DATABASE_URL`, and cache-busting an entry specifier does not bust its relative imports (confirmed), so a
  second in-process import reuses the first database's pool. Everything else here uses `pg` directly.
- The sandbox role is cluster-global while its grant is per-database; `verifyRoleIsRestricted` throws because
  backend case K22 depends on it. The superuser URL is read from `.env` without setting `process.env`.
- Children get a minimal environment; vars passed directly beat a server's `loadEnv()` (`loadEnvFile` does not
  override), and a scratch `.env` is written too as belt and braces.
- **`killTree`**: tsx re-execs itself as a separate OS process, so `child.kill()` orphans the server. POSIX uses
  detached process groups (H1); Windows uses `taskkill /T`.
- Ephemeral ports for backend, real ports for frontend (`swapRuntime` bakes `STUDIO_PUBLIC_URL` into documents).
  Never `0`: the servers log the port they were *given*. Studio is `localhost` (`::1` here, `127.0.0.1` refused);
  the sandbox is `127.0.0.1` (does not accept `::1`).
- `servers.logs()` exists for C15 (an aborted planner call must not fall back to linear: only the log line
  distinguishes it) and H5 (no credential in logs). It is buffered, capped, and read after the fact.
- **Fake provider**: FIFO matching regardless of endpoint; an empty queue is a clear 500. A `queueStream` script for
  a non-streaming request errors, so edits and the router need `queueComplete`. `retryable` defaults to `false`
  or the SDK retries a scripted 500 up to twice. Anthropic `message_start` must precede every event even for a
  zero-content response (the fixture's own self-test caught that; the real SDK rejects it). `queueStream()`
  returns a proxy handle before any response object exists.
- **Seeding**: `harness/seed.ts` inserts with `pg`; a `complete` row renders with no provider because the
  internal route serves the stored document before claiming or resolving credentials. It defaults to
  `unlisted` so previews need no grant. Since Phase 6 the sidebar is owner-scoped, so seeded rows must carry the
  anonymous session id (the cookie value) of the page that will look at them; direct preview/stream calls need
  the view grant from the iframe `src`.
