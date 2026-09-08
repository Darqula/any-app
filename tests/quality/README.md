# `tests/quality` — the section-F generated-app quality sweep

Implements backend `.docs/tests-backend.md` section **F. Provider-output contract** (F1-F8)
and frontend `.docs/tests-frontend.md` section **F. Generated-app quality** (F1-F9).

**This is not a test suite.** It never asserts and never goes red on a normal exit. Both specs
say these checks run against a **real provider**, on a nightly or on-demand job, **never in
CI**, and are tracked as a **pass rate across N runs**, not a binary — "a single failure means
the model had a bad run; a falling rate means something regressed." So this is a *runner that
produces a report*: a readable table on stdout, plus a JSON file per run for diffing pass rates
over time. It is not registered with `node --test` and is not discovered by
`npm run test:backend` (which globs `backend/**/*.test.ts`, and nothing here is named or
placed there) or `npm run test:frontend` (which uses `tests/frontend/playwright.config.ts`'s
explicit file list). Playwright is driven **programmatically** (`chromium.launch()` from the
`playwright` package) rather than through the `playwright test` CLI, specifically so this stays
outside that discovery mechanism too.

## What it costs

**Real money, real provider, real time.** Each generation is a real call to whatever
`LLM_MODEL`/`OPENAI_BASE_URL` (or `ANTHROPIC_*`) your repo-root `.env` configures — the same
platform credential `npm run dev` uses. Ten prompts x two fill modes (sequential, parallel) is
20 real generations at roughly 2-3 minutes each: **budget about an hour and whatever 20
generations cost on your configured model.** `--prompts=N` and `--modes=` narrow this down for
a cheap smoke run (see below).

**The runner refuses to run without explicit authorization.** Pass `--yes` (or set
`ANYAPP_QUALITY_RUN=1`) or it prints the cost banner (model, prompt count, mode count, total
generations) and exits with a non-zero code having spent nothing. This is deliberate: nobody
should be able to burn an hour of tokens by running the wrong npm script by accident.

## Running it

The exact command string for the `test:quality` npm script (added by the repo owner, not by
this package — see the task constraints):

```
node --import tsx tests/quality/runner.ts
```

Add `--yes` to actually run it. Useful flags:

```powershell
# Full sweep: 10 prompts x 2 modes = 20 real generations, ~1 hour.
node --import tsx tests/quality/runner.ts --yes

# Cheap smoke run: 1 prompt, 1 mode, a few minutes.
node --import tsx tests/quality/runner.ts --yes --prompts=1 --modes=sequential

# Everything, sequential mode only (skip the parallel-fill comparison).
node --import tsx tests/quality/runner.ts --yes --modes=sequential

# Named prompts instead of "first N".
node --import tsx tests/quality/runner.ts --yes --prompts=counter,todo-list --modes=parallel
```

Run it from the repo root (matches the command string above) — `runner.ts` resolves its own
paths from `import.meta.url`, the same way every `tests/harness/*.ts` file does, so the
working directory otherwise doesn't matter.

## What it does

For each fill mode requested:

1. `createScratchDatabase()` — a fresh, migrated `anyapp_test_<random>` database, dropped in a
   `finally` no matter what happens. Never touches the real `anyapp` database.
2. `startServers()` on ephemeral ports, with `LLM_FILL_MODE` set for that mode **as a server
   env var at spawn time** — not an `.env` edit, since `.env` is read once per process
   (`loadEnv`) and this repo's `.env` is never touched by this runner. The real platform
   credential (`OPENAI_API_KEY`/`OPENAI_BASE_URL`/`LLM_MODEL`/etc., read once from the
   repo-root `.env` without ever being written to `process.env` — same pattern as
   `harness/db.ts`'s `readSuperuserDatabaseUrl`) is forwarded into that spawned env.
3. For each prompt: `POST /generations`, then drive it to completion by hitting
   `/internal/generations/:id/stream` directly (the same seam
   `tests/backend/studio-stream.test.ts`'s C7 case uses) — this is a REAL generation against
   the real provider, not a seeded row.
4. Read the persisted `generations` row back with a plain `pg` client (never
   `@any-app/store` — same reasoning as the rest of this harness: no module-scope pool
   singleton to accidentally reuse across scratch databases).
5. Run the backend F checks (`checks-doc.ts`) against the row and the raw streamed bytes.
6. If the row completed, open a real Chromium page at
   `http://<id>.apps.localhost:<port>/preview/<id>` (the real per-app origin, exactly what a
   viewer sees) and run the frontend F checks (`checks-rendered.ts`).
7. Save a full-page screenshot and the generated HTML to `tests/quality/artifacts/<run
   timestamp>/` — always, not only on failure, so a human has something to look at either way
   (F9's "reviewed by a human on failure" becomes "the artifact is there when you go looking").
8. Append the result to the report and **rewrite the JSON report file immediately** — a later
   throw does not lose generations that already completed (requirement: partial results must
   survive one bad generation out of twenty).

After every mode requested has run, it prints the stdout table (per-case pass rate for
`sequential` and `parallel` side by side, plus the delta) and does a best-effort check that no
`anyapp_test_*` database survived.

## Exit codes

- **0** — the sweep ran to completion. This says nothing about the pass rates; a 0% pass rate
  on every case is still exit 0, because that is data, not a harness failure.
- **non-zero** — the harness itself broke: the server wouldn't start, the database was
  unreachable, the provider rejected the configured credential (detected by pattern-matching
  the response/error text for things like "No credential configured", "401", "invalid api
  key"), the server process appears to have died mid-sweep (a raw `ECONNREFUSED`/
  `net::ERR_CONNECTION_REFUSED`-shaped failure rather than an application-level response), or
  the runner was invoked without `--yes`/`ANYAPP_QUALITY_RUN=1`. A single generation
  timing out, producing malformed output, or failing a quality check is **never** a non-zero
  exit — it is recorded and the sweep continues to the next prompt.

## Layout

- `prompts.ts` — the fixed 10-prompt set, with comments on why each is included and which F
  cases it's meant to exercise.
- `checks-doc.ts` — backend F1-F8, over the persisted `plan`/`document`/`error` and the raw
  streamed bytes (needed for F3's ordering half). Every function has a comment on exactly what
  it approximates and where — see especially F3, F7, and F8 below.
- `checks-rendered.ts` — frontend F1-F9, over the live page in a real Chromium. No `lib.dom`
  anywhere in this file (see its header comment) — every piece of in-page logic is a plain JS
  string passed to `page.evaluate()`, because this package's root `tsconfig.json` cannot be
  touched and has no exclusion carved out for `tests/quality` the way it does for
  `tests/frontend`.
- `runner.ts` — orchestration: CLI parsing, the cost guard, one scratch DB + server pair per
  mode, driving each generation, progress logging, harness-vs-data failure classification.
- `report.ts` — turns accumulated `CheckResult`s into the stdout table and the JSON file.
  Never runs anything itself.
- `artifacts/` — gitignored. One subdirectory per run (`<ISO timestamp>/`), holding
  `report.json`, one screenshot, and one HTML file per generation attempted.

## S13 probe (`probe.ts`) — not the sweep

`probe.ts` (plus its two helper modules, `probe-reconstruct.ts` and `probe-stub.ts`) is a
**separate, much cheaper tool**, not a smaller version of `runner.ts`. It exists to answer one
specific question — did S13's prompt fix (`.docs/testing-review.md`) actually change model
behaviour? — without paying for a full 20-generation sweep, and without conflating "the
planner half of the fix worked" with "the fill half of the fix worked" the way one full
generation necessarily does (a generation that still fails could be either half, or both).

**Use `runner.ts` for a general quality read on the current prompts/model.** Use `probe.ts`
only when the question is specifically S13: does the planner now put the region's class on
the placeholder, and does the fill call stop wrapping its output once that class is there.

Two independently-selectable tiers:

- **Tier 1** (`--tier1`): one real PLANNER call per prompt (`resolve("planner", null)` +
  `provider.completeText` with `PLANNER_PROMPT` directly — never `planApp`, so a malformed
  response is captured raw before `parsePlan` is even attempted, not lost to a thrown
  `PlanError`; see `.docs/open-problems.md`'s Q2). Measures: of every slot placeholder in the
  returned shell, how many carry at least one class? Prompt count defaults to 5, is
  configurable via `--count=N`, and always includes `contact-form` (S13's reproduction case)
  regardless of `N` — selection is deterministic and is printed before anything runs.
- **Tier 2** (`--tier2`): real FILL calls only, no planner spend. Plans are reconstructed from
  the saved documents in `artifacts/2026-09-06T17-31-26-174Z/` (`probe-reconstruct.ts` pulls
  `css`/`shell`/per-slot `content` back out of the rendered HTML — there was no existing
  plan-from-document reconstruction in this repo to reuse, so this module is that reverse of
  `renderDocument`/`renderHead`). Four documents whose placeholders already carried a class are
  used as-is; the rest have the B-shape synthesized (the wrapped fill content's own root class
  moved onto its placeholder) before calling `fillSlot`. Measures: does the fresh fill response
  still wrap itself in a single element carrying a planner-defined class? Defaults to every
  slot in the corpus (49 today); `--limit=N` caps it for a cheaper run, and `--only-wrapped`
  restricts the corpus to slots that were already wrapped before the fix (28 today) — the only
  slots the fix can actually move, since an already-unwrapped slot can only stay flat or
  regress. `--limit` is applied AFTER `--only-wrapped`.

Both tiers' "is this wrapped" measurement is `checks-doc.ts`'s own `analyzeSlotRoots` /
`wrappedRootOffenders` (the exact logic behind `DIAG:fill-wrapped-root`), imported and reused,
never reimplemented — see that file's comment on `wrappedRootOffenders` for why a second
hand-rolled definition of "wrapped" is exactly the mistake this is avoiding.

**A subset run (`--limit` and/or `--only-wrapped`) never reports the corpus-wide 28/49 as the
comparison.** A 2026-09-07 `--tier2 --limit=12` run printed the corpus-wide baseline next to a
12-slot result and read as a 57%->17% improvement; the true, paired figure for those same 12
slots was 3->2 (inconclusive — two slots even moved the wrong way). `probe.ts` now prints a
PAIRED before/after over exactly the slots a run covers (the corpus-wide number appears once,
explicitly labelled "background only, NOT the comparison"), plus a per-slot flip count in both
directions, with any unwrapped->wrapped regression flagged with a `>>> REGRESSION >>>` marker
on its own row — not just visible in a net total. `--limit`'s sample is also no longer raw file
order (which sorts every `parallel-*` document before every `sequential-*` one and produced the
all-`parallel-*` sample behind that misread) — it's a deterministic order that interleaves
documents by fill mode and then round-robins across their slots, so a prefix of any size draws
from both modes and many documents rather than draining one. The exact slot selection (covered
and excluded, and why) is always printed before any spend — see `printTier2Selection` in
`probe.ts`.

```powershell
# Paired, targeted Tier 2 run: only slots that can show a difference, capped at 12, real calls.
node --import tsx tests/quality/probe.ts --tier2 --only-wrapped --limit=12 --yes
```

**Cost guard**, same convention as `runner.ts`: prints the resolved provider/model and the
planned call count per tier, then refuses to spend without `--yes` (or
`ANYAPP_PROBE_RUN=1`), exiting non-zero. `--dry-run` swaps in an in-process stub `Provider`
(`probe-stub.ts` — no network, not even `tests/harness/fake-provider.ts`'s HTTP fixture) and
runs the same code end to end, printing explicit `[PASS]`/`[FAIL]` self-checks including a
replay of Tier 2's baseline measurement over the real saved artifacts (no provider call) that
must reproduce 28 of 49.

```powershell
# Validate the whole pipeline against a stub provider — no network, no cost.
node --import tsx tests/quality/probe.ts --dry-run

# Tier 1 only, real planner calls, default 5 prompts (always includes contact-form).
node --import tsx tests/quality/probe.ts --tier1 --yes

# Tier 2 only, real fill calls, capped at 10 slots for a cheap look before running all 49.
node --import tsx tests/quality/probe.ts --tier2 --limit=10 --yes

# Both tiers, real calls.
node --import tsx tests/quality/probe.ts --tier1 --tier2 --yes
```

## Where each F case had to approximate, and why

Read the doc comment on each `check*` function in `checks-doc.ts`/`checks-rendered.ts` for the
full reasoning — this is the short version, called out because a couple of these are
genuinely ambiguous in the spec text itself, not just simplified for time:

- **F3** ("emits a section for every slot, in order") splits into a coverage half (scored in
  both fill modes) and an order half (scored **only** under sequential mode — under parallel
  fill, out-of-order completion is the intended behavior, not a defect, so scoring order there
  would just measure HTTP scheduling luck).
- **F7** ("external references only from cdnjs.cloudflare.com") is scoped to `src=`/`href=`
  attribute values, not every URL-shaped substring in the document. This is deliberate (a
  slot's placeholder text is free to *mention* a URL without "referencing" it) but has a real
  gap: an inline `fetch("https://...")` inside a slot's own `<script>` is neither a `src` nor
  an `href` and would slip through.
- **F8 (backend, class names)** is scored at *element* granularity, not token granularity: an
  element fails F8 only when **none** of its class tokens is defined in the planner CSS. This
  was narrowed from an earlier version that failed a slot on *any* undefined token, even one
  sitting beside a defined class on the same element — e.g. `class="tab js-tab-hook"` where
  `tab` is defined and `js-tab-hook` never appears in the CSS in any form. The spec's own
  justification for F8 is "catches the 'content appears unstyled' failure before a human sees
  it" — an element with a defined base class is not unstyled, so failing it over an extra
  undefined modifier token was flagging a case the spec's stated purpose doesn't describe as a
  defect. An element with *zero* defined class tokens still fails F8 exactly as before; that's
  the genuine "content appears unstyled" case, unchanged. This is a narrowing to match the
  spec's stated purpose, not a relaxation to improve the number — the underlying "no defined
  class" defect is still fully caught. The token-level signal didn't vanish: undefined modifiers
  on an otherwise-styled element are still reported separately as `checks-doc.ts`'s
  `checkF8ModifierDiagnostic` (id `DIAG:undefined-modifier`), which `report.ts` prints in its own
  "Backend diagnostics" table, explicitly marked informational and never folded into the F1-F8
  pass rate.
  Worth being candid about: the real examples first used to motivate this narrowing
  (`class="counter-btn minus"`, `class="mode-btn active"`) turned out to be a *different* bug,
  not real modifiers — `CSS_CLASS_SELECTOR` used to carry a lookbehind that silently failed to
  credit the second and later class in a compound selector (`.counter-btn.minus{}` never
  registered `minus` as defined), so those "modifiers" were always actually styled. Once that
  regex bug was fixed (see its comment in `checks-doc.ts`), the diagnostic bucket fires on
  nothing at all across this project's one measured real sweep (20 documents) — every
  "undefined modifier" seen so far was the planner defining it as a compound selector, which the
  fixed regex now credits. The element-vs-token distinction F8 makes is still the right reading
  of the spec on its own terms (a class that is genuinely never defined anywhere, compound
  included, really is just a selector hook on an otherwise-styled element), it just turns out to
  matter far less often in practice than first thought. The diagnostic stays in the report as a
  tripwire: an always-empty bucket that starts firing on a future sweep is a real, new "planner
  forgot to style this state" signal.
  F8 also only checks classes present in *static* `class="..."`/`class='...'` attributes in the
  initial HTML — `<script>` bodies and `<!-- -->` comments are masked out before the scan, so a
  class added later via `classList.add(...)`, or built into markup a script injects at runtime
  via string concatenation (`'<span class="' + cls + '">'`), is invisible to this string-level
  check and is simply not counted, in either direction. The masking is load-bearing, not
  optional: before it existed, that concatenation pattern was scored as used-but-undefined
  almost every time — the regex ran off the end of the JS string to the next literal quote and
  produced a "class list" made of JS tokens, not real classes.
- **F5 (frontend, "no lorem ipsum")** is exactly as gameable as the spec itself says: a model
  writing "Lörem Ipsüm" or splitting the phrase across elements passes trivially. Implemented
  as the literal substring check the spec describes, no more.
- **F7 (frontend, contrast ratio)** samples one pairing — `document.body`'s computed text
  color against the nearest ancestor's solid `background-color` — not every text/background
  pairing on the page, and falls back to white for image/gradient backgrounds it can't resolve
  to a solid color.
- **F8 (frontend, interactive state change)** is a model-agnostic heuristic (click up to five
  plausible controls, checking whether rendered text differs **after each click**, not just
  before-the-first vs. after-the-last) rather than a real "does the counter increment"
  assertion. The per-click sampling is load-bearing, not cosmetic: this sweep's own minimal
  real run generated a counter whose `-`/`+`/`Reset` buttons landed in that DOM order, so
  clicking all three took the display 0 -> -1 -> 0 -> 0 — a before/after-only comparison would
  have reported "no change" on an app that plainly works. It still cannot distinguish a
  genuine state change from an incidental one (a tooltip left open), so a false pass remains
  possible. Scored only for prompts tagged `"interactive"` in `prompts.ts`.
- **F4 (frontend, click everything)** skips anchors whose `href` looks like it would navigate
  away, rather than following them — this app is a single page, and a real navigation would
  tear down the very page the rest of the checks (F5-F9) still need. External links get no
  click coverage from this sweep.

None of this is hidden inside the code only — every approximation above is also a comment
directly on the function that makes it, so reading `checks-doc.ts`/`checks-rendered.ts` alone
tells the same story as this section.
