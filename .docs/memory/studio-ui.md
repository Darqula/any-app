# Studio UI: traps and design decisions

Background for the studio view layer. The UI follows `mockups/d-native`: sidebar (brand, app list, account footer),
stage card, one bottom composer that creates apps or edits the open one. Server-rendered HTML plus htmx 2.0.4.

## Where things live

- `apps/studio/src/views/`: one module per page or feature, each a set of pure functions that return `Html`: pages
  (`home`, `settings`, `shared-app`), the sidebar footer and auth dialog (`sidebar-footer`), and the htmx fragments
  grouped by feature (`app-list`, `conversation`, `edit`, `preview`, `notices`; `layout` holds the head tags and the
  out-of-band slot wrapper). `views/index.ts` is the public surface. Routes send views through `sendHtml`
  (`src/respond.ts`). A new fragment goes with its feature; one-line status messages go in `notices.ts`.
- `apps/studio/public/css/*.css`: tokens (`theme`), element defaults (`base`), shared components (`components`: buttons,
  fields, dialog, notices), then per-area sheets (`home`, `sidebar`, `workspace`, `auth`, `owner-controls`, `settings`,
  `shared`). `cssLinks()` always puts the first three first.
- `apps/studio/client/*.ts`: the browser code, bundled by `scripts/build.mjs` (esbuild) into `dist/js/home.js` and
  `auth.js` and loaded as `<script type="module">`. It was plain `.js` + JSDoc while the repo had no build step; the
  2026-10-11 decision to add one was made because the JSDoc was hard to maintain. `client/home.ts` is only the entry;
  each part of the home page is a module in `client/home/` (sidebar, chat, poller, stage, composer, edit, delete,
  preview) that registers its own htmx listeners and exposes functions, never shared variables. Source maps are written only by the default (dev/test)
  build; `build:prod` / `NODE_ENV=production` minifies and writes none. Every one-shot build (not `--watch`) wipes
  `dist/js` first, so no old file or map lingers; a one-shot build run while `npm run dev` is up therefore 404s the
  bundles for a moment. The studio refuses to boot with `NODE_ENV=production` if `dist/js` holds a map. A new page script
  is a new entry in `scripts/build.mjs` plus a `ScriptName` in `views/layout.ts`.
- The client is type-checked through `apps/studio/client/tsconfig.json` (strict; own config because it needs the DOM
  lib and must not see Node globals). Type declarations for globals (htmx) live in `apps/studio/types/`.
- Only `public/css` and `dist/js` are served: `express.static` is mounted per directory, so sources and anything else
  beside them are not reachable. The studio throws at boot if `dist/js/home.js` or `auth.js` is missing. C17 fails on any file in
  either directory that is not a linked `.css`/`.js` (or a source map).

## CSS conventions

Enforced by I12 (`architecture-guards.test.ts`); the rest is review.

- **Classes, never IDs, for styling.** An ID has a specificity a class can't beat without `!important`. Markup keeps its
  ids for scripts, htmx targets and tests, and carries a class for the look (`#stage` is also `.stage`).
- **No element selectors outside `base.css`.** Give the element a class. A rule scoped under its component's class is
  fine (`.card .hint`, `.owner-controls .hint`) and is the right tool for "this notice looks different in here".
- **No literal colours outside `theme.css`.** A value used in light and dark goes through a token.
- **Buttons: `.btn` plus at most one variant** (`--primary`, `--danger`) and optionally `--sm`. Geometry that belongs to
  one component (height, padding, radius) lives with that component and overrides `.btn`; `components.css` loads first.
  `.btn-bare` is the no-chrome reset for buttons that look like text.
- **Page state classes live on `<body>`** (`creating`, `streaming`, `chat-open`, set by `client/home/`) and are always written
  with the page class (`.page-home.creating ...`).
- Class names that tests or scripts rely on are fixed: `.status`, `.status-*`, `.app-row-open`, `.app-delete`, `.active`, `.chat-panel`,
  `.cred-banner`, `.cred-list`, `.role-table`, `.empty`, `.edit-problem`, `.side-foot`, `.user-chip` (with `.who`),
  `.user-menu`, `.auth-btn`, `.auth-submit`, `.auth-result`, `.account-menu`, `.preview-wait`. Rename them together with
  the test or script. A7.8 fails when a class in the markup has no rule in a stylesheet the page links.

Traps found while refactoring (each was caught by a pixel comparison, not by any test):

- **A button without a border is narrower in a `flex: 1` row**: `flex-basis: 0` still reserves padding and border, so a
  borderless primary beside a bordered secondary came out 2px narrower. `.auth-btn` keeps a 1px border in both variants.
- **A descendant rule covers markup you add later.** `.owner-controls .hint` truncates every hint in that row. Putting a
  `.owner-hint` class on the two hints that existed silently let a third one through, so the scoped rule is the safer form.
- **The old settings page leaked its bare rules into the auth dialog.** A global `.edit-problem, .problem` margin, a
  `button { border-radius }` on the dialog's link buttons and a global `.hint` margin reached the dialog there but not on
  the home page. Scoping them under `.card` removed the inconsistency: the dialog now looks the same on both pages. Also,
  a disabled primary button stays disabled-coloured on hover (the old settings `button[type=submit]:hover` outranked
  `button:disabled`).
- **No spacing or radius scale yet.** Paddings, gaps and radii are the values the mockup used (8, 9, 10, 12, 14, 16 ...).
  Snapping them to a scale changes pixels, so it is a separate, reviewed step rather than part of the restructuring.
- Nothing in the suite looks at styling. The refactor was verified by rendering every view with sample data (home in each
  state, settings, share page, not-found, both dialogs, toasts; light, dark and 390px wide) before and after and requiring
  zero differing pixels. Repeat that for any large CSS change.

## Escaping contract (`views/escape.ts`)

- Dynamic values reach HTML only by interpolation into the `html` tagged template, which escapes `& < > " '`. Markup that
  is already safe has its own nominal type, `Html` (a `#private` field makes it nominal; a structural brand such as
  `extends String` accepts any string, which was checked). `html` returns `Html`, so nested fragments need no wrapper.
- `raw()` is only for static literals and the JSON data block. Never pass it text derived from a user, a model or the
  database. A grep for `raw(` should find a handful of lines, so a new one stands out in review.
- Escaping covers element text and quoted attributes. Not `<script>`, `<style>`, unquoted attributes or URLs.
- **`res.send(html)` would JSON-encode the object**, so every route uses `sendHtml`. Routes build error lines with
  `problem()` / `placeholder()` / `editProblem()` / `editOk()`, not hand-written `<p>` strings.
- Guards: A7.3-A7.5 pin the contract, A7.6 renders every exported view with hostile text and fails on unescaped
  hostile markup or on markup that was escaped by mistake, A7.7 checks every full page for the htmx config meta.
  The first version of this layer shipped the share page with an escaped `<meta name="htmx-config">`, and nothing
  caught it. That is why A7.6/A7.7 exist; add every new exported view to the sweep in `escaping.test.ts`.

## Traps that are easy to hit again

- **htmx skips 4xx/5xx bodies by default** (`[45]..` has `swap:false` in 2.0.4). This app returns user-facing
  error HTML with real statuses (`settings` 400, `edits` 400/404/409/422/500/502/503), so all were discarded
  and failures looked like nothing had happened (S11; the scrubbing worked, then the message was thrown away).
  The `htmx-config` `<meta>` sets `swap:true` for them. It was fixed there rather than by returning 200: the
  status codes are contracts asserted by the backend suite. Every full page must carry that meta (A7.7).
- **A stylesheet or script that 404s breaks nothing the behavioural tests look at**, so C17 fetches every
  `/css/*` and `/js/*` link of the rendered pages from a real studio. `cssLinks` and `scriptTag` take literal unions,
  so a mistyped name fails to compile.
- **The delete cross uses `:has(:focus-visible)`, not `:focus-within`**: a mouse click on the row's name also
  satisfies `:focus-within`, which left the cross stuck open after the pointer left.
- **An edit's payload is data, not code.** `editApplied` ships a `<script type="application/json" id="edit-payload">`
  block; `client/home/edit.ts` applies it on the `htmx:afterSwap` of `#edit-result`, and freezes the target region on
  `htmx:beforeRequest`. No inline handler or inline script is left in the markup, which is what lets a strict CSP
  (`script-src 'self'`) work later (`production-readiness.md` S3; check htmx's `allowEval` and `includeIndicatorStyles` settings first).
- `homePage`'s `owner` is required (one caller): an optional parameter would let a future caller drop the whole
  auth UI silently. `email` is required for the same reason (null for an anonymous owner; `accountEmail` in
  `session.ts` looks it up).

## Design decisions

- **Account lives in the sidebar footer** (claude.ai style): anonymous owners get Sign in / Sign up buttons (plus a
  Settings icon, since anonymous users keep credentials there too); signed-in owners get an avatar + email chip
  opening a menu (Settings, Sign out). Both buttons open one `<dialog id="auth-dialog">` holding a sign-in and a
  sign-up pane, `data-mode` picks the visible one, each pane posts to its own route and has its own result div.
  The settings page reuses the dialog. Rejected: showing both email+password forms at once. The footer menu is
  a `<details>`, not the Popover API: it must open upward from a footer, and in the narrow layout the sidebar sits
  above the stage, where a fixed-position popover would land in the wrong place. The dialog is only rendered for
  anonymous owners. The sign-in/sign-up hints keep saying that sign-up claims anonymous apps and sign-in does not.
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
