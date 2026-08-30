# any-app — Build Plan

**Status:** draft · 2026-08-30

Deliberately coarse. Each phase gets its own detailed implementation plan when it is picked
up; this document only fixes the order and the exit criterion for each one.

The ordering principle: the two real risks are **generation quality** and **unit economics**
(see [`overview.md`](./overview.md)). Everything that answers those comes before everything
that merely scales them.

---

## Phase 0 — Skeleton

Monorepo with npm workspaces, both servers running on two distinct local origins, shared
TypeScript config, Postgres up with migrations wired.

**Exit:** `npm install` at the root, one command starts both apps, and each answers on its
own hostname.

## Phase 1 — Linear vertical slice

Prompt in, one LLM call, response piped straight into a sandboxed iframe, result saved as a
flat document and reopenable. No slots, no planner, no editing.

The point is to answer "does the model produce apps worth keeping, and does streaming feel
alive?" before building anything on top of the assumption that it does.

**Exit:** an app can be generated, watched as it streams, closed, and reopened.

## Phase 2 — Shell and slots

Introduce the planner call and the shell/slot document model: skeleton with correctly sized
placeholders paints first, then a single fill pass streams content into the slots. Includes
the inlined `swap()` runtime and the slot protocol in `packages/protocol`.

Fill stays sequential here — this phase is about the document model and the fast structural
paint, not about parallelism.

**Exit:** layout is visible in about a second, and content lands slot by slot.

## Phase 3 — Decomposed persistence and slot-level editing

Store apps as shell plus slots. Add the edit channel into a live iframe and regenerate a
single slot on request.

This is the phase that makes iteration affordable, and iteration is the dominant flow.

**Exit:** "change the sidebar" rewrites one slot, at roughly slot cost rather than whole-app
cost, without a full reload.

## Phase 4 — Parallel fill

Fan out the fill phase to one call per slot, landing them out of order as they complete.
Requires prompt caching over the shared prefix, plus per-slot retry so one failed slot does
not sink the document.

Pure orchestration change — the document format from Phase 2 does not move.

**Exit:** wall-clock generation time tracks the slowest slot rather than the sum, and a
single slot failure degrades to a placeholder instead of a broken page.

## Phase 5 — Generated backends

The JSONB record store, per-app tokens, the fixed CRUD/filter API on the sandbox origin, the
restricted Postgres role, and quotas and rate limits. Prompt work so generated apps know how
to call it.

**Exit:** a generated app persists and reads back its own data, and cannot reach another
app's rows.

## Phase 6 — Accounts, sharing, remix

Real auth, project ownership, public app URLs, forking someone else's app as a starting
point. Cost accounting and per-user limits.

**Exit:** a second person can open, run, and remix an app they did not create.

---

## Deferred past Phase 6

Streaming within a slot; recursive decomposition past one level; visual editing; custom
domains; per-app deployable server code; multi-model routing beyond a single fallback.

Each is either an optimization we cannot yet size, or a feature that depends on knowing how
people actually use the first six phases.
