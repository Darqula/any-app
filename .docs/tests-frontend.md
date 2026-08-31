# Test Cases — Frontend

**Status:** draft · 2026-08-30
**Scope:** the studio UI, the streamed preview document, the `swap()` runtime, and the
rendered behaviour of generated apps. Server-side behaviour is in
[`tests-backend.md`](./tests-backend.md).

Cases marked **(P2)** depend on Phase 2 landing; the rest apply to the code as it stands.

---

## Harness

**Playwright**, driving a real Chromium. There is no way around a real browser here: the
things worth testing are progressive HTML parsing, `<template>` semantics, script execution
timing, and cross-origin isolation. None of them exist in jsdom.

Run against the **same fake provider** the backend suite uses (see `tests-backend.md`).
That is what makes timing and ordering assertions possible — a fake that emits slot two
before slot one, or stalls for two seconds mid-document, is the only way to test the
behaviours that matter. Both servers must be running on their real origins
(`localhost:3000` and `127.0.0.1:3001`), because several cases assert on the boundary
between them.

Two Playwright specifics worth setting up once:

- Assertions about *intermediate* states (skeletons visible, some slots landed) need the
  fake to hold a chunk open. Drive it explicitly — `await fake.emit(chunk)` — rather than
  racing against real timing.
- The preview iframe is cross-origin and sandboxed without `allow-same-origin`, so
  `frame.contentDocument` is null from the studio page. Use Playwright's `frameLocator` /
  `page.frames()`, which work across origins.

---

## A. Studio UI

| ID | Case | Passes when |
|---|---|---|
| A1 | Fresh load, no generations | Empty state message; no iframe |
| A2 | Submit a prompt | An iframe appears in `#stage` |
| A3 | Submit an empty/whitespace prompt | Validation blocks it; no iframe, no new row |
| A4 | Reload after a generation | The prompt appears in the sidebar with its status |
| A5 | Click a sidebar entry | `#stage` swaps to that app's iframe |
| A6 | Prompt longer than 80 characters | Sidebar label truncated |
| A7 | Failed generation | Sidebar shows `failed`, styled by `.status-failed` |
| A8 | Two rapid submits | Each produces its own row; the second replaces the frame |

### A9 — Prompt text is escaped in the sidebar

Submit a prompt of `"><img src=x onerror=alert(1)>` and assert no dialog fires and no `img`
element exists in the sidebar. `escapeHtml` covers this today; the test exists because the
sidebar is the one place user text is interpolated into studio HTML, and studio is the
trusted origin.

---

## B. Security invariants

The highest-value group in this document. Every case here tests something the architecture
depends on and that nothing else would notice breaking.

| ID | Case | Passes when |
|---|---|---|
| B1 | Preview iframe `src` | Host is `127.0.0.1`, **not** `localhost` |
| B2 | Preview iframe `sandbox` attribute | Contains `allow-scripts`; does **not** contain `allow-same-origin` |
| B3 | Generated app reads `document.cookie` | Empty, even after a cookie is set on `localhost:3000` |
| B4 | Generated app touches `window.parent.document` | Throws a cross-origin `SecurityError` |
| B5 | Generated app calls `localStorage` | Throws or is empty — opaque origin, no persistence |
| B6 | Generated app `fetch`es a studio endpoint | Blocked by CORS; response unreadable |
| B7 | Preview URL opened **directly** in a tab | Renders, but assert it is on the sandbox origin only — documents the known Phase 5 exposure from locked decision #8 |

B3 through B6 need the fake provider to return an app whose script attempts the access and
writes the result somewhere observable — a `title` change is the simplest channel out of a
sandboxed frame.

B7 does not assert a fix. It pins the current state so that when per-app origins arrive
before Phase 5, the test is updated deliberately rather than the exposure being forgotten.

---

## C. Progressive rendering

This is the product's core claim. If these pass, the thing works; if they pass but feel
wrong, the assertions are measuring the wrong moment.

| ID | Case | Passes when |
|---|---|---|
| C1 | Preview document `compatMode` | `"CSS1Compat"` — **not** quirks mode |
| C2 | Fake stalls after the shell (P2) | Layout is fully painted; `.anyapp-skeleton` count equals the slot count; no slot content yet |
| C3 | Time from navigation to first painted layout (P2) | Under the Phase 2 budget — assert against a fixed fake planner latency, not a wall-clock guess |
| C4 | Slots released one at a time (P2) | Skeleton count decreases by one per release, never all at once |
| C5 | After the last slot (P2) | Zero `.anyapp-skeleton` elements remain |
| C6 | Phase 1 linear path | Content is visible before the response completes — the response is still open when text is on screen |
| C7 | Trailing markdown fence in the model output | Never visible on screen at any point |
| C8 | Skeleton height vs. filled height (P2) | A fixed element below the slots moves less than a set threshold — the no-layout-jump claim |

C6 is the one case that must not regress from Phase 1, and it is easy to lose: any change
that buffers the response still renders correctly at the end. Assert that text is on screen
*while the response is open*, not that it eventually appears.

C8 is a soft assertion — measure the position of a footer before and after fill and allow a
generous threshold. It catches a planner that has stopped estimating heights entirely, which
is the realistic failure, not small inaccuracies.

---

## D. The `swap()` runtime (P2)

Unit-testable in a browser without any generation: serve a fixed HTML page containing the
runtime, a slot, and a template, then call `swap()` directly. Fast, deterministic, and
covers the fiddliest code in the phase.

| ID | Case | Passes when |
|---|---|---|
| D1 | `swap("x")` with a matching template | Template content lands inside `#slot-x`; the template element is removed |
| D2 | After swap | `anyapp-skeleton` class removed and inline `min-height` cleared |
| D3 | Slot content containing `<script>` | **The script executes** |
| D4 | Slot script with a `src` attribute | Attributes copied onto the re-created element; the external script loads |
| D5 | `slot:ready` event | Fires once per swap with the correct `detail.id` |
| D6 | Two slots swapped in **reverse** document order | Both land in the right place |
| D7 | `swap("nope")` — no such template or slot | No-op, no exception |
| D8 | `swap("x")` called twice | Second call is a no-op; content is not duplicated |
| D9 | Shell script vs. slot script ordering | The shell script has already run when a slot script executes |

D3 is the single most important case in this document. A `<script>` moved out of a
`<template>` by DOM insertion **never executes** — that is standard HTML behaviour, and the
re-creation loop in `SWAP_RUNTIME` exists solely to defeat it. If that loop is ever
"simplified", every interactive generated app becomes dead markup, and it looks exactly like
a model-quality problem rather than a bug.

D6 is forward-compatibility for Phase 4. Slots arrive in completion order once fill fans
out, and the format is supposed to already support that. Locking it in now means Phase 4 is
an orchestration change, as planned, rather than a format change.

---

## E. Error and edge states

| ID | Case | Passes when |
|---|---|---|
| E1 | Generation fails mid-stream | Red error banner is visible inside the frame |
| E2 | Failure after the shell was written (P2) | Banner appears *below* the already-rendered layout; the shell is not discarded |
| E3 | Concurrent duplicate request | "Already generating…" page renders and carries a meta refresh |
| E4 | That page after the first generation finishes | The refresh eventually shows the finished app |
| E5 | Replay of a completed app | Renders fully, with no skeletons at any point |
| E6 | Replay vs. streamed render | Final DOM is equivalent — a screenshot comparison after both settle |
| E7 | Unknown generation id | Frame shows "Preview unavailable", studio does not error |
| E8 | Viewer closes the tab mid-generation | No browser console errors; the studio stays responsive |

E6 catches a real class of bug: the streamed path and the assembled-document path build the
same page by different code paths (`renderSkeletons` + swaps vs. `renderFilled`). They can
drift without either one looking broken on its own.

---

## F. Generated-app quality

Rendered-behaviour checks against a **real** provider, on a nightly or on-demand job — never
in CI. These are the automated version of "does the model produce apps worth keeping", which
`overview.md` names as the project's first real risk.

Run each over a fixed set of ~10 prompts and track a **pass rate over time**, not a
pass/fail. A single failure means the model had a bad run; a falling rate means something
regressed in a prompt.

| ID | Case | Passes when |
|---|---|---|
| F1 | Console during load and 5s of idle | No errors |
| F2 | Viewport at 375px wide | No horizontal scroll on `<body>` |
| F3 | Viewport at 1440px | No content overflowing its container |
| F4 | Every button and link | Clickable, no error thrown on click |
| F5 | Rendered text | No "lorem ipsum" |
| F6 | Slot content (P2) | No visible raw HTML or stray markers on screen |
| F7 | Contrast of body text against its background | Meets a minimum ratio |
| F8 | Interactive apps (a counter, a timer, a form) | State visibly changes on interaction |
| F9 | Full page screenshot | Reviewed by a human on failure — some quality regressions have no assertion |

F2 is worth having early. "Responsive and legible on a phone" is in the system prompt, and
horizontal overflow is both the most common way that fails and trivially detectable.

---

## G. Provider settings and BYOK (P3.5)

| ID | Case | Passes when |
|---|---|---|
| G1 | Save a provider credential | Accepted, and the app can generate with it |
| G2 | After saving | The field shows a mask only and never repopulates with the key — including after a reload |
| G3 | Save an invalid key | Rejected immediately with a readable message, not a raw provider error dump |
| G4 | Page source and DOM after saving | Contain no substring of the credential |
| G5 | Per-role model selectors | Persist, and are reflected after a reload |
| G6 | Generate with no credential configured | A clear prompt to add one — not a provider stack trace |
| G7 | Generation fails with a provider 401 | The error banner shows scrubbed text with no credential substring |
| G8 | Delete a credential | UI updates immediately; a later generation falls back or fails cleanly |
| G9 | The same prompt through each configured provider | Both produce a rendering app — the provider choice is not visible in the result |

G4 and G7 are the browser-side halves of backend cases H4/H5. A credential can leak into a
page as easily as into a database column, and the error banner is the likeliest route —
it renders provider text straight into the frame.

---

## Suggested order

1. **D1–D9.** No generation needed, fast, deterministic, and they cover the phase's
   trickiest code. D3 first.
2. **B1–B6.** Cheap, and they guard the architecture's central claim. B2 in particular is
   one attribute away from silently disappearing.
3. **C1, C6.** The two invariants that must never regress: not-quirks-mode, and content
   visible while the response is still open.
4. **A1–A9.** Ordinary UI coverage.
5. **C2–C5, C7, C8, E1–E8.** Once Phase 2 has settled.
6. **G4, G7** with Phase 3.5, alongside their backend counterparts H4/H5 — leak checks are
   worth having before the thing that can leak exists. The rest of **G** as the settings UI
   is built.
7. **F.** Last, on a schedule, tracked as a rate.
