# any-app — Architecture

**Status:** draft · 2026-08-30

## Locked decisions

| # | Decision | Rationale |
|---|---|---|
| 1 | Monorepo, **npm workspaces** | Everything ships together; one install, nothing to add on top of Node 22 / npm 10. |
| 2 | Node.js backend | The workload is I/O-bound stream proxying, which is Node's strongest case. |
| 3 | Two origins, two deployables | Generated code is untrusted. Non-negotiable, see below. |
| 4 | Generated apps are single self-contained HTML files | No build step; streams naturally; trivial to store and serve. |
| 5 | Shell + slots document model | Enables progressive paint, parallel generation, and cheap targeted edits. |
| 6 | Postgres + JSONB for generated-app data | Schemaless without operating a second database. |
| 7 | htmx for the studio UI only | Good fit for our own shell; irrelevant to generated apps, which are not part of our DOM. |
| 8 | Generated apps get a **per-app origin** before Phase 5 | The shared sandbox origin only protects the studio from generated apps, not generated apps from each other. See below. |
| 9 | **Native provider adapters**, not a lowest-common-denominator wire format | A compatibility shim hides exactly the provider-specific features worth having — `cache_control` breakpoints above all, which Phase 4's economics depend on. |

## The origin boundary

LLM-generated JavaScript is untrusted code. It must never execute on the origin that holds
our session cookies, `localStorage`, or authenticated API responses.

`sandbox="allow-scripts"` alone is not sufficient once generated apps need their own
storage, because `allow-scripts allow-same-origin` together defeats the sandbox. So
generated apps are served from a **different registrable domain or subdomain** —
`apps.<domain>` in production, a separate local hostname in development.

That is a DNS and deployment concern, but we also split it at the **process** level:

- **`studio`** — trusted origin. Session, accounts, project list, chat UI, provider API
  keys, the generation orchestrator, billing.
- **`sandbox`** — untrusted origin. Serves generated app documents, pipes the preview
  stream, and exposes the data API to generated apps. Holds **no** provider credentials and
  **no** user session.

The sandbox's `/preview/:genId` route opens an internal HTTP call to the studio and pipes
the response straight through. Generation stays behind the trusted boundary; the sandbox is
a dumb pipe plus a scoped data API. Retrofitting this split later is painful, because
origins leak into saved app content — so it exists from day one.

### Per-app isolation

The origin split above protects the **studio** from generated apps. It does not, by
itself, protect generated apps **from each other** — through Phase 1–4 they all share one
sandbox origin (`apps.<domain>`, today `127.0.0.1:3001`). That is fine as long as two
things hold: apps carry no persistent data, and the iframe sandbox never adds
`allow-same-origin`.

Both stop holding once **Phase 5** gives apps their own storage. If an app then needs
`allow-same-origin` (for `localStorage`, IndexedDB, or a same-origin `fetch` to the data
API), the sandbox attribute stops protecting anything and every app on that origin can
read every other app's storage. `/preview/:id` opened directly in a tab — not inside an
iframe at all — has no sandbox attribute either; harmless while the origin holds no data,
not harmless once it does.

**Decision:** before Phase 5 ships storage, generated apps move to a **per-app origin** —
`<app-id>.apps.<domain>` — so isolation no longer depends on the sandbox attribute alone.
Deciding this now costs a line here and keeping the app id in the URL **path** (as it
already is) so it can move to the host part later without touching saved app content.
Deferring the decision costs a migration of every saved app's data once Phase 5 is live.

Two rules follow from it, both already true in practice and worth keeping true
deliberately:

- The Phase 5 data API scopes every request on the **per-app token**, never on the
  `Origin` header — the origin is a browser-side isolation mechanism, not an
  authorization boundary the server can trust.
- `allow-same-origin` is not added to the preview iframe until per-app origins exist.

### Dependency rules

- `sandbox` **must not** depend on `packages/generator`, which holds provider credentials.
- `sandbox` **must not** depend on `packages/store` either, not even for one export.
  `store/src/index.ts` re-exports `pool`, built at module scope from `DATABASE_URL` under
  the privileged role — importing a single named export (e.g. `loadEnv`) evaluates that
  whole module graph, so the sandbox process ends up holding a privileged pool anyway.
  `packages/store` and `packages/records` each duplicate the small `.env`-loading helper
  they need rather than share one, for exactly this reason. Caught live during Phase 5
  review (`review-phase-5.md`'s S1) — `sandbox` had imported only `loadEnv` from `store`,
  which was correct as an import specifier and wrong as a dependency.
- `sandbox` connects to Postgres under a **restricted role** that can reach the
  generated-app records table only — never users or billing.
- npm workspaces hoist to a flat `node_modules`, so these rules are not enforced by module
  resolution. They are enforced by a lint rule and by CI, and a violation is a security bug,
  not a style issue.

## Repository layout

```
any-app/
├─ .docs/                  this documentation
├─ package.json            workspace root; "workspaces": ["apps/*", "packages/*"]
├─ apps/
│  ├─ studio/              trusted origin: htmx UI, API, generation orchestrator
│  └─ sandbox/             untrusted origin: app host, preview pipe, data API
└─ packages/
   ├─ protocol/            shell/slot document model, swap() runtime, shared types
   ├─ generator/           planner, slot fan-out, prompt assembly, provider clients
   ├─ store/               Postgres access, migrations, JSONB record store
   └─ tsconfig/            shared TypeScript and lint config
```

`packages/protocol` is unusual: most of it runs on both servers as ordinary TypeScript, but
the `swap()` runtime is **inlined into every generated document**. That portion stays
dependency-free and tiny — it cannot import anything.

## Generation pipeline

### Phase A — plan

One small, fast call produces the shell: the document skeleton, **all** CSS and design
tokens, placeholder slots with correct dimensions, and a spec per slot.

The planner is the sole owner of everything shared. Child calls emit markup only and are
forbidden from emitting `<style>`. Without that rule, two parallel calls both invent a
`.card` class with different styles and clobber each other. The planner also declares the
JS contract — a small shared state object or event bus living in the shell — and each slot
spec names what that slot reads and writes.

### Phase B — fill

Slot content is generated and streamed into the already-painted shell. Initially one
sequential call covering all slots; later, N parallel calls, one per slot, so wall-clock
time drops from the sum of slot latencies to the slowest single one.

Fan-out raises token cost, because the shell and design system are context for every child
call. That is close to the ideal prompt-caching shape — identical prefix, varying tail — so
the effective delta is small. Caching is a requirement here, not a later optimization.

**Depth stops at one level.** Shell → components, with each component call writing its own
subtree in full. Recursing further buys little wall-clock time once level one is parallel,
and compounds coherence loss between cousins that have never seen each other.

## Streaming transport

The iframe's `src` points at a sandbox route that pipes the generation stream directly into
the HTTP response body. The browser's HTML parser is already a streaming parser, so
progressive rendering is free and needs no client-side logic inside the generated app.

Out-of-order delivery uses the BigPipe / React-Suspense technique: content is appended at
the end of the document and moved into place by an inline script.

```html
<!-- shell, arrives immediately -->
<div id="slot-sidebar"><div class="skeleton" style="height:400px"></div></div>
<div id="slot-feed"><div class="skeleton" style="height:600px"></div></div>

<!-- later in the same response, in completion order -->
<template id="c-feed">…</template><script>swap("feed")</script>
<template id="c-sidebar">…</template><script>swap("sidebar")</script>
```

`swap()` moves the template's children into the matching slot. The parser runs each inline
script as it reaches it, so slots land as they finish, in any order.

Skeletons carry real dimensions so layout does not shift when content arrives.

**Consequence:** the initial generation flows through this response, and the response closes
when generation ends. Later edits need a separate channel — `postMessage` from the studio
frame, or SSE — to push slot updates into a live iframe.

## Persistence

Apps are stored **decomposed**, as shell plus slots, rather than as one flat HTML blob. It
is the same decomposition the generator already produces, reused as the document model.

The payoff is edit granularity: "make the sidebar blue" regenerates one slot at roughly 800
tokens instead of the whole app at 20k. Since the orchestration exists anyway, this is most
of the reason to build it.

## Data API for generated apps

A single table, roughly:

```sql
records(id, app_id, collection, data jsonb, created_at, updated_at)
```

with a GIN index on `data`. Three rules:

- **Never trust `app_id` from the client.** Scope is derived server-side from a per-app
  token, or the first generated app that guesses another app's id reads everyone's data.
- **Expose a small fixed CRUD/filter API** — not arbitrary SQL, and not arbitrary
  Mongo-style query objects. Model-written queries are otherwise unindexed and unbounded.
- **Row quotas and rate limits ship with the feature**, not after the first incident.

## Model provider

The generator talks to a generic OpenAI-compatible chat-completions endpoint —
configured via `OPENAI_BASE_URL`, `OPENAI_API_KEY`, and `OPENAI_MODEL` — rather than a
provider-specific SDK. This covers OpenAI itself, a gateway such as OpenRouter, or a
self-hosted OpenAI-compatible server, all through the same client. A gateway adds a
latency hop and its streaming behaviour varies by upstream provider, so it should not sit
on the critical path once a primary endpoint is chosen; switching is a config change, not
a code change. The client lives in `packages/generator`, the one file that constructs it.

Not every OpenAI-compatible surface is identical — for example, OpenAI's own newer
reasoning models require `max_completion_tokens` instead of `max_tokens` — so "compatible"
means the common chat-completions shape, not universal parameter support.

### Two adapters, one interface (Phase 3.5)

From Phase 3.5 the generator talks to an adapter rather than to a client directly. Two
implementations: **OpenAI-compatible**, which is the client described above, and
**Anthropic native**.

Anthropic publishes an OpenAI-compatible endpoint, and it is deliberately not used. The shim
does not carry `cache_control` breakpoints, adaptive thinking, or the `refusal` stop reason —
and caching over a shared prefix is most of why that provider is worth having here, since
Phase 4 sends the same shell and stylesheet as context to every parallel slot call. Routing
around the shim to save one adapter would forfeit the reason for the adapter.

The interface is narrow because the generator's needs are narrow: stream text, or complete
text, given a system prompt, a user prompt, a token budget, and an abort signal. Everything
provider-shaped stays behind it — message layout, delta event shapes, refusal signalling,
reasoning-token budgets, and which SDK error class means "the caller aborted".

**Per-role configuration.** Each call site — planner, fill, edit, router — resolves its own
provider, model, and token budget. This generalises the existing `OPENAI_PLANNER_MODEL`
escape hatch and answers the open question in `open-problems.md` about needing a separate
fill model: the planner can run somewhere small and fast while fill runs somewhere capable,
across different providers if that is what works.

### User-supplied credentials

Users may supply their own provider credentials. Four rules, all of which exist because a
credential that belongs to someone else is a different kind of object from one in `.env`:

- **Never persisted in plaintext.** Encrypted at rest with a server-side key.
- **Never returned to the client after storage.** The UI gets a masked hint and a validity
  timestamp, nothing more.
- **Never sent to the sandbox.** Already true structurally — the sandbox has no dependency on
  `packages/generator` — and this is one more reason it must stay that way.
- **Never written into an error path.** Provider error text is currently persisted verbatim
  into `generations.error`; a 401 during live testing wrote the configured credential into
  the database. Provider errors must be normalised to a code plus scrubbed text before they
  are stored or logged. This is a prerequisite for user keys, not a follow-up.

Credentials are session-scoped in Phase 3.5 and move onto accounts in Phase 6. That is a
change of storage key, not of design.

## Open questions

- Where does the design system live — a fixed house style in the system prompt, or per-app
  and planner-generated? Affects coherence, caching, and how apps look as a set.
- Do generated apps get authenticated end users of their own, or is all data app-global?
- Stream *within* a slot, or append each slot only on completion? Start with the latter;
  revisit if the wait is visible.
- Utility classes (Tailwind-style) vs. planner-authored semantic CSS. Utility classes make
  collisions structurally impossible, at some cost in output tokens.
