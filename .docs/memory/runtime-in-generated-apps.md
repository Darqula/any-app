# Runtime code inlined into generated apps

Background for `packages/protocol/src/swap-runtime.ts` and `data-runtime.ts` (strings inlined into every
document; no dependencies, must parse in an old parser).

## swap runtime

- **Slot scripts must run exactly once, and the two fill paths differ.** A `<script>` parsed by the
  fragment algorithm (`innerHTML`, the postMessage edit path) has its "already started" flag set and never
  auto-runs once moved into the document. A `<script>` the document parser put inside a `<template>` (the
  initial `swap()` path) does not have the flag and runs by itself on insertion. So `fill()` takes
  `needsRerun`: `false` from `swap()`, `true` from the postMessage handler. The earlier "re-run
  unconditionally, it's harmless" was wrong (S16): a second execution throws in chart libraries ("Canvas is
  already in use") and is silent for double listeners, writes and timers. Guard: D11 in
  `tests/frontend/swap-runtime.spec.ts` (S6 established the HTML mechanics).
- **`slot:ready` carries `{ id, element }`.** `element` looks redundant, but generated shell scripts reach
  for `e.detail.element.querySelector(...)`; two apps in the 2026-09-07 sweep lost their whole shell script
  ("Cannot read properties of undefined") when it was missing (S15, D10).
- `studioOrigin` is baked in and checked against `event.origin`. It mattered little on an opaque origin and
  a lot once apps got per-app origins with storage (locked decision #8).
- A shell edit is deliberately not a message type: the frame is the document's own markup, so the studio
  page reloads the iframe (`frame.src = frame.src`).

## data runtime

- The model must never write its own HTTP wrapper: this is the one place
  `fetch("/data/...")` may appear. The token in the document is not a secret to hide; do not add
  obfuscation that suggests otherwise (see "Sharing exposes the data API" in `security.md`).
- Persisted documents carry `APP_TOKEN_PLACEHOLDER`, never a live token, because one stored row is served to
  viewers with different modes (owner `rw`, shared visitor `ro`); `withAppToken` substitutes per viewer.
- `withAppToken` uses `split`/`join`: `String.replace` with a replacement containing `$&` once spliced a
  matched block into a JS string literal.
