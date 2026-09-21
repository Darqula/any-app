# Provider, model and sweep history: resolved investigations

Numbers behind decisions that are settled. Open questions are in `../open-problems.md`. Everything is against
opencode.ai's "zen" gateway (`https://opencode.ai/zen/go/v1`; the SDK appends `/chat/completions`, and a base URL
with the path baked in once doubled it and 404'd on the marketing site). Dates are 2026.

## `glm-5.3-flash` never converged (08-30/31)

A reasoning model: it spends part of `max_tokens` on hidden `reasoning_content` before the `content` the app reads
(a "reply with hello" at `max_tokens: 500` used 123 reasoning tokens for a one-word answer).

| Call | Budget | Result |
| --- | --- | --- |
| Planner | 4,000 | empty, all reasoning |
| Planner | 12,000 | real content, cut off before `SLOTS` |
| Fill | 32,000 | empty over the full ~240 s stream |
| Linear fallback | 96,000 | empty over ~500 s |
| Planner + linear | 200,000 | rejected in ~2.8 s: the gateway's ceiling is 131,072 |
| Linear | 131,072 | ran ~570 s, completed normally, still empty |

Planner output improved with budget; fill/linear did not (32k and 96k both empty), so it is not a room problem. Never
explained. Switched to `longcat-2.0`, which converged on two consecutive real generations.

`longcat-2.0` run 2 (cleanest): planner prompt 431 / completion 1,692 (45 reasoning); fill prompt 1,915 / completion
6,510 (5,469 reasoning); ~10,550 tokens, 193 s. Fill's reasoning is 84% of its completion tokens, the planner's 3%.
Budgets 12,000 (planner) and 96,000 (fill) were reverted to last-known-good, ~5x and ~11x the measured use, not tuned.

## The ~300 s proxy timeout (fixed in Phase 3.5)

Node's undici body timeout is inactivity-based (~300 s) and fired (`UND_ERR_BODY_TIMEOUT`) because the studio wrote
nothing while the planner ran. Fix: doctype immediately, then a `<!-- planning -->` comment every 15 s; the sandbox's
own fetch is bounded by `PREVIEW_TIMEOUT_MS` (15 min) via `AbortSignal.any`. Verified structurally (a 20-30 s plan
showed exactly 2 heartbeats live and 0 in the stored document), never on a genuinely >300 s plan.

## `qwen3.8-flash` through the Anthropic-shaped endpoint (Phase 3.5)

The gateway also serves `/v1/messages` in the real Messages wire format (same key), which exercised the native
adapter end to end without an `sk-ant-` key.

| Call | Config | Result |
| --- | --- | --- |
| Planner (`completeText`) | 12,000 | empty: the `thinking` block ate the budget; surfaced as `RefusalError("empty response")`, fell back to linear |
| Planner (`completeText`) | 64,000 | rejected by the SDK before any request: "Streaming is required for operations that may take longer than 10 minutes" |
| Router (`completeText`) | 4,000 | succeeded twice (prompt 272 / completion 83; 270 / 55) |

## Caching: a false negative, corrected (08-31)

Early tests used 270-1,530-token prefixes, below any provider's minimum, and concluded the gateway does not cache.
With one identical ~4,500-token prefix sent twice, bypassing the app:

| Path | Call 1 | Call 2 |
| --- | --- | --- |
| OpenAI-compatible (`longcat-2.0`) | `cached_tokens: 0` | `cached_tokens: 4224` of 4245 |
| Anthropic-shaped (`qwen3.8-flash`) | `cache_creation_input_tokens: 4496` | `cache_read_input_tokens: 4496` |

Through the app, two `edit-css` calls (~2,000-token context) logged `cache_read=1920` on the second. The same pass
found `usageFrom` mapping only `cached_tokens`, never the gateway's `cache_write_tokens` extension. A realistic
app's fill context is already ~2,440 tokens.

## Parallel vs sequential fill (Phase 4)

Prompt: "A workout tracker with an exercise log, a progress chart, a weekly goal panel, and a rest timer",
`longcat-2.0`, same prompt in each mode. Both parallel runs used a 32,000-token per-region cap (traced from the
commands actually run; the final `.env` had misled a review into thinking parallel got 96,000).

| | Sequential (1 call) | Parallel run 1 | Parallel run 2 (after splitting the budget variable) |
| --- | --- | --- | --- |
| Wall clock | 2m30s | 3m49s | 6m3s |
| Completion tokens | 3,396 | 19,093 (5.6x) | 19,800 (5.8x) |
| Worst single call (reasoning) | 506 | 6,669 (one region) | 8,547 (one region) |

Caching cannot help: it discounts the repeated input prefix, not completion tokens. Concurrent cache reads are racy
on this gateway (a batch fired the instant the pre-warm returns saw ~0% hits; with a 1 s sleep one run hit 0/4, another
3/4 but only 128-256 of ~1,750 prefix tokens; a sequential follow-up hits reliably) yet that is a few thousand input
tokens against a >15,000 completion-token delta, so no more effort belongs there. Step 0's context wiring is a standing
win regardless: the edit loop resends the stylesheet on every edit.

Verified live: completion order differed from plan order (plan exercise-log, progress-chart, weekly-goals,
rest-timer; landed rest-timer, exercise-log, weekly-goals, progress-chart); a forced all-fail
(`LLM_FILL_MAX_TOKENS=2`) logged `slot "x" failed twice` per slot and left the row `failed`; replay had a single
doctype and matching slot/template/swap triples. **Not forced live:** exactly one slot failing while the rest
succeed, and a real disconnect mid-fan-out (only the `Promise.race` / unhandled-rejection mechanism was checked in
isolation).

## Planner budget on this machine (09-08/09)

The local `.env` overrides `LLM_PLANNER_MAX_TOKENS` to 12,000 (shipped default 20,000), so every sweep and probe
number below was produced under the tighter budget. Live sightings: `planner (openai): prompt=736 completion=12000
(10028 reasoning)` truncated and fell back to linear (`sequential/notes-app`); `completion=12000 (11999 reasoning)`,
one visible token, on `parallel/expense-tracker`. Every F4 failure whose cause survived was a budget truncation, not
a parse error; the third (`parallel/analytics-dashboard`) lost its logs to an OS kill before they were flushed.
This was also the first production sighting of truncation detection working (before it, a cut-off plan reached
`parsePlan` as if complete).

Reasoning spend is volatile run to run: a Tier 1 probe gave `contact-form` 10,837 completion tokens (9,459
reasoning), `counter` 7,885 (6,695), `analytics-dashboard` 11,778 (8,635), `todo-list` 2,243 (907); `contact-form`,
the simplest prompt, took 2,240 on the same prompt three hours earlier. Headroom cannot be judged from apparent
complexity (~5x range).

## Gateway `x-opencode-session` (09-07)

The gateway began 400-ing requests without the header ("Request is missing x-opencode-session and cannot be routed
efficiently") between the 09-06 sweep and 09-07; nothing in this repo had changed. Raw `fetch` with `max_tokens: 8`:
no extra headers 400; session header alone 200; session header plus custom user agent 200; user agent alone 400. Their
docs ask for a stable id per conversation and an own user agent. Handling and rationale: `providers.md`.

## Quality sweeps (section F): 10 prompts x 2 fill modes, `longcat-2.0`, ~1 h each

| | 09-05 | 09-06 (after the placeholder-matcher fix) | 09-07 (after the S13 prompt fix) |
| --- | --- | --- | --- |
| `PlanError` (doc F4) | 5 of 18 (28%) | 2 of 20 (10%) | 5 of 19 (26%) |
| generations that timed out / errored | 2 of 20 | 0 of 20 | 1 |
| apps with console errors (rendered F1) | 5 of 18 | 0 of 20 | 3 of 19 |
| interactive apps that work (rendered F8) | 3 of 8 | 6 of 10 | 4 of 10 |

- **Matcher root cause:** the slot placeholder was matched byte-exactly (`<div data-slot="x"></div>`), so the
  model's routine `<div class="panel" data-slot="chart">` was invisible: all missed gave an empty slot list and a
  `PlanError`, some missed dropped regions silently (a real response declared 3, `parsePlan` kept 2). Fixed by the
  tolerant scan, by augmenting the element instead of replacing it, and by failing loudly on a leftover mismatch. The
  console-error drop (5/18 to 0/20) is probably the second change: discarding the model's class had hidden the
  elements its own scripts and CSS targeted.
- **Survivorship:** F6/F8 looked worse after the fix only because the sloppiest plans used to die at `PlanError` and
  skip those checks. F4/F6 mode splits are noise (the planner call is identical in both modes); only fill-stage
  checks such as F8 can carry a mode signal.
- **Q1 was mostly the checker.** Its rate moved ~30% to 44% to 17% with no generation changing: F8 read `class="..."`
  built inside JS strings (5 of 13 failures; fixed by masking scripts and comments), scored tokens instead of
  elements, and never credited compound selectors because a `(?<![\w.])` lookbehind refused the second class of
  `.counter-btn.minus` (12 of 27 "offenders" were defined). The same lookbehind bug had been copied into production
  (`utilityCss`). Lesson: fix the metric before the model.
- **S13** (the shell script and the fill disagree about which element carries the region's class): baselines
  `DIAG:fill-wrapped-root` 28 of 49 slot contents, `DIAG:doubled-region-class` 0 of 49, `form-submit-inert` failing
  `parallel/contact-form`. After the prompt fix: doubled-class 0, wrapped-root 4 of 14 generations (mostly benign
  single-element content), doc F8 13/14 (93%) from 15/18 (83%).
- Sweep 3 also showed: at least 2 of 3 console errors were the missing `e.detail.element` (fixed since); F6 asserted
  the old byte-exact placeholder shape and read 2/14 (assertion since replaced).
- Reading of doc F8 by mode after the checker fixes: sequential 9/9, parallel 6/9 (Fisher exact p = 0.21, not
  significant); the three failures were `parallel/analytics-dashboard`, `parallel/todo-list`,
  `parallel/weather-widget`.
