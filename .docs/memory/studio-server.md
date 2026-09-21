# Studio server: incidents and traps

Background for `apps/studio/src/{internal,shell,index,credential-resolve,settings}.ts`. Security reasoning is
in `security.md`, the UI in `studio-ui.md`, edits in `editing.md`.

## The internal stream route

Server-to-server from the sandbox: **no cookie**, so the view grant is the only signal of who is looking.

- **The owner comes from the row.** An earlier version called `currentOwner(req,res)` on this cookie-less
  request, which always took the create-a-session branch: a throwaway `insert into sessions` per generation
  (plus a pointless `Set-Cookie`), and a signed-in user's own BYOK credential could never be found, so a
  generation on their key was billed as if the platform paid.
- Cap check before `claimForGeneration` (do not lock a row for a refused attempt; a reload must not slip past
  the cap by retrying before the claim); claim before generating (a reload mid-generation is what anyone does
  when it looks stuck, and would start a second concurrent call).
- Doctype + 1 KB padding go out before planning: undici's ~300 s inactivity timeout counts silence and a
  reasoning planner can take that long. The heartbeat is live-only and never stored.
- **Persist before `res.end()`**: ending first fires `close` and flips `ac.signal.aborted`, so a database
  failure right there would be misread as the viewer leaving and a successful generation discarded.
- No streamed-vs-rendered consistency check any more (Phase 3's `flat`/`document !== flat`): completion order
  means parallel live bytes and plan-ordered `renderDocument` output legitimately differ; `swap()` is
  order-independent.
- Usage is collected across the whole generation and written once, win or lose; the generator only emits via
  `onUsage`. `LLM_FILL_MODE` defaults to `sequential` (parallel measured ~5.6x tokens, `model-and-sweep-history.md`).
- **Planner failure capture** (`ANYAPP_PLANNER_RAW_DIR`): a sweep once had `PlanError` move between runs and
  answering "why" needed a separate paid probe because the raw response was thrown away. Options weighed: log
  it always (too noisy for `npm run dev`); persist on the `generations` row (mixes diagnostics into product
  data, and the row already reflects the linear result served); **an env var only diagnostic runs set**
  (chosen; production stays silent and unchanged). It never throws.

## Routes

- `studioOrigin` is normalised through `new URL().origin`: it is baked into every document and compared with
  `event.origin`, which never has a trailing slash; a sloppy env var would fail forever with nothing logged.
- `/apps/:id` exists because the frame route returns an htmx fragment (no doctype, stylesheet or htmx), useless
  when opened directly.
- Fork guards with `isFilledApp`, not `plan !== null`, since `forkGeneration` casts the plan: a complete row
  whose plan is not a `FilledApp` would otherwise 500 inside `renderDocument` instead of answering 409.
- `missingCredentials` keeps `credentialForRole` inside the `try` (S3): `roleConfig()` throws a plain `Error`
  for a role with no model, which used to 500 `GET /`.


## Serving path traps

- `res.flushHeaders()` must run before the first `res.write`, or Express holds the headers and nothing reaches
  the browser until the response ends. The doctype must be the very first bytes: a comment or padding before it
  puts the document in quirks mode and the app's CSS renders wrong. When everything appears at once, check in
  order: `flushHeaders`, no `compression` middleware, doctype then padding written first.
- `loadEnv` looks for `.env`, `../../.env` and `../../../.env` and runs once per process (`tsx watch` does not
  reload it). Two processes started with different `APP_TOKEN_SECRET` or `SANDBOX_APP_ORIGIN_TEMPLATE` values
  turn every data call into a 401 or a 403 "token does not match this app's origin".

## Deliberately not built

Password reset and email verification (no email infrastructure), OAuth, a public gallery (must not ship without
read-only data tokens, see `security.md`), per-app collaborators (remix is the answer), billing (`usage_events`
is only its substrate), edit history and undo (the `version` column is the natural key), streaming an edit,
a sweeper for rows stuck in `streaming`, per-app token revocation, studio-side browsing of `records`, and an
editable per-role settings page (read-only today; it would need its own storage).
