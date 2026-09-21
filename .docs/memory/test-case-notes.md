# Test suite notes: traps and why cases look the way they do

Background for `tests/backend` and `tests/frontend`. Case lists: `tests-backend.md`, `tests-frontend.md`.

## Conventions and traps

- `t.after()` runs in *registration* order. A `pg.Pool` still open when `scratch.drop()` runs
  `pg_terminate_backend` fires an unhandled `"error"` and crashes the test process, so pools are closed inline,
  the store's pool is ended before the drop, and `drop()` is registered before `stop()`.
- Store-level files import `@any-app/store` dynamically after setting `DATABASE_URL` (module-scope pool).
  Modules outside the package `exports` map are imported by relative path.
- A shared scratch database is deliberate only where every case exercises the same layer (B, H1/H2/H7-H9, L, and
  all 25 K cases); isolation comes from own rows/app ids. Route-level cases get their own database and servers.
- **Verified-by-breaking cases:** E4 still passed with `res.flushHeaders()` deleted (the next write flushes
  headers) but went red with a buffering middleware (shell at 2142 ms vs the required < 500 ms), so it enforces
  "streams unbuffered", which is what `compression` would break. C15 needs the log line, not the HTTP outcome (S9).
  C10 once asserted the opposite while S8 stood. B4 races two concurrent claims, and its "verification" case races a
  deliberately non-atomic claim to prove the method has teeth. B2 drives the real `migrate()` against a private
  directory (S7).
- **K21 is not "the 61st write is a 429"**: the bucket refills continuously (one token per second), so where the
  first 429 lands depends on how long the burst takes, which made it the main source of intermittent failures
  under concurrent files. It asserts a sustained burst is cut off, not before capacity, and reads still work.
  Usage events are written after `res.end()`, so `waitForUsageEvents` polls.
- J: `asCompleted` must not leave unhandled rejections when the generator throws (Node 22 would kill the server
  on a closed tab); `limitConcurrency` must `release()` on the reject path (the test timeout detects a deadlock).
  `fillSlotWithRetry`/`prewarm` are unexported, so J6-J9 go through `fillAllSlots`; J10/J11 pin
  `LLM_FILL_CONCURRENCY=1` so the fake's FIFO lines up with plan order.
- Known limits pinned on purpose: slot content is forwarded unescaped (a literal `</template>` would close early
  in a browser, A6) and trailing whitespace past the 16-byte hold-back can leak while a fence never does (A2.6).
- S13 mechanism tests use the CSS of a real artifact
  (`tests/quality/artifacts/2026-09-06T17-31-26-174Z/parallel-contact-form.html`), which also has an unfixed
  generated-code bug: its script queries the outer skeleton wrapper (S12), which never carries `hidden`.

## Frontend suite

- Specs run in separate worker processes, so global-setup hands the connection string and `appTokenSecret` over
  through a temp file (`HANDOFF_PATH`). Cases needing a real generation run their own isolated stack on ephemeral
  ports; an earlier "restart the shared pair mid-run" control channel was the suite's main flake source and was
  removed. The stated reason (a session BYOK credential cannot reach a fresh generation, so G1/G7 go through an
  edit round trip) dates from before Phase 6, which now derives the owner from the row; not re-verified.
- `foundation` (smoke, studio-ui, swap-runtime, data-runtime) must finish before `rest`: A1's "No apps yet" needs
  a database nobody has seeded.
- `waitForFrameBySrc` ignores the query string (a new grant `?g=` per render) and takes `excludeFrame`: right after
  a re-click `page.frames()` can still return the old frame, which passes the liveness check and detaches moments
  later (reproduced under full-suite load). `submitPrompt` does not wait for load: a hand-driven generation may
  stay open.
- Data cases drive `window.anyapp.data` via `frame.evaluate()`, not the document's script (it re-runs on reload
  and would double-write). B10 is instrumented on the *parent* side because the `targetOrigin` argument goes
  through a cross-origin `WindowProxy` that patching inside the frame cannot see, and delivery cannot tell an exact
  origin from `"*"`. G3/G7 assert both scrubbing and that the message reaches the DOM (S11).
- swap-runtime D3 drives both script paths (initial `swap()` runs scripts even without `rerunScripts`; only the edit
  path depends on it); D11 asserts exactly-once. `tests/frontend` has its own DOM-enabled tsconfig (H2): a DOM lib
  in the single program leaked globals such as `ReadableStream` into server files.
