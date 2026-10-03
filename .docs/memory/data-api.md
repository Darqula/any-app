# Generated-app data API: incidents and traps

Background for `packages/records` and `apps/sandbox`. Read the query-parser trap below before touching `data.ts`
or query parsing.

## Why `records` is its own package

It has its own pool and its own `loadEnv`, never `@any-app/store`. Importing even one export from store
evaluates its module graph, including a module-scope pool built as the *privileged* role plus the credential
code; `pg`'s Pool is lazy so nothing connects, but a privileged pool one `import` away undoes the restricted
role's whole point (Phase 5 review S1). Duplicating ~15 lines of env loading is intentional.

## Timestamps and cursors (S1, S1-R)

- Default `pg` returns `timestamptz` as a JS `Date`, and `Date.prototype.toString()` ("Tue Sep 01 2026 …") was
  what `encodeCursor` embedded. `Date.parse` re-parses that, so `decodeCursor` never caught it, but Postgres
  rejects it (SQLSTATE 22023) when the cursor returns as a bind parameter: page two 500'd.
- The first fix went through `new Date(v).toISOString()` and introduced a narrower bug (S1-R): `Date` has
  millisecond resolution, Postgres stores **microseconds**, so two rows within one millisecond straddling a
  page boundary both compared "not less than" the truncated cursor and vanished from both pages, silently.
  Fix: a type parser that hand-formats Postgres's text, keeping all six digits, which assumes `+00`.
- The `+00` is guaranteed by the pool's `options: "-c TimeZone=UTC"`, a libpq **startup parameter**. A
  `pool.on("connect")` `SET TIME ZONE` raced the first query (never a correctness bug, since node-postgres
  queues per client, but it printed a "query() called while already executing" deprecation under load).
- `decodeCursor` validates both halves (Phase 5 review S2: `base64url("x|y")` used to reach Postgres and fail
  loudly instead of answering 400).

## Traps

- **Express 5's default query parser has no bracket notation.** Without `app.set("query parser","extended")`,
  `where[finished]=true` becomes a flat key named `"where[finished]"`, `req.query.where` is undefined, and the
  filter silently matches everything. Found live; K6 pins it.
- `where[done]=true` arrives as the string `"true"`, which does not match a stored boolean under `@>`
  (type-sensitive), so obvious cases are coerced.
- The quota is approximate under concurrency on purpose (a bound on growth, not a ledger). The token bucket is
  in process memory: with several sandbox instances the fix is a shared counter, not a bigger `Map`.
- `updateRecord` merges cumulatively, so per-request body limits are not enough: the size cap lives in the SQL
  `where`. Zero rows back is ambiguous (missing vs too large); the route disambiguates with `getRecord`.
- Express's default error handler writes stack traces into responses when `NODE_ENV` is unset (it is, here), so
  the sandbox has its own terminal handler; 4xx pass through (a 413 was once collapsed to 500), 5xx stay opaque.
- A shared viewer's token is read-only: a public app's data must not be world-writable.
- `Referrer-Policy: no-referrer` on previews: the view grant is in the URL and generated apps load CDN libraries.
- `PREVIEW_TIMEOUT_MS` (900 000) bounds a runaway; the studio's heartbeat stops undici's ~300 s inactivity
  timeout from firing on a merely slow generation.
