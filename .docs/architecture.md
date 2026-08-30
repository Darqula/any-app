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

### Dependency rules

- `sandbox` **must not** depend on `packages/generator`, which holds provider credentials.
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

Start direct against the primary model. OpenRouter is worth keeping as a fallback and as the
path for comparing models, but it adds a latency hop and its streaming behaviour varies by
upstream provider, so it should not sit on the critical path once a primary is chosen. The
provider client in `packages/generator` exists to keep that switch cheap.

## Open questions

- Where does the design system live — a fixed house style in the system prompt, or per-app
  and planner-generated? Affects coherence, caching, and how apps look as a set.
- Do generated apps get authenticated end users of their own, or is all data app-global?
- Stream *within* a slot, or append each slot only on completion? Start with the latter;
  revisit if the wait is visible.
- Utility classes (Tailwind-style) vs. planner-authored semantic CSS. Utility classes make
  collisions structurally impossible, at some cost in output tokens.
