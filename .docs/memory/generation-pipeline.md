# Generation pipeline: findings and traps

Background for `packages/generator/src/` (planner, fill, parallel fill). Flow: planner -> fill (sequential:
one call for every region; parallel: one call per region behind a cache pre-warm) -> streamed as
`<template>` + `swap()`; if planning fails the Phase 1 linear path writes the whole document.

## `parsePlan`

- SLOTS must be non-empty, deliberately (S5). A looser `slotLines === undefined` check was tried and reverted:
  an empty SLOTS body is exactly what a response truncated after `===SLOTS===` looks like, so it would trade a
  loud recoverable `PlanError` for a quiet low-quality app on the project's most fragile call.
- A bad DATA line is dropped, not fatal: one wrong collection name must not turn a good shell into a
  linear-fallback failure.
- `onRawResponse` fires before `parsePlan` (as `tests/quality/probe.ts` does: write the raw response first). `sanitizePlaceholders` output, not the raw shell, is what gets persisted.

## The S13 prompt contract

The planner's SHELL placeholder rule and the fill prompts' "write only what goes inside" rule are one contract;
change `planner-prompt.ts`, `fill-prompt.ts` and `fill-slot-prompt.ts` together. Skip the planner half and a
class the fill wraps in never reaches the element scripts/CSS target; skip the fill half and the class lands
twice, nested (doubled padding/border/background). The real S13 document came from the *parallel* path.

Probe history for the SHELL wording: a 5-prompt probe (2026-09-07) got 13/13 placeholders carrying a class
(baseline 20%), but inviting a class before saying "must stay empty" drew content into a placeholder
(`counter-display` containing `0`); the tolerant scan refuses it, so `parsePlan` threw. Fix: "must stay
empty" is its own sentence right after the example. A 10-prompt probe (2026-09-08) held for content but not
for loading states: `analytics-dashboard` twice wrote a "Loading chart..." spinner into placeholders, because
nothing told the model a skeleton already exists. The sentence now names the skeleton as the reason.

## Cache prefixes

`appContext` (stylesheet, shell, script) is the narrowest stable unit so the pre-warm and every parallel slot
call share a byte-identical prefix. `fillContext` appends the slot list, which only extends an
OpenAI-compatible prefix; on Anthropic a sequential fill's combined block does not read a cache written by a
pre-warm alone. Edit calls build their own contexts and are not part of that shared set.

## Parallel fill (Phase 4)

A **measured cost regression on the default model** (`longcat-2.0`), so `LLM_FILL_MODE` defaults to
`sequential` (see root `CLAUDE.md`, `open-problems.md` and `model-and-sweep-history.md` before flipping it).

- Budgets are two variables on purpose: `LLM_FILL_SLOT_MAX_TOKENS` (per region) is not `LLM_FILL_MAX_TOKENS`
  (whole document). One variable with mode-dependent meaning made a controlled sequential-vs-parallel
  comparison impossible (Phase 4 review).
- **Pre-warm** exists because N concurrent calls start before any finishes, so none can read a cache the
  first has not written and every slot pays full input price. The response is discarded; failure is harmless.
  - The sleep after it is not decorative: a batch fired the instant the pre-warm returned saw a 0% hit rate
    (the write had not propagated); even a 1 s pause got only 1 of 4 calls to hit. It narrows the race, no
    read-your-writes guarantee exists to wait on.
  - The sleep also runs when the pre-warm *threw*: with `maxTokens: 1` a reasoning model normally ends in
    `RefusalError("empty response")` or `TruncationError`, and that call still writes the cache (confirmed
    against the gateway). Those two are logged apart from real failures or every 3+ slot generation would
    print a spurious "pre-warm failed".
  - Gated at 3+ slots: it costs a round trip that rarely pays back below that.
- Slots yield in completion order, not plan order; `swap()` is order-independent. `asCompleted` requires tasks
  never to reject; `limitConcurrency` starts everything and gates the *work* with a semaphore (a
  "worker over items" helper would resolve only at the end and lose completion-order streaming).

## Streaming helpers and errors

- The trailing-fence guard holds back the last 16 bytes; before it, a trailing fence showed on first view and
  vanished on reload.
- `isAbortError` must use `instanceof` against each SDK's class: neither overrides `name`, so an
  `error.name === "AbortError"` check never matches (a mistake already made once).
- `scrub`: a live 401 once wrote `Incorrect API key provided: REPLACE_ME` into `generations.error`; harmless for
  an operator placeholder, a breach with user-supplied keys. Hence a known-secrets pass plus a key-pattern pass.


## Design choices not to reverse

- **Sectioned text (`===NAME===`), not JSON or `response_format`.** A plan carries a whole stylesheet and a block
  of HTML, which JSON must escape onto one line (where weaker models fail, and one stray quote costs the call);
  JSON-mode support varies across OpenAI-compatible gateways. Sections need no escaping, stream, and parse with
  one regex. Assistant prefill is off the table for the same portability reason.
- The planner call is not streamed: its output is unusable until complete, so keep its `max_tokens` modest.
- Sequential fill has no fence stripper (a fence would sit invisibly inside a `<template>`, and stripping
  across slot boundaries is more machinery than it is worth); parallel fill strips per slot.
- A failed region becomes the error placeholder in `content`, not a missing key: `renderDocument` stays total
  and the region is fixable from the edit box. Every region failing marks the row `failed`
  ("every region failed to generate").
- Slot scripts run in nondeterministic order live and in plan order on replay, hence the slot prompt's rule
  against touching another region at load time (use `slot:ready`).
- **Stored documents come only from `renderDocument`.** An earlier route rebuilt the saved document from the
  shell head and fills with `String.replace`: it put slot scripts before the shell script (a `ReferenceError`
  on reopen, and `slot:ready` never fired), and a slot containing a literal `$&` spliced skeleton markup into
  the document.
- Known, accepted: a literal `</template>` in slot content closes the template early (not escaped; the A6 test
  pins the current output).
