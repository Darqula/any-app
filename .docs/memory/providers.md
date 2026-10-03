# Provider adapters: incidents and traps

Background for `packages/generator/src/providers/`. Model selection per role is in the root `README.md`;
provider/model investigation history is `model-and-sweep-history.md`, open issues are `open-problems.md`.

## Gateway session header (opencode.ai "zen")

Since 2026-09-07 the gateway 400s without a stable `x-opencode-session` and asks for its own `User-Agent`.
Sent unconditionally by both adapters (harmless elsewhere; the base URLs can each point at this gateway).
It must be **stable for every call of one generated app**: a fresh id per request defeats the
routing/caching it exists for, and the project's economics depend on prompt caching. One process-wide
fallback id serves calls with no generation (credential validation); two independently generated ids would
defeat each other's caching.

## Prompt caching layout

`system` + per-app `context` are the stable prefix, the instruction is volatile. Anthropic gets one text
block with a cache breakpoint at that boundary (the reason the native adapter exists instead of the OpenAI
shim, decision #9); OpenAI-compatible caching is automatic, so only prefix stability matters.
`cached_tokens` is the only way to see whether caching works on a given gateway; `cache_write_tokens` is a
gateway extension outside the SDK type. Anthropic `thinking_delta` events must never be emitted or
reasoning lands in the generated app.

## Aborts (S8)

Both SDKs end a *streaming* iterator silently on abort (no throw), unlike `completeText`. The studio used to
persist a half-written document as `complete` when a viewer closed the tab mid-fill, and its
`isAbortError -> resetForRetry` guard could never fire. Both adapters now raise the SDK abort error after the
loop; on Anthropic also before `finalMessage()`, which would report a partial message.

## Truncation and refusal (S14)

Adapters used to return a budget-truncated response as complete. Live: a planner call ended at
`completion=11968` of a 12,000 budget mid-section, `parsePlan` accepted it, and the app's data collections
vanished with no error. So `TruncationError` (`finish_reason:"length"` / `stop_reason:"max_tokens"`) is
distinct from `RefusalError` (only truncation merits a bigger budget). `RefusalError.kind` (`"declined"` vs
`"empty"`) is the discriminator; matching `reason` text breaks silently after a reword, and `"empty"` is what
a reasoning model produces when hidden reasoning eats the whole budget.

**Post-stream check order is abort, usage, truncation, empty content.** Truncation is remembered and thrown
after the loop: throwing on `finish_reason:"length"` would skip the trailing usage chunk (empty `choices`)
and race the abort check the wrong way. Abort must beat `sawContent`, or a pre-first-delta abort surfaces as
`RefusalError("empty response")`, reported as "the model declined". Truncation must beat `sawContent` too
(different follow-up: bigger budget vs none).

## Usage accounting

`onUsage` fires beside `logUsage` before every `throw` (Phase 6 step 8), so a truncated call is still
counted; a "log only on success" refactor would silently stop billing the most expensive outcome. It must
never throw on the caller's behalf.


## Things not to "improve" in the Anthropic adapter

- **No assistant prefill** to force `<html`: a 400 on current models. The system prompt plus the fence stripper
  is the portable route on both providers.
- **No `budget_tokens`**: a 400 on current models. If thinking control is ever wanted it is
  `thinking: { type: "adaptive" }` plus `output_config: { effort }`.
- Text deltas only (see above), and a non-streaming `completeText` cannot take a huge `max_tokens`: the SDK
  rejects it before any request goes out, and 128k budgets are streaming-only.

## Reading a zero cache read

`cache_read_input_tokens: 0` is not proof of broken wiring. The prefix must exceed the model's minimum
cacheable length (512-4096 tokens), be byte-identical, and go to the same model (caches are model-scoped, so a
pre-warm on another model warms nothing). Two mistakes are on record: the Phase 3.5 review found
`ProviderRequest.context` unused by every call site, so the Anthropic breakpoint sat around a short static
prompt while everything worth caching rode in the volatile field; and a later "the gateway does not cache"
conclusion came from 270-1530-token test prefixes. At ~4.5k tokens both gateway paths hit cleanly.

## Other decisions

- The linear fallback reuses the `fill` role instead of a fifth `LLM_LINEAR_*` role: it only runs after
  planning failed and does the same kind of work.
- `CREDENTIAL_KEY` must be 32 bytes, base64; the studio refuses to boot otherwise, because the alternative is
  storing user keys in plaintext.
