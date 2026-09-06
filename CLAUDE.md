# any-app

An LLM-driven web app builder (Websim-like): a user describes an app, the backend calls a
model, streams the generated app into the browser as it's produced, and persists it.
Full product/architecture docs live in `.docs/` — **read `.docs/overview.md` first**, then
`.docs/architecture.md` for locked design decisions. `.docs/plan.md` has the phase-by-phase
build plan; each phase's actual step-by-step spec is `.docs/impl-phase-N.md`, with review
findings in `.docs/review-phase-N.md` once a phase lands.

**Current status:** Phases 0–5 implemented (skeleton, linear generation, shell/slots,
decomposed persistence + slot/CSS editing, multi-provider adapters + BYOK, parallel fill,
generated-app data API) and verified end-to-end against real providers. Phase 5 (per-app
origins, the `records` table, the data API, and the inlined `anyapp.data` client) is
implemented and verified live against a real generation — see `.docs/impl-phase-5.md`'s
"Found live" section before touching `apps/sandbox/src/data.ts` or its query parsing:
Express 5's default query-parser setting silently broke every `where[key]=value` filter
until `app.set("query parser", "extended")` was added. **Phase 4's parallel fill is implemented and
correct but is currently a measured regression on this project's default model** — see below
before enabling it. Default config is still `longcat-2.0` on the
OpenAI-compatible path (`LLM_MODEL` in `.env`, not `OPENAI_MODEL` anymore — see below). See
`.docs/open-problems.md` for the provider/model investigation history — worth reading before
changing `LLM_MODEL`, since one model on this same gateway (`glm-5.3-flash`) never converged
on this task at any legal token budget, and `qwen3.8-flash` (tried via Phase 3.5's Anthropic
path) has its own reasoning-tax and streaming-ceiling issues documented there. See
`.docs/impl-phase-3.md`'s "Found live, not in the original plan" section before touching the
edit prompts (`edit.ts`, `edit-router.ts`) — the model does not reliably follow its own
"never write `<style>`" or "edit, not rewrite" instructions, and both `edit.ts` and
`edits.ts` carry defensive checks for that, confirmed to actually fire in testing.

**Provider config moved in Phase 3.5.** `OPENAI_MODEL`/`OPENAI_PLANNER_MODEL`/
`OPENAI_REASONING_MODEL` are gone. Model/provider/token-budget selection is now per-role via
`LLM_<ROLE>_*` env vars (`planner`/`fill`/`edit`/`router`), falling back to `LLM_*` — see
`packages/generator/src/roles.ts` and `.env.example`. Two providers exist behind one
interface (`packages/generator/src/providers/{openai,anthropic}.ts`): OpenAI-compatible
(unchanged from before) and native Anthropic. Users can also supply their own credentials
via `/settings` (encrypted at rest, session-scoped — see `packages/store/src/credentials.ts`
and `crypto.ts`). **No real Anthropic key has been tested against this project yet** — the
adapter is implemented and typechecked, and was exercised live against a third-party
gateway's Anthropic-*shaped* endpoint. That endpoint, and the OpenAI-compatible one, both
genuinely cache at a large-enough prefix (~4.5k tokens) — an earlier note here claiming
caching didn't work was a false negative from testing too small a prefix, corrected during
Phase 4 — see `.docs/open-problems.md`.

**Parallel fill (Phase 4, `packages/generator/src/{fan-out,fill-slot,parallel-fill}.ts`,
toggled via `LLM_FILL_MODE`) currently defaults to `sequential`, not `parallel`, in both
`.env` and `.env.example`.** A same-prompt comparison, run twice (the second time after
The Phase 4 review split an overloaded budget variable that could have confounded the
first run), found parallel slower (up to 6m3s vs sequential's 2m30s) *and* ~5.6-5.8x more
completion tokens on `longcat-2.0` — this reasoning-heavy model reasons far more per
isolated region than per whole document, and prompt caching (which does work — see above)
only discounts input tokens, not that completion-token blowup. Not a code bug; a real
property of this model, confirmed twice. See `.docs/open-problems.md`'s Phase 4 section
before flipping `LLM_FILL_MODE` back to `parallel`. **Budget is two separate variables
now**: `LLM_FILL_MAX_TOKENS` (sequential, whole-document) and `LLM_FILL_SLOT_MAX_TOKENS`
(parallel, per-region) — they used to be one variable with mode-dependent meaning, which is
exactly what made the first comparison hard to trust.

**A slot regenerated through the edit box (`apps/studio/src/edits.ts`) checks for the error
placeholder first** and calls `fillSlot` directly instead of `regenerateSlot` when it finds
one — `regenerateSlot`'s prompt tells the model "this is an edit, not a rewrite," which
would otherwise argue for preserving the apology paragraph it's supposed to be replacing.
Found by the Phase 4 review, confirmed live (injected a placeholder, requested a fix,
confirmed the log showed `fill:<slot>` not `edit-slot`, confirmed real content landed).

## Repository layout

```
apps/studio/    trusted origin (localhost:3000) — UI, API, generation orchestrator
apps/sandbox/   untrusted origin (per-app: <id>.apps.localhost:3001, Phase 5) — serves
                generated apps, proxies the preview stream, exposes the data API
                (apps/sandbox/src/data.ts), holds no provider credentials and no session
packages/store/      Postgres pool, migrations, generations table access
packages/records/    the `records` table (Phase 5) — own Postgres pool, own env loading,
                     deliberately NOT depending on @any-app/store; see below
packages/generator/  planner/fill/edit/router calls (sequential and parallel-fan-out fill),
                     prompts, provider adapters (openai, anthropic) behind one interface,
                     per-role config, error scrubbing
packages/protocol/   shell/slot document model, swap() runtime + data-runtime + app-token
                     (all inlined into or minted for every generated doc), shared constants
packages/tsconfig/   shared tsconfig, extended by name (@any-app/tsconfig/base.json) —
                     not a relative path, so it resolves the same regardless of nesting
```

**The origin split is load-bearing, not incidental.** `sandbox` must never depend on
`@any-app/generator` (holds the provider key) and must never depend on `@any-app/store` —
not even for one export. `store/src/index.ts` re-exports a pool built at module scope under
the privileged role, so importing anything from `store` evaluates that whole graph; a Phase
5 review caught `apps/sandbox` doing exactly this for `loadEnv` alone (that review's
S1) — correct as an import specifier, wrong as a dependency. `sandbox` gets `loadEnv` from
`@any-app/records` instead. See `.docs/architecture.md`'s "Dependency rules".
`packages/records` exists as its own package, not inside `store`, for the same reason:
`store`'s own `index.ts` re-exports `credentials.ts`, so putting records there would pull
the credential-holding module graph into the sandbox through one import. `records/src/db.ts`
duplicates ~15 lines of `.env`-loading logic instead of importing `store`'s — two pools
against one database, authenticating as different roles, is the whole point (see
`.docs/impl-phase-5.md` step 4).

## Commands

```powershell
npm install
npm run migrate        # applies packages/store/migrations/*.sql in order
npm run dev            # starts both servers with interleaved, labeled output
npm run typecheck      # tsc --build --force across the whole workspace
```

Both servers run via `tsx watch` — they hot-restart on `.ts` file changes, but **do not
reload `.env`**. `.env` is only read once per process (`packages/store/src/env.ts`'s
`loadEnv`), so after editing `.env` you must kill and restart `npm run dev`, not just wait
for the watcher.

## This machine's local setup

Postgres is **not** a dedicated container for this project — it reuses an existing
`my-postgres` docker container (port 5432, user `postgres`) shared with other projects,
with a dedicated `anyapp` database created inside it. `docker-compose.yml` from the
original implementation plan was deliberately not created; see `.docs/impl-phase-0-1.md`
step 0.3 for both the actual setup and the from-scratch reference version.

## Model provider (Phase 3.5)

Two providers behind one interface (`packages/generator/src/providers/{openai,anthropic}.ts`):
**OpenAI-compatible** (any chat-completions endpoint, not just OpenAI itself — this project
currently points at a third-party gateway, `opencode.ai/zen`) and **native Anthropic**
(Messages API, `@anthropic-ai/sdk`, deliberately not Anthropic's own OpenAI-compatible shim —
see `architecture.md` decision #9). Each call site (`planner`, `fill`, `edit`, `router`)
resolves its own provider/model/token-budget via `packages/generator/src/roles.ts` and
`resolve.ts`: `LLM_<ROLE>_PROVIDER` / `_MODEL` / `_MAX_TOKENS`, falling back to `LLM_PROVIDER`
/ `LLM_MODEL` / `LLM_MAX_TOKENS`. Platform credentials are `OPENAI_API_KEY` /
`OPENAI_BASE_URL` / `ANTHROPIC_API_KEY` / `ANTHROPIC_BASE_URL`; a session can override either
via `/settings` (encrypted at rest — `CREDENTIAL_KEY` must be set or the server refuses to
boot). `OPENAI_BASE_URL`/`ANTHROPIC_BASE_URL`, when set, are the bare API prefix — each SDK
appends its own endpoint path (`/chat/completions` or `/v1/messages`).

**Reasoning models still need a bigger budget, just configured per-role now** (the old
`OPENAI_REASONING_MODEL` flag is gone). Some models on the opencode.ai gateway (glm, LongCat,
Kimi K2.7 Code, and `qwen3.8-flash` via its Anthropic-shaped endpoint) spend part of
`max_tokens` on hidden reasoning/thinking before writing the actual output — at low budgets
they return completely empty responses, and *some models never converge on this task at all
regardless of budget* (confirmed for `glm-5.3-flash` up to its provider's max of 131,072).
Every call logs its real token usage (each `providers/*.ts` adapter calls
`providers/usage.ts`'s `logUsage`) — check the studio log rather than guessing. See
`.docs/open-problems.md` for the full investigation, current numbers, and the Phase 3.5
`qwen3.8-flash`/Anthropic-shim findings (including: `completeText`, unlike `streamText`, has
an SDK-enforced ceiling on `max_tokens` that a heavily-reasoning model can hit).

**No real Anthropic (`sk-ant-...`) key has been tested against this project.** The adapter
is implemented, typechecked, and was exercised live against a third-party gateway's
Anthropic-*shaped* endpoint — confirmed to accept real Messages-API requests, and (once
tested with a large-enough prefix — see `open-problems.md`) confirmed to genuinely cache:
both this endpoint and the OpenAI-compatible one show clean cache hits (`cached_tokens`/
`cache_read_input_tokens`) at ~4,500 shared tokens. An earlier note here claiming caching
didn't work was a false negative from testing too small a prefix — corrected during Phase 4.
Still worth re-testing against real `api.anthropic.com` when a genuine key exists, but
decision #9's caching premise is no longer in doubt on the paths that could be tested.

## Data API for generated apps (Phase 5)

Generated apps are served from `<app-id>.apps.localhost:3001` — a real per-app origin
(`SANDBOX_APP_ORIGIN_TEMPLATE` in `.env`), not the shared sandbox origin Phases 1–4 used.
That's load-bearing, not tidiness: it's what makes `allow-same-origin` on the preview iframe
safe to add (locked decision #8 in `architecture.md`), and `allow-same-origin` is what a
same-origin `fetch("/data/...")` from inside the frame needs.

Each app's data-API token (`packages/protocol/src/app-token.ts`) is **derived, not stored** —
an HMAC of the app id under `APP_TOKEN_SECRET` (both servers require this at boot, the same
way `CREDENTIAL_KEY` already works). Studio mints it fresh every time it renders a document
(`internal.ts`, `edits.ts`); sandbox verifies it on every `/data/*` request
(`apps/sandbox/src/data.ts`) and cross-checks the app id it decodes against the request's
`Host` header. Records live in their own table (`records`, migration `005_records.sql`),
reached only by a **restricted Postgres role** (`anyapp_sandbox`, created by hand per
`.docs/impl-phase-5.md` step 3 — not in a migration, since it needs a password) that can
touch `records` and nothing else; `SANDBOX_DATABASE_URL` in `.env` is that role's connection
string, separate from `DATABASE_URL`.

The API surface is deliberately narrow — equality-only `where[key]=value`, `limit`, an opaque
`cursor`, nothing else — and generated apps are never supposed to call it directly: the model
is instructed to use `window.anyapp.data.*` (`packages/protocol/src/data-runtime.ts`, inlined
into the document only when `plan.collections.length > 0`), never its own `fetch()`. Quotas
(1000 rows/app) and rate limits (60 writes/min, 300 reads/min, in-process only) ship in
`packages/records/src/quota.ts`.

## Don't

- Add `compression` middleware to either server — it buffers responses and breaks the
  whole point of streaming.
- Add a build step, bundler, or Dockerfile for `apps/*` — both run TypeScript directly via
  `tsx`.
- Change the sandbox to run on `localhost` instead of `127.0.0.1` — they're different
  cookie domains/origins on purpose; this is the security boundary, not a config detail.
- Import `openai` or `@anthropic-ai/sdk` anywhere outside
  `packages/generator/src/providers/` — enforced by convention today (checked via grep
  during Phase 3.5's verification), not yet by a lint rule.
- Put the `records` store inside `packages/store` — that pulls the credential-holding module
  graph into the sandbox through `store/src/index.ts`'s re-exports. It stays its own package.
- Trust the `Origin` header, or `app_id` from a request body/query string/hostname, on any
  `/data/*` route. `app_id` comes from `verifyAppToken` and nothing else — see
  `.docs/architecture.md`'s data-API rules.
- Assume Express's default query parser understands `where[key]=value` bracket notation —
  Express 5 changed the default to one that doesn't. `apps/sandbox/src/index.ts` sets
  `app.set("query parser", "extended")` explicitly; see `.docs/impl-phase-5.md`'s "Found
  live" section before touching sandbox query parsing.
