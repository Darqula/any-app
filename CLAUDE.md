# any-app

An LLM-driven web app builder (Websim-like): a user describes an app, the backend calls a
model, streams the generated app into the browser as it's produced, and persists it.
Full product/architecture docs live in `.docs/` — **read `.docs/overview.md` first**, then
`.docs/architecture.md` for locked design decisions. `.docs/plan.md` has the phase-by-phase
build plan; each phase's actual step-by-step spec is `.docs/impl-phase-N.md`, with review
findings in `.docs/review-phase-N.md` once a phase lands.

**Current status:** Phases 0–3.5 implemented (skeleton, linear generation, shell/slots,
decomposed persistence + slot/CSS editing, multi-provider adapters + BYOK) and verified
end-to-end against real providers. Default config is still `longcat-2.0` on the
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
gateway's Anthropic-*shaped* endpoint (not real Anthropic infrastructure, and confirmed not
to actually cache) — see `.docs/open-problems.md`'s Phase 3.5 section before trusting the
Anthropic path's caching economics for anything.

## Repository layout

```
apps/studio/    trusted origin (localhost:3000) — UI, API, generation orchestrator
apps/sandbox/   untrusted origin (127.0.0.1:3001) — serves generated apps, proxies the
                preview stream, holds no provider credentials and no session
packages/store/      Postgres pool, migrations, generations table access
packages/generator/  planner/fill/edit/router calls, prompts, provider adapters (openai,
                     anthropic) behind one interface, per-role config, error scrubbing
packages/protocol/   shell/slot document model, swap() runtime (inlined into every
                     generated doc), shared constants
packages/tsconfig/   shared tsconfig, extended by name (@any-app/tsconfig/base.json) —
                     not a relative path, so it resolves the same regardless of nesting
```

**The origin split is load-bearing, not incidental.** `sandbox` must never depend on
`@any-app/generator` (holds the provider key) and must never import anything from
`@any-app/store` beyond `loadEnv`. See `.docs/architecture.md`'s "Dependency rules".

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
Anthropic-*shaped* endpoint — confirmed to accept real Messages-API requests, confirmed
**not** to actually implement prompt caching (`cache_read_input_tokens` stayed 0 across
repeat calls with an identical cacheable prefix). Don't assume decision #9's caching economics
work until this is re-tested against real Anthropic infrastructure.

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
