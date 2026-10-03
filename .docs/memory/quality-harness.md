# Quality harness (`tests/quality/`): findings and traps

The section-F sweep drives fixed prompts x fill modes against a **real provider** (costs real money; refuses
without `--yes` / `ANYAPP_QUALITY_RUN=1`; never in CI). It is a *report*, not a test suite: it exits 0 whenever the
sweep completed and non-zero only when the harness is broken (server would not start, DB unreachable, provider auth
failed). Usage and layout: `tests/quality/README.md`. The S13 probe is the cheap alternative to a full sweep.

## Design rules

- The prompt set is fixed on purpose: pass rates over time or between fill modes only mean something if the
  prompts are held constant. Add one only deliberately, never to chase a rate up.
- Doc checks scan the persisted plan/document themselves and do **not** import `slots.ts`'s scanner: a check that
  calls the production scanner passes by construction and measures nothing (same reason F4 never calls `parsePlan`).
- `checks-rendered.ts` has no `lib.dom` on purpose (root tsconfig cannot be touched, and an ambient DOM lib would
  leak globals into the whole program): in-page logic is a string passed to `page.evaluate()`.
- Diagnostics are `DIAG:...` ids in their own tables, never counted in F1-F8, and kept in separate id lists in
  `report.ts` so they never look like a ninth spec case (`DOC_CASE_IDS` also drives the `attemptError` fallback).
  A generation whose attempt threw records every check as `error`, so one bad run cannot shrink the denominator.
- Replay a saved generated app over a real http origin, never `page.setContent`: its opaque origin makes a
  top-level `localStorage.getItem` throw and kills the app's whole script, which looks exactly like a broken
  app (it nearly produced a false negative on the S12 fix).
- Server logs are written beside the report before `stop()`; `ANYAPP_PLANNER_RAW_DIR` points at the run directory so a
  `PlanError`'s raw response is on disk. Before that, diagnosing a moved `PlanError` needed a second paid run.

## Check semantics that are easy to misread

- **F3 order** is scored only under sequential fill (from the `swap()` sequence in the raw stream; the persisted
  document is always plan-ordered); under parallel fill out-of-order completion is correct, so it is skipped.
- **F6** runs over the already-sanitised shell, so "content inside a placeholder" is no longer observable there; the
  emptiness check is an invariant guard. The model-behaviour signal is the studio log line
  `[parsePlan] stripped-placeholder-content: slot "<id>" ...`. The old byte-exact shape assertion was deleted on
  2026-09-06 (a class on the placeholder is the S13 fix; it read 2/14).
- **F8** is per element (fails only when *no* class is defined), narrowed from a token-level version that flagged
  `class="tab js-tab-hook"`. Honest history: the examples used to justify that (`counter-btn minus`, ...) were the
  `CSS_CLASS_SELECTOR` lookbehind bug (`document-model.md`); the narrowing stands but matters far less. Gaps: classes
  added by `classList.add` or built in scripts are invisible; a class named only in a CSS comment counts as defined.
- **`DIAG:form-submit-inert`** reloads the page first. It runs after F4, which clicks submit with empty fields; on a
  client-validated form that leaves error text visible, and the diagnostic's own refill later clears it, changing
  `innerText` in *both* the broken and the working document: `parallel-contact-form.html` read "pass" through the
  full pipeline and "fail" on a fresh load. `innerText` is used because it excludes `display:none`.
- F8-interactive samples text after **each** click (a counter's `-`, `+`, `Reset` goes 0 -> -1 -> 0 -> 0, so
  before/after alone sees no change on a working app). F4 skips navigating anchors (they would tear down the page).
- **S13 diagnostics:** `DIAG:fill-wrapped-root` (fill wrapped its content in one element carrying a planner-defined
  class; the setup for S13, not a bug alone) and `DIAG:doubled-region-class` (the same class on placeholder and
  wrapped root; zero when written, a tripwire for a prompt change that puts the class on the placeholder).

## S13 probe (`probe.ts`)

Tier 1: one real planner call per prompt, measuring how many placeholders carry a class (baseline 10/49 = 20%,
2026-09-06). Tier 2: real fill calls over plans reconstructed from the saved 2026-09-06 artifacts, measuring whether
content wraps itself in a planner-class element (baseline 28/49 = 57%, a provider-free replay). Four saved documents
already had classed placeholders and are used as-is. `--dry-run` proves the pipeline against a stub provider and
*asserts* the numbers. A real run refuses without `--yes`/`ANYAPP_PROBE_RUN=1` and prints the call count first.

**The 2026-09-07 misread:** a `--tier2 --limit=12` run printed the corpus-wide 28/49 beside a 12-slot result and read as
57% -> 17%; the true paired figure for those slots was 3 -> 2 (inconclusive, two flipped the wrong way). Fixes: subset
runs report a **paired** before/after (corpus number labelled background, flips counted both ways); `--only-wrapped`
restricts to slots the fix can move; `--limit` no longer takes alphabetical order (every `parallel-*` sorts before every
`sequential-*`, draining one mode), using a deterministic mode-interleaved round-robin instead, printed before any spend.
