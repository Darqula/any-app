# Test Cases — Backend

**Status:** resynced against the Phase 5 code · 2026-08-31
**Scope:** `apps/studio`, `apps/sandbox`, and everything in `packages/`.
Browser-side behaviour is in [`tests-frontend.md`](./tests-frontend.md).

**Nothing here has been implemented yet.** Phases 0–5 shipped verified by hand. This document
was written during Phase 2 and last updated at Phase 3.5, so this pass brings it back in line
with the code as it actually stands: five assertions that would now fail on *correct* code
have been corrected, three references to deleted functions repaired, and two new sections
added for Phases 4 and 5.

Phase markers (**P2**, **P4**, **P5**) now record *when a case became relevant*, not what is
still pending — every phase they refer to has landed.

> **The corrected assertions are the reason to resync before implementing, not after.** I5
> here and B2/B5 in the frontend doc asserted the pre-Phase-5 origin posture: no
> `allow-same-origin`, no working `localStorage`. Phase 5 deliberately inverted all three.
> Implemented as written, they fail on correct code — and the cheapest way to make I5 green
> is to delete `allow-same-origin`, which silently reverts locked decision #8.
>
> That they went stale is also the argument *for* them. Had they been running, Phase 5 could
> not have changed the origin posture quietly; it would have had to turn a red test green on
> purpose, which is exactly the conversation worth forcing.

---

## The harness decision that makes this list possible

Almost every interesting behaviour in this system is a *streaming* behaviour — partial
chunks, markers split across chunk boundaries, aborts halfway through, malformed model
output. None of that is testable against a real provider: it is slow, costs money, and you
cannot ask a real model to emit a marker split across two TCP packets.

**Run the whole suite against a fake OpenAI-compatible server.** This still needs no mocking
library and no production code change, but the seam has moved since this was written.
`getClient()` is gone — `client.ts` is now sixteen lines containing only `isAbortError`.
Point the fixture in through any of three places, in increasing order of isolation:

- `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL` — the platform credentials read by
  `resolve.ts`. Simplest, and the closest analogue of what this doc originally described.
- `LLM_<ROLE>_PROVIDER` / `_MODEL` / `_MAX_TOKENS` — per-role, so one role can be pointed at
  the fake while another is left unconfigured, which is what case G13 needs.
- A stored session credential — the BYOK path, which is the only way to exercise section H
  end to end.

Having three seams rather than one is a Phase 3.5 dividend worth using: several cases below
are about *resolution* (which provider a role picks, and what happens when it picks one with
no credential), and those are only testable because the choice is configuration.

That fixture is the single highest-value thing to build first. It must support:

- replaying a scripted sequence of SSE chunks, with **caller-controlled chunk boundaries**
  (so a marker can be split anywhere)
- configurable per-chunk delay, for timing assertions
- returning `finish_reason: "content_filter"`, an empty response, and HTTP 400/500
- **counting requests**, so "replay made no provider call" is assertable
- recording whether a request was **aborted** by the client

**From Phase 3.5 the fake must speak two wire formats**, not one — OpenAI chat-completions
SSE and Anthropic Messages SSE. They differ in where the system prompt goes, in the shape of
a delta event, and in how a refusal is signalled, and those differences are exactly what the
adapters exist to hide. A fake that only speaks one format can only test one adapter, which
defeats the point. Build it as one scripted core with two serialisers.

Everything below assumes it exists. Use `node:test` (built into Node 22 — no dependency) and
a scratch Postgres database per run.

**Section K is the exception and can be written first.** The Phase 5 data API touches no
model at all — it is HTTP plus Postgres — so it needs the scratch database but not the fake
provider. If the fixture turns out to be a bigger job than expected, K is real coverage of
the newest and most security-sensitive surface, available immediately.

### Running this suite alongside the frontend one

The two suites are largely independent and can be built in parallel. Three things have to be
agreed up front rather than discovered:

**1. This suite owns the fixture; the frontend suite consumes it.** Build it once, here, but
design the interface for *both* callers on day one. The frontend needs something this list
never asks for — explicit chunk-driving (`await fake.emit(chunk)`) so intermediate render
states can be asserted without racing real timing. A fixture built only for the cases below
gets rebuilt the first time a frontend test needs to hold a chunk open.

**2. This suite must not bind the real ports.** Use ephemeral ports throughout. The frontend
suite cannot: `swapRuntime` bakes `STUDIO_PUBLIC_URL` into every generated document and
validates `event.origin` against it, and the data API derives its host check from
`SANDBOX_APP_ORIGIN_TEMPLATE`, so those tests are origin-pinned by construction. If both
suites want `localhost:3000` and `*.apps.localhost:3001`, they cannot run concurrently.

**3. Someone has to script the `anyapp_sandbox` role, and it is currently on nobody's list.**
Section K needs it, and `impl-phase-5.md` creates it by hand on purpose — it takes a password,
so it is operator setup rather than a migration. A scratch database per run needs that
bootstrap automated. It belongs with this suite, since K is what depends on it, but it is
worth naming as its own task rather than assuming it falls out of `migrate()`.

Cases duplicated across the two suites are deliberate, not redundant: I5 pairs with the
frontend's B2, and H4/H5 with its G4/G7. Both halves should go red together. Do not
"deduplicate" them — the point is that a server-side guarantee and its browser-visible
consequence can drift apart.

---

## A. Pure functions

No I/O, no fixtures. These are the cheapest tests and cover the fiddliest code.

### A1 — `createFenceStripper`

| ID | Case | Passes when |
|---|---|---|
| A1.1 | Plain HTML, one chunk | Output is byte-identical to input |
| A1.2 | ` ```html\n<html>` in one chunk | Fence line removed, `<html>` kept |
| A1.3 | Fence split as `` "`" ``, `` "``html\n" ``, `"<div>"` | Fence removed, `<div>` kept |
| A1.4 | Leading whitespace-only chunks, then content | Whitespace dropped, no content lost |
| A1.5 | Content legitimately starting with two backticks (`` ``x ``) | Passed through unchanged — not mistaken for a fence |
| A1.6 | Any input, any chunking | Concatenated output loses no non-fence bytes |

A1.6 is worth writing as a property test over random chunk splits of a fixed document. The
stripper is a state machine with an early-exit path; random splitting is how you find the
case where `decided` flips one chunk too soon.

### A2 — `stripTrailingFence` / `createTrailingFenceGuard`

| ID | Case | Passes when |
|---|---|---|
| A2.1 | Document ending `</html>\n\`\`\`` | Fence and surrounding whitespace removed |
| A2.2 | Document with backticks in the middle | Untouched |
| A2.3 | Guard: input longer than `holdBack` (16) | Everything but the last 16 bytes is emitted during `push` |
| A2.4 | Guard: input shorter than `holdBack` | `push` emits nothing, `flush` emits all of it |
| A2.5 | Guard: `push` output + `flush` output | Equals input minus the trailing fence |
| A2.6 | Guard: fence preceded by >16 chars of whitespace | Documents the known limit — assert current behaviour, don't pretend it strips |

### A3 — `parseSections` (P2)

| ID | Case | Passes when |
|---|---|---|
| A3.1 | All five sections present | Each body returned, trimmed |
| A3.2 | `SCRIPT` section absent | Key absent, no throw |
| A3.3 | `===CSS=== trailing text` | Not treated as a header — headers must be alone on the line |
| A3.4 | A `===` line inside CSS content | Not treated as a header unless it matches the full pattern |
| A3.5 | Empty section body | Returns empty string, not undefined |
| A3.6 | No markers at all | Returns `{}` |

### A4 — `parsePlan` (P2)

| ID | Case | Passes when |
|---|---|---|
| A4.1 | Well-formed plan | `AppPlan` with slots in **shell order**, not `SLOTS` order |
| A4.2 | Slot in `SHELL` missing from `SLOTS` | Included with default height 200 and a default spec |
| A4.3 | Slot in `SLOTS` missing from `SHELL` | Dropped — the shell is the source of truth |
| A4.4 | Invalid slot id (`Timer`, `1x`, 40 chars) | Skipped, no throw |
| A4.5 | Height `abc` / `5` / `99999` | Becomes 200 / clamped to 40 / clamped to 2000 |
| A4.6 | `TITLE` or `CSS` missing | `PlanError` naming the sections it did find |
| A4.7 | Shell with zero placeholders | `PlanError` |
| A4.8 | Whole response wrapped in a code fence | Parsed anyway |
| A4.9 | Spec text containing a `\|` | Preserved — the split rejoins the tail |
| A4.10 | No `DATA` section at all (P5) | `collections` is `[]`, no throw — the common case, and it must stay the cheap one |
| A4.11 | `DATA` with one valid line (P5) | One collection, name and description split on the first `\|` |
| A4.12 | `DATA` with an invalid collection name (P5) | That line skipped, the rest kept — same tolerance as A4.4 |

A4.10 is load-bearing rather than trivial. `DATA` is optional precisely because most apps are
static and this project's planner is the fragile call — a required sixth section would turn
"this app has no backend" into a plan-parse failure and a linear fallback.

### A5 — `renderSkeletons` / `renderDocument` / `slotIdsInShell` (P2)

| ID | Case | Passes when |
|---|---|---|
| A5.1 | Exact placeholder | Replaced with `<div id="slot-x" class="anyapp-skeleton" style="min-height:Npx">` |
| A5.2 | Placeholder with an extra attribute | **Not** replaced — locks in the deliberate strictness |
| A5.3 | Placeholder for an id absent from the spec list | Rendered with height 0, no throw |
| A5.4 | `renderDocument` with content missing for a slot | Empty template, no `undefined` in output |
| A5.5 | `slotIdsInShell` | Returns ids in document order |
| A5.6 | **Duplicate slot id in shell** | `parsePlan` throws `PlanError` naming the repeated id |
| A5.7 | `renderDocument` emits slots in **plan** order (P4) | True even when `content` was populated in completion order — the live stream and the replay are no longer byte-identical, and that is correct |

> A5.4 and the section title previously named `renderFilled`, which no longer exists. Phase
> 2's replay-divergence fix made the streamed bytes themselves the stored document and
> deleted it; `renderDocument` is the single producer now.

A5.6 was written as "decide whether `parsePlan` rejects it, then test that." It does now, and
for the reason the case predicted: two elements sharing a DOM id leave the second a permanent
skeleton, which surfaces as an inexplicable stuck loading state rather than as an error.

A5.7 is the Phase 4 consequence worth pinning. The obvious assertion — that a replayed
document is byte-identical to the streamed one — was true through Phase 3 and is deliberately
false from Phase 4 onward. Asserting the old invariant would fail on correct code.

### A6 — `createSlotStream` (P2)

The highest-value unit in the phase. It is a streaming parser, so chunk boundaries are the
whole point.

| ID | Case | Passes when |
|---|---|---|
| A6.1 | One slot | `<template id="c-x">` … `</template><script>swap("x")</script>` |
| A6.2 | Three slots | Each template closed and swapped before the next opens |
| A6.3 | Marker split as `"===SLO"` + `"T timer===\n"` | Recognised as a marker |
| A6.4 | Marker with trailing spaces/tab | Recognised |
| A6.5 | Prose before the first marker | Dropped, not emitted |
| A6.6 | Near-miss lines (`==SLOT x==`, `===SLOT===`, `===slot x===`) | Treated as content, not markers |
| A6.7 | Stream ends with a slot open | `flush()` closes the template and emits the swap |
| A6.8 | Stream with no markers at all | Empty output, no throw |
| A6.9 | `content` map after completion | Keys and values match what was emitted per slot |
| A6.10 | Slot id in the swap call | JSON-escaped, so a hyphenated id is quoted correctly |
| A6.11 | Content containing the literal `</template>` | Assert current (broken) behaviour and leave a pointer — documented as accepted in the Phase 2 plan |

### A7 — Escaping helpers

| ID | Case | Passes when |
|---|---|---|
| A7.1 | `errorBanner` with `<script>` in the message | Escaped, cannot break out of the `<pre>` |
| A7.2 | `escapeHtml` in `views.ts` with a `"` | Escaped — it is used in an attribute context |

### A8 — `mintAppToken` / `verifyAppToken` (P5)

Pure functions, no I/O, and the whole of the data API's authorization. Cheapest high-value
tests in the document.

| ID | Case | Passes when |
|---|---|---|
| A8.1 | Round trip | `verifyAppToken(mintAppToken(id, s), s) === id` |
| A8.2 | Different secret | `null` |
| A8.3 | One character of the MAC changed | `null` |
| A8.4 | App id swapped for another valid uuid, MAC left alone | `null` — the id is signed, not merely carried |
| A8.5 | `""`, `"no-dot"`, `".mac"`, a token with no MAC | `null`, no throw |
| A8.6 | `UUID_PATTERN` against `"a" × 36`, 36 hyphens, misplaced hyphens | All rejected — these passed the pre-review pattern and reach a `uuid` column |
| A8.7 | `UUID_PATTERN` against `gen_random_uuid()` output, both cases | Accepted |
| A8.8 | Determinism | Minting the same id twice yields the same string — this is what makes an edited app keep its data |

A8.8 looks like a tautology and is the point of the whole design. A stored random token would
be dropped by `renderDocument` on the first edit, silently disconnecting a working app from
its own rows; deriving it makes that failure unrepresentable.

A8.6 guards a deliberate strictness: the pattern is *narrower* than Postgres's own `uuid`
parser, which also accepts the 32-hex-no-hyphen and brace-wrapped forms. That is not a bug to
fix — ids only ever come from `gen_random_uuid()`, and admitting two spellings of one id buys
nothing.

---

## B. Store and database

Needs a real Postgres. Use a scratch database per run and `migrate()` to build it.

| ID | Case | Passes when |
|---|---|---|
| B1 | `migrate()` run twice | Second run is a no-op; each file appears once in `schema_migrations` |
| B2 | A failing migration | Transaction rolls back; the file is not recorded |
| B3 | `claimForGeneration` on `pending` | Returns true, status becomes `streaming` |
| B4 | Two `claimForGeneration` calls in parallel on one row | **Exactly one** returns true |
| B5 | `claimForGeneration` on `streaming` | Returns false |
| B6 | `claimForGeneration` on `complete` | Returns false |
| B7 | `claimForGeneration` on `failed` | Returns true — retry after failure is intended |
| B8 | `resetForRetry` | Status back to `pending`, claimable again |
| B9 | `markComplete` | Sets document, clears `error` |
| B10 | `markFailed` | Sets error, leaves any earlier document alone |
| B11 | `markCompleteWithPlan` (P2) | Stores document and plan; `plan` round-trips through JSONB unchanged |
| B12 | `listRecentGenerations` | Newest first, respects the limit |

B4 is the regression test for review finding F1. Write it with two genuinely concurrent
connections, not two sequential awaits — a sequential version passes even with the old
non-atomic code.

---

## C. Studio routes

| ID | Case | Passes when |
|---|---|---|
| C1 | `GET /health` | `{"ok":true,"service":"studio"}` |
| C2 | `POST /generations` with a prompt | Row created as `pending`; response contains an iframe |
| C3 | `POST /generations` with blank/whitespace prompt | 400, no row created |
| C4 | Internal route with no secret header | 403 |
| C5 | Internal route with a wrong secret | 403 |
| C6 | Internal route with the right secret, unknown id | 404 |
| C7 | Happy path, full stream | 200; body has doctype, then skeletons, then templates and swaps; row `complete` |
| C8 | Replay of a `complete` row | Body identical; **fake provider request count unchanged** |
| C9 | Two concurrent stream requests for one id | Exactly one provider call; the loser gets the "Already generating…" body with a meta refresh |
| C10 | Client disconnects mid-stream | Provider request aborted; row back to `pending`; no document saved; server still serving |
| C11 | Provider returns `finish_reason: "content_filter"` | Row `failed`; error banner in the body |
| C12 | Provider returns an empty stream | Row `failed` with "empty response" |
| C13 | Provider returns HTTP 500 | Row `failed`; server stays up |
| C14 | Planner returns unparseable output (P2) | Falls back to the linear path; app still renders; row `complete` |
| C15 | Planner call is **aborted** (P2) | Does **not** fall back to linear — abort must propagate |
| C16 | Fill call fails after the shell was written (P2) | Error banner appended to the already-open response; row `failed` |

C15 is a real branch in the Phase 2 route (`if (ac.signal.aborted) throw error` inside the
planner catch). It is easy to get wrong in a way no other test notices: a viewer who closes
the tab during planning would otherwise trigger a full linear generation nobody is watching.

C10 should assert on the **fake provider's** abort record, not just on the database row.
The row can end up correct while the upstream request keeps running.

---

## D. Sandbox routes

| ID | Case | Passes when |
|---|---|---|
| D1 | `GET /health` | `{"ok":true,"service":"sandbox"}` |
| D2 | `GET /preview/:id` | Proxies the studio's body through unchanged |
| D3 | Sandbox → studio request | Carries the `x-internal-secret` header |
| D4 | Studio returns 404 | Sandbox returns 404, not 500 |
| D5 | Studio is down | Sandbox responds without crashing the process |
| D6 | Viewer disconnects | Upstream fetch is aborted (assert on the studio side) |
| D7 | Viewer disconnects **before** upstream headers arrive | No unhandled rejection; nothing written to a dead socket |
| D8 | A generation that runs longer than undici's ~300s default (P3.5) | Not killed by the default body timeout — the proxy `fetch` sets its own, deliberately chosen |

D8 was the second constraint recorded in `open-problems.md` and is **fixed** — Phase 3.5 gave
the proxy `fetch` its own bound (`PREVIEW_TIMEOUT_MS` via `AbortSignal.any`) and the studio a
15s heartbeat, so a slow generation is no longer killed by undici's ~300s *inactivity*
default. The case stays because both halves are easy to lose: delete the heartbeat and a slow
planner call starts failing again, with nothing in the logs pointing at the timeout. Assert
both — a generation quiet for longer than 300s survives, and the response carries heartbeat
comments while it is quiet.

D7 covers the one gap left after the F3 fix: `await fetch(..., { signal })` has no
`try`/`catch`, so an abort at that moment rejects into Express's default error handler.
Currently harmless, but the test pins the behaviour.

---

## E. Wire-format invariants

These are what make streaming actually work, and every one of them can be silently broken by
a plausible-looking refactor.

| ID | Case | Passes when |
|---|---|---|
| E1 | First bytes of any generated response | `<!doctype html>` — nothing before it |
| E2 | Response headers | No `Content-Encoding` — compression must never be added |
| E3 | Response headers | `Transfer-Encoding: chunked`, no `Content-Length` |
| E4 | Time to first byte, with a fake that delays its first chunk 2s | Headers and the shell arrive well before that — proves `flushHeaders()` still works |
| E5 | Bytes before the first content chunk | At least 1KB, so the browser starts parsing |
| E6 | Shell arrives before the fill call starts (P2) | Assert ordering against fake request timestamps |
| E7 | Slot templates appear **after** the shell script | Ordering: shell script must run before any slot lands |

E4 is the regression test for the most likely future breakage. Someone adds a middleware,
`flushHeaders` stops taking effect, everything still passes functionally, and the product
silently loses the one property it exists to have.

---

## F. Provider-output contract

String-level checks on what the model produced, run against a **real** provider on a nightly
or on-demand job, not in CI. Rendered-output checks live in the frontend doc.

| ID | Case | Passes when |
|---|---|---|
| F1 | Fill output (P2) | Contains no `<style>` element — the coherence rule |
| F2 | Fill output (P2) | Contains no markdown fence |
| F3 | Fill output (P2) | Emits a section for **every** slot in the plan, in order |
| F4 | Plan output (P2) | Parses without a `PlanError` |
| F5 | Plan output (P2) | Slot count is between 2 and 6 |
| F6 | Plan output (P2) | Every placeholder matches the exact required shape |
| F7 | Any generated document | External references only from `cdnjs.cloudflare.com` |
| F8 | Class names used in slot content (P2) | Defined in the planner CSS — catches the "content appears unstyled" failure before a human sees it |

Track these as a **pass rate across N runs**, not as a binary. F1 and F8 in particular are the
early warning for the fan-out coherence problem: if they are already flaky with one sequential
call, N isolated calls will be worse.

Since Phase 4 landed, these have a second use — **run the set in both fill modes and compare
the rates.** "Does per-slot generation produce worse apps than one coherent pass?" is the
open question the `LLM_FILL_MODE` toggle was built to answer, and F1/F8 are the only
automated way to answer it. `open-problems.md` currently records parallel fill as a
*cost* regression on this project's model; whether it is also a *quality* regression has never
been measured, and a pass-rate delta across these eight cases is the measurement.

---

## G. Provider adapters (P3.5)

The adapters exist to make two different wire protocols indistinguishable to the generator.
These cases run the *same* assertions against both, which is the only way to know that.

| ID | Case | Passes when |
|---|---|---|
| G1 | OpenAI adapter, `streamText` | Yields exactly the `choices[0].delta.content` text, in order |
| G2 | Anthropic adapter, `streamText` | Yields `text_delta` content only — `thinking` deltas are never emitted as app HTML |
| G3 | Both adapters, `completeText` | Return the full text of a non-streamed response |
| G4 | Both, abort mid-stream | `isAbortError` is true for **each SDK's own** abort error class |
| G5 | OpenAI, `finish_reason: "content_filter"` | `RefusalError` |
| G6 | Anthropic, `stop_reason: "refusal"` | `RefusalError` — the same class, so callers need no provider branch |
| G7 | Anthropic refusal with and without `stop_details` | Category surfaced when present; null-safe when absent |
| G8 | Both, empty response | `RefusalError("empty response")` |
| G9 | System prompt placement | OpenAI: a `role: "system"` message. Anthropic: the top-level `system` field, never a message |
| G10 | Anthropic, assistant prefill | Never attempted — it returns a 400 on current models |
| G11 | Reasoning-model token budget | The raised budget applies only to the roles configured for it, not globally |
| G12 | Per-role resolution | Planner, fill, edit, and router each resolve their own provider, model, and budget; an unset role falls back to the default |
| G13 | A role pointed at a provider with no credential | Fails at resolution with a clear message, **before** any HTTP call |
| G14 | The same plan prompt through both adapters | Both produce output `parsePlan` accepts — the adapter changes transport, not semantics |

**G15 (real provider, nightly):** two identical calls carrying a large enough shared prefix →
the second reports `cache_read_input_tokens > 0` (Anthropic) or `cached_tokens > 0`
(OpenAI-compatible).

Caching is now **confirmed working on both paths** — Phase 4's pre-flight measured clean hits
at a ~4,500-token prefix, and corrected an earlier "this gateway doesn't cache" conclusion
that turned out to be a false negative from testing a prefix too short to be cacheable at
all. So G15 is a regression guard, not an open question, and it has a specific trap: **use a
realistic prefix.** A minimal one silently reports zero, which looks identical to broken
caching and cost this project an investigation once already.

Note also what G15 does *not* tell you. Caching discounts repeated input; Phase 4's measured
regression was in *completion* tokens, which caching cannot touch. A green G15 is compatible
with parallel fill being a cost regression — see `open-problems.md`.

G4 deserves care. Each SDK throws its own abort class, and neither sets `name` to
`"AbortError"` — checking the name string looks reasonable and silently never matches. That
mistake has already been made once on this project.

---

## H. Credentials and BYOK (P3.5)

| ID | Case | Passes when |
|---|---|---|
| H1 | Store a credential | The database column does not contain the plaintext key as a substring |
| H2 | Read it back for use | Decrypts to the original |
| H3 | Any route that returns credential info | Returns a mask and a timestamp — never the key |
| H4 | Provider 401 whose message echoes the key | The persisted `generations.error` contains no substring of the key |
| H5 | The same failure | `console.error` output contains no substring of the key |
| H6 | Saving an invalid key | Rejected at save time by a cheap validation call, not hours later mid-generation |
| H7 | Fallback chain | User credential → platform credential → a clear error when neither exists |
| H8 | Two sessions | Session A can neither read nor generate with session B's credential |
| H9 | Deleting a credential | Subsequent generation falls back or fails cleanly; no stale decrypt |
| H10 | Encryption key absent from the environment | The server refuses to start rather than storing plaintext |
| H11 | A completed generation | Neither `document` nor `plan` contains any credential substring |

H4 and H5 are not hypothetical. During live testing a 401 wrote
`Incorrect API key provided: REPLACE_ME` into `generations.error` — the configured credential,
verbatim, in a database column. That is survivable when the key is yours and is a placeholder;
it is a breach when the key belongs to a user. Write these two before the BYOK storage layer,
not after.

---

## I. Architecture guards

Cheap static tests that enforce rules the review flagged as security bugs rather than style
issues. `architecture.md` says npm's flat `node_modules` cannot enforce these, so CI must.

| ID | Case | Passes when |
|---|---|---|
| I1 | `apps/sandbox/package.json` | Does not list `@any-app/generator` |
| I2 | `apps/sandbox/src/**` | Contains no import of `@any-app/generator` |
| I3 | `apps/sandbox/package.json` (P5) | Does **not** list `@any-app/store` at all |
| I4 | Repository-wide grep | No `compression` package anywhere |
| I5 | `views.ts` (P5) | The preview iframe's `sandbox` attribute contains **both** `allow-scripts` and `allow-same-origin`, **and** its `src` host is derived per app — the two must move together |
| I6 | `packages/generator/src/**` (P3.5) | No provider SDK is imported outside the adapter directory — the rest of the generator sees only the interface |
| I7 | Repository-wide grep (P3.5) | No route or view interpolates a raw credential; error persistence always goes through the scrubber |
| I8 | `apps/sandbox/src/**` (P5) | No `Access-Control-Allow-Origin` anywhere — the data API is same-origin by construction |
| I9 | `apps/sandbox/src/data.ts` (P5) | `app_id` is only ever read from `res.locals`, never from `req.body`, `req.query`, `req.params`, or a header |
| I10 | `apps/studio/src/views.ts` (P5) | No `postMessage(..., "*")` — every call pins a specific target origin |
| I11 | `session.ts` (P5) | The session cookie is set with no `Domain` attribute |

**I3 changed shape, and the new shape is the point.** It used to read "imports nothing from
`@any-app/store` except `loadEnv`" — a statement about import specifiers, checkable only by
grep and attention. The Phase 5 review found that importing even that one export evaluates
`store/src/index.ts`, which builds a pool under the privileged role at module scope, so the
sandbox process held a privileged pool it never used. Now the sandbox does not depend on the
package at all, which is one line of `package.json` and the first of these rules that CI can
enforce as cheaply as `architecture.md` has always claimed.

**I5 is inverted from what this document said before**, and asserting the old version would
fail on correct code. Phase 5 added `allow-same-origin` deliberately, because a same-origin
`fetch("/data/...")` from inside the frame needs it — and it is only safe because apps moved
to per-app origins at the same time. Test them together: an `allow-same-origin` frame on a
*shared* origin is the failure locked decision #8 exists to prevent, and either half alone
looks fine.

**I11 is new, and it is subtler than it looks.** `CLAUDE.md` says never move the sandbox to
`localhost` because it is a different cookie domain from the studio. Phase 5 moved generated
apps to `<id>.apps.localhost` — a *subdomain* of the studio's own host. The session cookie is
still not sent there, but no longer for the reason `session.ts`'s comment gives ("a different
host"): it is because the cookie is host-only, having no `Domain` attribute. Adding
`Domain=localhost` — a plausible-looking change if someone ever wants the session shared
across subdomains — would hand every generated app the studio's session cookie. One
assertion, and it is the only thing standing in front of that.

---

## J. Parallel fill (P4)

Sections J and K are appended after I rather than inserted before it, so every existing case
id in this document keeps its number — the same reason Phase 3.5 was numbered 3.5 instead of
renumbering four phases.

`LLM_FILL_MODE` currently defaults to `sequential`, so **none of this runs in the default
configuration.** That is exactly why it needs tests: the parallel path is complete, correct,
and one env var away, and it is now the code most likely to rot unnoticed.

| ID | Case | Passes when |
|---|---|---|
| J1 | `asCompleted` with tasks resolving out of order | Yields in **completion** order, not input order |
| J2 | `asCompleted`, every task resolving | All N yielded exactly once |
| J3 | `asCompleted` where one task rejects | The generator throws, and **no `unhandledRejection` fires** for the others |
| J4 | `limitConcurrency(2)` over 5 tasks | Never more than 2 running at once; all 5 complete |
| J5 | `limitConcurrency` with a rejecting task | The semaphore is released — later tasks still run rather than deadlocking |
| J6 | `fillSlotWithRetry`, first call fails, second succeeds | One retry, `failed: false` |
| J7 | Same, both calls fail | `slotErrorPlaceholder` content, `failed: true`, **no throw** |
| J8 | Same, first call returns empty string | Retried — an empty region is a failure, not content |
| J9 | Same, abort mid-call | Throws rather than returning a placeholder; an abort is not a retryable failure |
| J10 | Route, one slot of four fails | Row `complete`, three real regions and one placeholder |
| J11 | Route, every slot fails | Row `failed` with "every region failed to generate" |
| J12 | Pre-warm with fewer than 3 slots | Not called — no extra round trip on small apps |
| J13 | Pre-warm that throws `RefusalError("empty response")` | Treated as success: logged at `log`, not `warn`, and the fan-out proceeds |
| J14 | Whole parallel run | Exactly `slots.length + 1` provider calls (fan-out plus one pre-warm) |

**J3 is the one to write first.** It is the only case here that was verified once, by a
throwaway script, and never again. `asCompleted` deliberately breaks its own documented "tasks
must never reject" contract for aborts, and the reason it is safe is subtle: `Promise.race`
attaches a rejection handler to every pending task, so the ones still in flight when the
generator throws do not become unhandled rejections later. Node 22 crashes the process on an
unhandled rejection, so a refactor that loses that property turns a closed browser tab into a
dead server — and nothing else in this suite would catch it.

J13 encodes a genuinely counter-intuitive finding: on a reasoning model a `maxTokens: 1`
pre-warm normally *fails*, because the budget is consumed before any visible text — and it
still writes the cache. A test asserting the pre-warm "succeeds" would be asserting the wrong
thing.

---

## K. Per-app tokens and the data API (P5)

Needs Postgres and the `anyapp_sandbox` role, but **no model and no fake provider** — this is
the one section writable before the fixture exists. It is also the newest and most
security-sensitive surface in the project.

Every case here that mentions two apps needs two real tokens minted from two different ids.

| ID | Case | Passes when |
|---|---|---|
| K1 | Any `/data/*` request with no `Authorization` header | 401 |
| K2 | Token signed with the wrong secret, or one MAC character changed | 401 |
| K3 | App A's valid token presented on app B's host | 403 — the host cross-check |
| K4 | App A's token, asking for a collection app B owns | Empty list, not an error — scope comes from the token, so B's rows are simply not in A's world |
| K5 | Rows created by A | Never returned to B under any query |
| K6 | `where[status]=open` (P5) | Filters. **Regression guard for the Express 5 query parser** — see below |
| K7 | `where[done]=true` against a stored boolean | Matches — the string/boolean coercion |
| K8 | `where[count]=3` against a stored number | Matches |
| K9 | No `where` at all | Returns everything in the collection, newest first |
| K10 | `limit` of `0`, `-1`, `1000`, `abc` | Clamped to 1–100, default 25, no throw |
| K11 | Paging with `cursor` to the end | Every row seen exactly once; `nextCursor` null on the final page |
| K12 | Short page (fewer rows than `limit`) | `nextCursor` is null, not a cursor onto an empty page |
| K13 | Malformed cursor (`"x"`, base64 of `"garbage|nope"`) | 400, no 500, nothing reaches Postgres |
| K14 | `:id` that is not a uuid | 404, no 500, no stack trace in the body |
| K15 | Any unexpected DB error | `{"error":"internal error"}` — never Express's default stack trace |
| K16 | Invalid collection name | 400 |
| K17 | Create past `MAX_RECORDS_PER_APP` | 409 |
| K18 | Request body over `MAX_RECORD_BYTES` | 413 |
| K19 | Repeated distinct-key PATCHes, each under the cap | The one that would push the row over the cap gets **413**, not 404, and the row does not grow |
| K20 | PATCH against a genuinely missing id | 404 — distinguished from K19 |
| K21 | Write rate limit exceeded | 429, and reads still work — the buckets are per kind |
| K22 | `anyapp_sandbox` role against `generations` / `provider_credentials` | `permission denied` |
| K23 | Response body of any data route | Contains no `app_id` — it is scope, not payload |
| K24 | Document rendered for a plan with no collections | Contains neither the data runtime nor a token |
| K25 | Document rendered twice for one app (generate, then edit) | Same token both times |

**K6 is the highest-value single case in this document.** Express 5 changed the default query
parser to one with no bracket-notation support, so `where[status]=open` parses as a flat key
literally named `"where[status]"`, `req.query.where` is `undefined`, and **every filter
silently matches every row**. It was caught live during Phase 5 and fixed with one
`app.set("query parser", "extended")` line. Nothing about the failure looks like a failure:
requests succeed, JSON comes back, the data is real. Without a test, the next person to
touch sandbox startup can delete that line and the suite will stay green.

K3 and K4 are deliberately separate. K4 is the actual security property — scope derives from
the token — and it would still hold if K3's host check were removed entirely, because the
host check is defence in depth. Testing only K3 would let someone "simplify" the real
guarantee away while the tests stayed green.

K19 and K20 exist as a pair for the same reason. Both are zero-rows-back from one `UPDATE`;
collapsing them into a single 404 is the obvious simplification, and it makes an over-size
patch report "not found" for a record that plainly exists.

---

## Suggested order

Revised for the code as it stands. The original order assumed the fixture had to come first;
two groups no longer need it, and both cover code that shipped on a single hand-verification.

Steps 1–2 need no fixture, so this suite starts immediately, in parallel with the frontend
one. The frontend's own first three steps need no fixture either — see its "Seeding instead
of generating" — so the interface conversation in step 3 has room to happen while both are
busy.

1. **A8, J1–J5** — pure functions, no fixture, no database. The token pair is the whole of the
   data API's authorization, and `asCompleted`/`limitConcurrency` are the only concurrency
   primitives in the project. **J3 first**: it is the one property in this document currently
   protected by a script that no longer exists.
2. **K, plus I1–I11**, and the `anyapp_sandbox` bootstrap script K depends on. K needs
   Postgres but no model; the guards need neither. Together they cover the newest surface and
   the five invariants that have already gone stale once.
3. **The fake provider fixture.** Everything below needs it, and so does the frontend suite
   from its step 5 — settle the interface with both callers before building.
4. **A6, A4, A1** — the streaming parsers, where the bugs actually are.
5. **B4, C9, C10, C15** — the concurrency and abort regressions from earlier reviews; these
   protect fixes verified by hand once and otherwise easy to regress.
6. **E1–E7, J6–J14** — wire-format invariants and the fan-out's failure handling.
7. **A2, A3, A5, A7, B, C, D, G1–G14, H** — the remaining coverage.
8. **F, G15** — on a schedule, against a real provider.

H4 and H5 were written to land before the BYOK storage layer existed. That ship has sailed —
the layer shipped in Phase 3.5 — so they move into step 7 with the rest of H, but they keep
their standing as the two cases worth writing first within it: a credential leak is much
cheaper to prevent than to discover, and this project has already had one.
