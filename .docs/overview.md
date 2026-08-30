# any-app — Overview

**Status:** draft · 2026-08-30

## What it is

A web app builder driven by an LLM. A user describes an app in natural language; the
backend calls an external model, streams the generated app into the browser as it is
produced, and persists it so it can be reopened, edited, shared, and remixed. Reference
point: Websim.

Generated apps are **single self-contained HTML documents** — inline `<style>`, inline
`<script>`, libraries from a CDN or an import map. No build step, no bundler, no module
resolution. This constraint is load-bearing: it is what makes streaming, storage, and
sandboxing simple.

Later, generated apps get a backend too: a schemaless data API over JSONB in Postgres,
so an app can persist records without us generating or deploying per-app server code.

## Product loop

1. **Prompt** — user describes the app.
2. **Stream** — layout appears within ~1s, content fills in progressively.
3. **Save** — the app source is persisted, not just its render.
4. **Edit** — "make the sidebar blue" regenerates one region, not the whole app.
5. **Remix** — fork someone else's app as the starting point for your own.

Step 4 is the dominant flow in practice. First-generation is what demos well; iteration
is what users actually spend their time on, and it drives both the persistence format
and the cost model.

## Scope boundaries

**In scope:** generation, streaming preview, persistence, slot-level editing, sandboxed
hosting of generated apps, schemaless data API for generated apps.

**Out of scope (for now):** generating deployable per-app server code, custom domains for
generated apps, a visual/WYSIWYG editor, real-time multiplayer editing.

## The two risks that matter

1. **Quality** — does the model actually produce apps people want to keep? No amount of
   architecture fixes a bad generation. This is why the build plan front-loads a thin
   end-to-end slice over infrastructure.
2. **Unit economics** — a full generation is 5–30k output tokens. Prompt caching and
   slot-level edits are not optimizations to add later; they are the difference between
   viable and not.

## Related documents

- [`architecture.md`](./architecture.md) — system design and locked decisions
- [`plan.md`](./plan.md) — phased build plan
- [`tests-backend.md`](./tests-backend.md) — test cases for the servers and packages
- [`tests-frontend.md`](./tests-frontend.md) — test cases for the studio UI and rendered apps
