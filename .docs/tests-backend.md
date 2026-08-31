# Test Cases — Backend

**Status:** draft · 2026-08-30
**Scope:** `apps/studio`, `apps/sandbox`, and everything in `packages/`.
Browser-side behaviour is in [`tests-frontend.md`](./tests-frontend.md).

Cases marked **(P2)** depend on Phase 2 landing; the rest apply to the code as it stands.

---

## The harness decision that makes this list possible

Almost every interesting behaviour in this system is a *streaming* behaviour — partial
chunks, markers split across chunk boundaries, aborts halfway through, malformed model
output. None of that is testable against a real provider: it is slow, costs money, and you
cannot ask a real model to emit a marker split across two TCP packets.

**Run the whole suite against a fake OpenAI-compatible server.** The current design already
allows this with no mocking library and no code change: `getClient()` reads
`OPENAI_BASE_URL`, so a test fixture starts a local HTTP server that speaks the
chat-completions wire format and points the env var at it.

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

### A5 — `renderSkeletons` / `renderFilled` / `slotIdsInShell` (P2)

| ID | Case | Passes when |
|---|---|---|
| A5.1 | Exact placeholder | Replaced with `<div id="slot-x" class="anyapp-skeleton" style="min-height:Npx">` |
| A5.2 | Placeholder with an extra attribute | **Not** replaced — locks in the deliberate strictness |
| A5.3 | Placeholder for an id absent from the spec list | Rendered with height 0, no throw |
| A5.4 | `renderFilled` with content missing for a slot | Empty div, no `undefined` in output |
| A5.5 | `slotIdsInShell` | Returns ids in document order |
| A5.6 | **Duplicate slot id in shell** | Assert the chosen behaviour — two elements would share a DOM id and `swap()` would fill only the first. Decide whether `parsePlan` rejects it, then test that |

A5.6 is not a hypothetical; a planner listing the same region twice is a plausible failure,
and nothing currently rejects it.

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

D8 is the second constraint recorded in `open-problems.md`: the proxy `fetch` has no explicit
timeout today, so it inherits undici's default and caps how long *any* generation can take
regardless of provider. With BYOK that gets worse — a user pointing at a slow local model
hits it routinely.

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

Track these as a **pass rate across N runs**, not as a binary. F1 and F8 in particular are
the early warning for the Phase 4 coherence problem; if they are already flaky with one
sequential fill call, parallel fan-out will be much worse.

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

**G15 (real provider, nightly):** Anthropic, two identical calls carrying a `cache_control`
breakpoint on the shared prefix → the second reports `usage.cache_read_input_tokens > 0`.
This is the one that matters for Phase 4: if caching is not actually landing, parallel fan-out
costs far more than the plan assumes, and nothing else in the suite would notice.

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
| I3 | `apps/sandbox/src/**` | Imports nothing from `@any-app/store` except `loadEnv` |
| I4 | Repository-wide grep | No `compression` package anywhere |
| I5 | `views.ts` | The preview iframe's `sandbox` attribute contains `allow-scripts` and **not** `allow-same-origin` (locked decision #8) |
| I6 | `packages/generator/src/**` (P3.5) | No provider SDK is imported outside the adapter directory — the rest of the generator sees only the interface |
| I7 | Repository-wide grep (P3.5) | No route or view interpolates a raw credential; error persistence always goes through the scrubber |

---

## Suggested order

1. **The fake provider fixture.** Nothing else in C, D, E, or F is writable without it.
2. **A6, A4, A1** — the streaming parsers, where the bugs actually are.
3. **B4, C9, C10, C15** — the concurrency and abort regressions from the review; these
   protect fixes that were verified by hand once and are otherwise easy to regress.
4. **E1–E5, I1–I7** — invariant guards. Slow to think of, seconds to write, and they fail
   loudly on exactly the refactors that would otherwise ship silently broken.
5. **A2, A3, A5, A7, B, C, D** — the remaining coverage.
6. **F, G15** — on a schedule, against a real provider.

For Phase 3.5, insert **H4 and H5 before the BYOK storage layer exists** — a credential leak
is much cheaper to prevent than to discover — then **G1–G14** as the adapters are written,
running each case against both wire formats.
