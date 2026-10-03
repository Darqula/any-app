# any-app

LLM-driven web app builder (Websim-like). `README.md` covers what it is, layout, setup, model
configuration and test commands; this file holds only what an agent must keep in mind while changing it.
Verify changes with `npm run typecheck` and `npm test`.

## Docs

- `.docs/overview.md`: read first. `.docs/architecture.md`: locked decisions and dependency rules.
- `.docs/open-problems.md`: open provider/model/quality issues. Read before changing any `LLM_*` setting.
- `.docs/testing-review.md`: active source defects found by tests (resolved ones are deleted). Record a
  production defect found while writing a test there; never change source just to make a test pass.
- `.docs/review-phase-N.md`: exists only while a review has open findings. If it's absent, nothing is open.
  Verify each finding, and especially its suggested fix, against the code before applying it.
- `.docs/tests-backend.md`, `.docs/tests-frontend.md`, `tests/README.md`: test case lists and harness.
- `.docs/memory/`: agent-only background (incidents, measurements, rejected designs, cross-file traps).
  `README.md` there is the index. Read the matching file before changing guarded behaviour.

**Where reasoning lives.** Code comments are short, self-contained, and only for non-obvious solutions.
They never point at `.docs/memory/`. When a fix teaches something non-obvious, put the essential *why*
in a short comment and the history in the matching memory file. Several different agents work on this
repo, so project knowledge goes into these in-repo files, never only into an agent's private memory store.

## Working gotchas

- `.env` is read once per process: restart `npm run dev` after editing it; the watcher won't pick it up.
- `test:frontend` uses the same ports as `npm run dev`; stop the dev servers first.
- Never run `test:quality` or `tests/quality/probe.ts` without asking: they call real providers and cost
  money (`--yes` only skips the harness's own guard).
- Source files mix LF and CRLF line endings; scripted edits must keep each file's existing style.
- The model that converges on this task on the opencode.ai gateway is `longcat-2.0`, a reasoning model:
  hidden reasoning uses up `max_tokens`, and a low budget returns empty output. Check the real usage in
  the studio log instead of guessing.
- `LLM_FILL_MODE=sequential` on purpose. Parallel fill is a measured regression on that model
  (open-problems #3).
- The Anthropic adapter has never been run against real `api.anthropic.com`.

## Invariants: don't break

- `sandbox` never depends on `@any-app/generator` or `@any-app/store`, not even for one export:
  importing `store` builds the privileged pool and pulls in credentials. Sandbox gets `loadEnv`
  from `@any-app/records`, which is also why `records` must stay out of `store`.
- `openai` / `@anthropic-ai/sdk` are imported only in `packages/generator/src/providers/`.
- No `compression` middleware (it buffers and breaks streaming). No build step, bundler or
  Dockerfile for `apps/*`.
- Generated apps stay on per-app origins (`SANDBOX_APP_ORIGIN_TEMPLATE`). That's what makes
  `allow-same-origin` on the preview iframe safe. `STUDIO_PUBLIC_URL` must exactly match the
  studio origin shown in the browser.
- On `/data/*`, `app_id` comes only from `verifyAppToken`, never from `Origin`, body, query or hostname.
- Sandbox needs `app.set("query parser", "extended")`. Express 5's default silently ignores
  `where[key]=value`.
- Sandbox `/preview/:id` must forward `req.query.g` unchanged, or every preview 404s.
- The session cookie has no `Domain` attribute. Generated apps are subdomains of the studio host
  (`<id>.apps.localhost`), so `Domain=localhost` would hand every app the studio session.
- Security choices that look wrong but are deliberate (`memory/security.md`): `SameSite=Lax`
  (not `Strict`); the `Sec-Fetch-Site`/`Origin` guard on mutating studio routes; view-grant
  `expired` ≠ `invalid`; a grant has four fields (`appId.mode.expiresAtMs.mac`).
- Never pass model output or user text as a `String.replace` replacement: `$&` and friends get
  expanded (this broke stored documents and app tokens). Use `split`/`join` or a replacer function.
- The model ignores "never write `<style>`" and "edit, not rewrite" in edit prompts. The defensive
  checks in `edit.ts` / `edits.ts` are load-bearing (`memory/editing.md`).
