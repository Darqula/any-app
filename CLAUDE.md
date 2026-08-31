# any-app

An LLM-driven web app builder (Websim-like): a user describes an app, the backend calls a
model, streams the generated app into the browser as it's produced, and persists it.
Full product/architecture docs live in `.docs/` — **read `.docs/overview.md` first**, then
`.docs/architecture.md` for locked design decisions. `.docs/plan.md` has the phase-by-phase
build plan; each phase's actual step-by-step spec is `.docs/impl-phase-N.md`, with review
findings in `.docs/review-phase-N.md` once a phase lands.

**Current status:** Phases 0–3 implemented (skeleton, linear generation, shell/slots,
decomposed persistence + slot/CSS editing) and verified end-to-end against a real provider
(`longcat-2.0`). See `.docs/open-problems.md` for the provider/model investigation that got
there — worth reading before changing `OPENAI_MODEL`, since one model on this same gateway
(`glm-5.3-flash`) never converged on this task at any legal token budget. See
`.docs/impl-phase-3.md`'s "Found live, not in the original plan" section before touching the
edit prompts (`edit.ts`, `edit-router.ts`) — the model does not reliably follow its own
"never write `<style>`" or "edit, not rewrite" instructions, and both `edit.ts` and
`edits.ts` carry defensive checks for that, confirmed to actually fire in testing.

## Repository layout

```
apps/studio/    trusted origin (localhost:3000) — UI, API, generation orchestrator
apps/sandbox/   untrusted origin (127.0.0.1:3001) — serves generated apps, proxies the
                preview stream, holds no provider credentials and no session
packages/store/      Postgres pool, migrations, generations table access
packages/generator/  planner/fill/linear calls, prompts, the OpenAI-compatible client
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

## Model provider

The generator talks to a generic OpenAI-compatible chat-completions endpoint
(`OPENAI_BASE_URL` / `OPENAI_API_KEY` / `OPENAI_MODEL` in `.env`), not the official OpenAI
API specifically — this project currently points at a third-party gateway
(`opencode.ai/zen`). **`OPENAI_BASE_URL` must be the API prefix only** (e.g.
`https://host/v1`) — the SDK appends `/chat/completions` itself; including the endpoint
path in the env var produces a doubled path that 404s.

**Reasoning models need `OPENAI_REASONING_MODEL=true`.** Some models on this kind of
gateway (glm, LongCat, Kimi K2.7 Code, etc.) spend part of `max_tokens` on a hidden
`reasoning_content` field before writing the actual `content` this app reads — at the
normal token budgets they can return completely empty responses, and *some models never
converge on this task at all regardless of budget* (confirmed for `glm-5.3-flash` up to
its provider's actual max of 131,072). Setting this flag raises `max_tokens` on the
planner/fill/linear calls (`packages/generator/src/client.ts` → `isReasoningModel()`).
Every call now logs its real token usage (`logUsage`) — check the studio log rather than
guessing. See `.docs/open-problems.md` for the full investigation and current numbers.

## Don't

- Add `compression` middleware to either server — it buffers responses and breaks the
  whole point of streaming.
- Add a build step, bundler, or Dockerfile for `apps/*` — both run TypeScript directly via
  `tsx`.
- Change the sandbox to run on `localhost` instead of `127.0.0.1` — they're different
  cookie domains/origins on purpose; this is the security boundary, not a config detail.
