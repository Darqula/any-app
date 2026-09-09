# Test Cases — Frontend

**Status:** resynced against the Phase 5 code · 2026-08-31
**Scope:** the studio UI, the streamed preview document, the `swap()` runtime, and the
rendered behaviour of generated apps. Server-side behaviour is in
[`tests-backend.md`](./tests-backend.md).

**Nothing here has been implemented yet.** This document was written during Phase 2 and last
updated at Phase 3.5; this pass brings it back in line with the code.

Phase markers (**P2**, **P4**, **P5**) record *when a case became relevant*, not what is still
pending — every phase they refer to has landed.

> **Section B carried three assertions that are now backwards**, plus a premise in the Harness
> section below that the whole document rested on. All four described the pre-Phase-5 origin
> posture: apps on one shared origin, an opaque frame, no working `localStorage`. Phase 5
> inverted every one of them on purpose, under locked decision #8. Implemented as written,
> they would fail on correct code — and the cheapest way to make B2 green is to delete
> `allow-same-origin`, which quietly reverts the decision.
>
> They are corrected below, with the old assertion named in each case so nobody re-derives
> the original and assumes it was lost in an edit.

---

## Harness

**Playwright**, driving a real Chromium. There is no way around a real browser here: the
things worth testing are progressive HTML parsing, `<template>` semantics, script execution
timing, and cross-origin isolation. None of them exist in jsdom.

Run against the **same fake provider** the backend suite uses (see `tests-backend.md`), which
that suite owns and builds. It is what makes timing and ordering assertions possible — a fake
that emits slot two before slot one, or stalls for two seconds mid-document, is the only way
to test the behaviours that matter.

**But most of this document does not need it.** See "Seeding instead of generating" below;
the fixture is only genuinely required for the streaming cases. Say early what this suite
needs from its interface — explicit `await fake.emit(chunk)` chunk-driving, which no backend
case asks for — or it will be built without that and have to be reworked. Both servers must be running on their real origins, because several
cases assert on the boundary between them — the studio on `localhost:3000`, and generated
apps on **`<app-id>.apps.localhost:3001`** (Phase 5), not the shared `127.0.0.1:3001` this
document originally assumed.

Three Playwright specifics worth setting up once:

- Assertions about *intermediate* states (skeletons visible, some slots landed) need the
  fake to hold a chunk open. Drive it explicitly — `await fake.emit(chunk)` — rather than
  racing against real timing.
- **The preview iframe is still cross-origin from the studio page**, so
  `frame.contentDocument` is null and `frameLocator` / `page.frames()` are still the way in.
  The reason changed, though, and it matters for what you can assert: the frame is no longer
  on an *opaque* origin. It has a real one — its own subdomain — so it now has working
  storage, and `frame.evaluate` inside it sees a normal document rather than a
  permission-denied shell.
- Chromium resolves any `*.localhost` name to loopback with no hosts-file entry, so
  per-app origins work out of the box. If a future CI image does not, point
  `SANDBOX_APP_ORIGIN_TEMPLATE` at a wildcard resolver rather than collapsing apps back onto
  one origin to make tests pass — that would disable the isolation section B exists to check.

**This suite owns the real origins.** It cannot use ephemeral ports: `swapRuntime` bakes
`STUDIO_PUBLIC_URL` into every generated document and checks `event.origin` against it on
every `postMessage`, and the data API derives its host cross-check from
`SANDBOX_APP_ORIGIN_TEMPLATE`. Randomising ports breaks B1, B3, B6–B10 and the whole edit
channel. The backend suite runs on ephemeral ports so the two do not collide.

### Seeding instead of generating

**A completed app is just a database row** — `plan` JSONB plus `document`. `internal.ts`
returns a complete row's stored document *before* it claims the row and before it resolves
any credential, so a seeded `status=complete` row renders through the full stack with **no
provider configured at all**.

That removes the fake provider from most of this document. Working off canned rows:

- **B1–B10** — every security invariant. These need an app whose script attempts an access
  and writes the result somewhere observable; a `title` change is the simplest channel out of
  a frame, and a hand-written document is a more reliable way to get one than asking a model.
- **C1**, **E5**, **E7** — quirks mode, replay, unknown id.
- **H1–H4** — the data runtime's presence, persistence across a reload, cross-app isolation.

What genuinely needs the fixture is the *streaming* behaviour, which a stored document by
definition cannot exercise: **C2–C8**, **E1–E4**, **E6**, **E8**, and **H5** (which needs a
real edit round trip through the `edit` role).

Seeding is also better testing where it applies. A canned document is deterministic, states
its own preconditions, and cannot fail because a fake's script drifted — and for section B in
particular, the app under test is adversarial by design, which is not something to leave to a
generator.

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
| B1 | Preview iframe `src` (P5) | Host is `<app-id>.apps.localhost` — per app, and never the studio's own origin |
| B2 | Preview iframe `sandbox` attribute (P5) | Contains `allow-scripts` **and** `allow-same-origin` |
| B3 | Generated app reads `document.cookie` | Empty, even after a session cookie exists on `localhost:3000` |
| B4 | Generated app touches `window.parent.document` | Throws a cross-origin `SecurityError` |
| B5 | Generated app writes `localStorage`, second app reads it (P5) | The write **succeeds and persists**; the second app sees nothing — per-app origins, not per-app nothing |
| B6 | Generated app `fetch`es a studio endpoint | Blocked by CORS; response unreadable |
| B7 | App A `fetch`es `<B-id>.apps.localhost/preview/<B-id>` (P5) | Blocked by CORS — A cannot read B's document, and therefore cannot read B's token out of it |
| B8 | Preview URL opened **directly** in a tab (P5) | Renders on its own per-app origin; the same-origin read that B7 blocks is unavailable here too |
| B9 | App A `fetch`es its own `/data/...` from inside the frame (P5) | Succeeds — same-origin, no CORS header involved |
| B10 | Studio page `postMessage` to the frame (P5) | Sent with the app's exact origin as `targetOrigin`, never `"*"` |

B3 through B7 need the fake provider to return an app whose script attempts the access and
writes the result somewhere observable — a `title` change is the simplest channel out of a
frame.

**B2 and B5 are inverted from what this document said before.** B2 asserted that
`allow-same-origin` was *absent*; B5 asserted that `localStorage` *threw or was empty*. Both
were correct through Phase 4 and are wrong now: Phase 5 added the attribute deliberately,
because a same-origin `fetch("/data/...")` from inside the frame requires it, and it is only
safe because apps moved to per-app origins in the same change.

That pairing is the thing to test, not either half. `allow-same-origin` on a *shared* origin
is precisely the failure locked decision #8 exists to prevent, and each half looks reasonable
on its own — which is why B1 and B2 should fail as a unit if either regresses.

B5's new form is the sharper test anyway. "Storage throws" only proved the frame was
crippled; "A writes, A still sees it after a reload, B never sees it" proves the isolation
actually holds while the feature works.

**B7 replaces the old B7**, which pinned the shared-origin exposure so it would not be
forgotten before Phase 5. It was not forgotten — the exposure is closed, and B7 now asserts
the closure. The concrete attack it guards is the one that forced per-app origins:
`fetch("/preview/<other-id>").then(r => r.text())`, same-origin on a shared host, hands over
another app's data-API token straight out of its HTML.

B9 is the positive case that keeps B6 and B7 honest. Three CORS assertions that all say
"blocked" would also pass if `fetch` were broken entirely.

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
| D3 | Slot content containing `<script>`, both via initial `swap()` **and** a postMessage edit | **The script executes on both paths** |
| D4 | Slot script with a `src` attribute, both via initial `swap()` **and** a postMessage edit | The external script loads on both paths; only the postMessage path re-creates the element |
| D5 | `slot:ready` event | Fires once per swap with the correct `detail.id` |
| D6 | Two slots swapped in **reverse** document order | Both land in the right place |
| D7 | `swap("nope")` — no such template or slot | No-op, no exception |
| D8 | `swap("x")` called twice | Second call is a no-op; content is not duplicated |
| D9 | Shell script vs. slot script ordering | The shell script has already run when a slot script executes |
| D11 | A slot script's execution count, both via initial `swap()` **and** a postMessage edit | **Executes exactly once — not twice — on either path (S16)** |

D3 is the single most important case in this document — but only its postMessage sub-case
actually pins the reason the re-creation loop (`rerunScripts` in `SWAP_RUNTIME`) exists.
Measured directly (testing-review.md's S6): a `<script>` the *document* parser placed inside
a `<template>` — the shape `swap()` consumes on initial fill — has no "already started" flag
set, and executes on its own the moment its content is moved into the live document, loop or
not. It is specifically a `<script>` parsed via the *fragment*-parsing algorithm —
`element.innerHTML = ...`, which is how the postMessage edit path turns `msg.html` into a
template before handing it to the same `fill()` — that gets its "already started" flag set
at parse time and would never auto-execute without the loop. So `swap()` alone (D3's first
sub-case) would still pass with the loop deleted; only the postMessage sub-case is a real
regression guard. If the loop is ever "simplified" on the strength of the initial-fill case
alone, every *edited* interactive region goes dead, and it looks exactly like a
model-quality problem rather than a bug. D4 has the identical shape (an external `src`
script also loads without the loop via `swap()` alone) and needs the same two-sub-case
treatment to actually guard anything; it uses it now for that reason.

**D3/D4 proved execution happens, not how many times — that gap is S16.** Both facts above
are true at once: `swap()`'s fragment already runs its script on insertion, *and* (until
S16 was fixed) `fill()` called `rerunScripts` unconditionally on that same path regardless —
so every `swap()`-filled slot script ran twice, silently, and D3/D4 stayed green through it
because neither asserts a count. `fill()` now takes an explicit `needsRerun` argument: `false`
from `swap()` (insertion already ran it — calling `rerunScripts` too would be the second
execution), `true` from the postMessage handler (its fragment's scripts are marked "already
started" and need the recreate-to-reset-the-flag trick, same as before). One consequence for
D4: only the postMessage sub-case still re-creates the element now — `swap()`'s external
script is the original element, fetched/executed by the insertion itself, so D4's swap()
sub-case no longer demonstrates attribute-copying, only that the load still happens. D11 is
the regression guard for the count itself, next to D10 for the same reason D10 sits there —
S15 and S16 are both cases where this file's own tests proved the bug wasn't visible without
asserting the *right* property, not just *a* property.

D6 was written as forward-compatibility for Phase 4, and the bet paid off — Phase 4 was an
orchestration change with no format move, exactly as planned. It stays as a regression guard,
and it is now the *only* browser-side coverage of out-of-order landing, because
`LLM_FILL_MODE` defaults to `sequential`: an end-to-end generation no longer exercises it.
Drive `swap()` directly rather than through a generation.

**D10 (P5) — the data runtime.** Serve a page containing `dataRuntime(token)` and assert
`window.anyapp.data` exposes `create`/`list`/`get`/`update`/`remove`, that each sends
`Authorization: Bearer <token>`, and that a non-2xx response rejects with the server's `error`
string rather than resolving. The runtime is inlined into every data-backed app and is the
only HTTP code the model is allowed to rely on; a silent failure in it looks exactly like a
model-quality problem.

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
same page by different code paths (`renderSkeletons` + swaps vs. `renderDocument`). They can
drift without either one looking broken on its own.

**Assert equivalence, not byte-identity.** Through Phase 3 the two were byte-identical and a
backend check enforced it. Phase 4 deleted that check on purpose: slots stream in completion
order and `renderDocument` emits them in plan order, so the documents differ and `swap()` has
always been order-independent. A screenshot comparison after both settle is the right shape;
comparing markup is not.

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

## H. Generated-app data (P5)

Appended after G so every existing case id keeps its number. These are the browser-side half
of `tests-backend.md`'s section K — K proves the API enforces its rules, H proves a generated
app can actually use it.

| ID | Case | Passes when |
|---|---|---|
| H1 | App with a `DATA` section | Its document contains the data runtime and a token |
| H2 | App with no `DATA` section | Contains neither — a static app carries no credential it never uses |
| H3 | Create a record from inside the frame, then reload | The record is still there — the product claim of the whole phase |
| H4 | Two apps, same collection name | Each sees only its own rows |
| H5 | Data-backed app after a slot edit | Still reads its existing rows — the token survived re-rendering |
| H6 | Data call while the API returns 429 | The app shows something honest; no permanent spinner, no unhandled rejection |
| H7 | Console during a data-backed app's load | No errors |

H5 is the one that would be missed. Every edit re-renders the document through
`renderDocument`, so a token that was stored rather than derived would be silently dropped or
regenerated, and the app would keep working right up until its first edit. `mintAppToken` is
a pure function of the app id specifically to make that unrepresentable — H5 is what proves
the property end to end, from the browser, where a user would actually notice.

H6 exists because the failure mode is invisible server-side. The API correctly returns 429;
whether the *app* handles it is a prompt-quality question, and both fill prompts now carry a
rule about pending and failed states. This is where that rule is checked.

---

## Suggested order

Steps 1–4 need **no fake provider**, so this suite can start immediately and in parallel with
the backend one — it does not wait on the fixture, and by the time step 5 arrives the fixture
exists.

1. **D1–D11.** No generation, no servers, no database — a static page and Playwright. Fast,
   deterministic, and they cover the trickiest code in the project. **D3 first** — still the
   single most important case here.
2. **B1–B10**, on seeded rows. Cheap, and they guard the architecture's central claim. B1 and
   B2 should be written as a pair that fails together: per-app origin and `allow-same-origin`
   are only safe in combination, and either one alone looks perfectly reasonable.
3. **H1–H4**, on seeded rows. The Phase 5 product claim, minus the edit round trip.
4. **C1, E5, E7, A1–A9.** Ordinary UI coverage and the two seedable invariants.
5. **C6** and the rest of **C**, then **E1–E4, E6, E8, H5** — the streaming and edit cases.
   These are the ones that need the fixture. C6 is the invariant that must never regress:
   content visible while the response is still open.
6. **G.** G4 and G7 first within it, alongside backend H4/H5 — a credential can leak into a
   page as easily as into a database column, and the error banner is the likeliest route.
7. **F.** Last, on a schedule, tracked as a rate.

Step 7 originally said "with Phase 3.5, before the thing that can leak exists." Phase 3.5 has
shipped, so that timing is gone — but G4 and G7 keep their priority within G for the same
reason it was given.
