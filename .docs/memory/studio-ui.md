# Studio UI: traps and design decisions

Background for `apps/studio/src/{views,theme}.ts`. The UI follows `mockups/d-native`: sidebar (brand,
account, app list), stage card, one bottom composer that creates apps or edits the open one. Server-rendered
HTML plus htmx 2.0.4 and a small inline script.

## Traps that are easy to hit again

- **The inline script is the body of a template literal.** `\/` is not a recognised escape there, so a regex
  literal like `/\/generations\/.../` loses its backslashes, the served line becomes a `//` comment, and the
  parse of the *entire block* dies (all three edit helpers, every homepage load; S10). Use `new RegExp("...")`
  or string methods, and no backticks or `${` in that script, including in its comments.
- **htmx skips 4xx/5xx bodies by default** (`[45]..` has `swap:false` in 2.0.4). This app returns user-facing
  error HTML with real statuses (`settings` 400, `edits` 400/404/409/422/500/502/503), so all were discarded
  and failures looked like nothing had happened (S11; the scrubbing worked, then the message was thrown away).
  The `htmx-config` `<meta>` sets `swap:true` for them. It was fixed there rather than by returning 200: the
  status codes are contracts asserted by the backend suite.
- **Button types are load-bearing for tests.** The frontend suite finds the create button with
  `button[type="submit"]`; explicit `type="submit"` on the auth buttons made it match 3 elements and every case
  using it timed out. The delete cross is an `<input type="button">` because the suite finds a row's open
  control as the only `button` in its `li`.
- **The delete cross uses `:has(:focus-visible)`, not `:focus-within`**: a mouse click on the row's name also
  satisfies `:focus-within`, which left the cross stuck open after the pointer left.
- `homePage`'s `owner` is required (one caller): an optional parameter would let a future caller drop the whole
  auth UI silently.

## Design decisions

- **Out-of-band composition.** The composer, owner controls and conversation log live outside `#stage` but
  belong to the app it shows; one response carries all of them via OOB swaps. An *empty* slot is meaningful: it
  is how a new (still streaming) app clears the previous app's edit form. `#chat-log` is replaced as a whole
  element (`hx-swap-oob="true"`) so `data-app` changes with it; an empty `data-app` hides the panel, and it is
  looked up fresh every time, never cached.
- **Live sidebar is polling, not push**: the studio has no long-lived connection to hang one on and a badge is
  never more than seconds late. A `listEpoch` counter drops a poll that started before a local change, and a
  refresh requested mid-flight is re-run instead of dropped. The highlight follows the stage iframe, so it
  survives re-renders. An edit leaves `status` at `complete`, so "updating" comes from the studio's in-memory
  flag (`editing.md`).
- **Prompt boxes clear on submit** (htmx has already read the value when `htmx:beforeRequest` fires) and the
  text is restored on failure unless the user typed something new; focus is handed back after success.
- **Delete uses an in-page `<dialog>`** via `htmx:confirm` (cancel the event, `issueRequest(true)` on Delete).
  200 or 404 removes the row; 409 ("still generating or updating") keeps it and shows the message as a toast.
- **Conversation panel**: collapsed strip or a `30vh` log; open state in `localStorage` (try/catch); the toast is
  hidden while open (the log says the same thing); polls `/generations/:id/messages?after=<last seq>`.
- **`allow-same-origin` on the preview iframe is safe only because each app has its own origin** (decision #8).
- A shell edit reloads the frame (`frame.src = frame.src`; `location.reload()` is blocked cross-origin).
- **Planning overlay** (2026-10-03): the planner is not streamed, so on a reasoning model the frame stayed blank for
  minutes with only the small "Generating…" pill to say why. The frame is cross-origin, so the page cannot look inside;
  the stream writes a live-only `first-content` postMessage (`firstContentSignal`, after the shell head, or before the
  first chunk of the linear fallback), and the frame's `load` is the fallback for errors and stored documents.
  Rejected: sending it from `swapRuntime` (it would ship in every stored document, and the linear fallback has no
  runtime), and drawing a placeholder inside the document before `<html>` (it would end up in the persisted page).
  Shown only for a `pending` row: a complete app's `load` can wait seconds on CDN assets, and an overlay saying
  "Planning" over a finished app is worse than none.
- Dark theme follows the OS (`prefers-color-scheme`), no toggle and no stored preference, so nothing can get out
  of sync; component rules use tokens, and the generated-app iframe is deliberately not themed.
- `sharedAppPage` exists because the frame route's fragment has no doctype/stylesheet/htmx; opened directly it is
  a tiny iframe with a dead "Remix" button.
- Not built on purpose: a public gallery link and a password-reset link (no email infrastructure), and an
  editable per-role config UI (needs its own storage).
