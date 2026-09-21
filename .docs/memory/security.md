# Security model: grants, tokens, cookies, CSRF

Locked decisions are in `architecture.md`; this keeps the reasoning and the incidents behind the short
comments in `view-grant.ts`, `app-token.ts`, `session.ts` and `index.ts`.

## View grants

A bearer capability to view one app until it expires (minted by the studio, carried in the iframe URL,
forwarded blind by the sandbox, verified by the studio's internal route; decision #10).

- Not bound to a viewer identity (the verifier cannot see one). A leaked grant is read access to that app
  for its window, hence `Referrer-Policy: no-referrer` on the preview response.
- `mode` is carried because the internal stream route (no cookie) cannot re-derive ownership; the frame
  route can. A grant is four dot-separated fields (`appId.mode.expiresAtMs.mac`); one without `mode` fails
  to parse rather than being a smaller compatible token.
- `expired` is distinct from `invalid`. They once collapsed to `null`, so an owner's tab left open past the
  TTL silently answered read-only to its own writes on an unlisted/public app with nothing on screen saying
  why. (Private apps 404 either way, correctly: never confirm a private app exists.)
- TTL is 30 minutes, not 5: a generation on the default model can take six minutes and the "Already
  generating" page's two-second meta refresh re-requests the same URL with the same grant; a short TTL turns
  a slow generation into a mid-way 404 that looks like a grant bug.
- The `view:v1:` prefix stops a grant and an app token verifying as each other under the shared secret.

## App data tokens

- Derived (HMAC of app id + mode), not stored: the sandbox needs no table but `records`, no hot-path lookup,
  and re-rendering a document (every edit) reproduces the same token instead of minting or dropping one.
- `UUID_PATTERN` anchors hyphen positions. The Phase 5 review's first fix (S2, `[0-9a-f-]{36}`) let 36 hex
  digits without hyphens through, which reached Postgres as `22P02` instead of a clean 404 (residual R1).
- The `v1:` prefix is the rotation seam: changing it revokes every token, which is all of revocation for now.

## Cookies and sessions

- `SameSite=Lax`, not `Strict`: `Strict` is not sent on a cross-site top-level navigation, so opening a
  shared `/apps/:id` link from Slack would mint a fresh anonymous session whose `Set-Cookie` **replaces the
  recipient's real one** (silent sign-out). The CSRF `Strict` seemed to stop is same-site anyway
  (`<id>.apps.example.com` -> `example.com`); the guard below is what stops it.
- No `Domain` attribute: generated apps are subdomains of the studio host and must not receive the cookie.
- `signInAs` rotates the session id (reuse would be fixation). Rotation also orphans anonymous work when
  signing in to an existing account, which is why `claimAnonymousWork` runs only at sign-up.

## Cross-site request guard

Without it, a model-written script in any generated app on a same-site deployment could
`POST /settings/credentials` with `credentials:"include"`, replacing the viewer's key/base URL with an
attacker's endpoint, spending their cap, or publishing/forking their apps. It rejects only a **positive**
cross-site signal (`Sec-Fetch-Site` not `same-origin`/`none`, or `Origin` not the studio) and does not
require either header. That is deliberate: every evergreen browser attaches `Sec-Fetch-Site` and page JS
cannot suppress it, so a real browser attack can never present with both absent; only non-browser callers
(curl, this repo's tests) send neither, and they never held the victim's HttpOnly cookie. This is the one
place `Origin` may be read, and only against a known value. Cases: M12/M12b.


## Sharing exposes the data API

The app token identifies the app, not a person, and ships in the app's own HTML, so anyone who can open a
generated app's URL can read and write all its data; generated apps have no end users of their own (answering
that would change the `records` shape). That was tolerable while the URL was an unpublished uuid. Sharing
publishes it, hence read-only tokens for non-owners. `public` visibility must not exist without them, and a
browsable gallery must not exist before them.

## Why per-app origins came first

A frame under `sandbox="allow-scripts"` alone has an opaque origin, so its `fetch` sends `Origin: null`. The
data API cannot answer that with `Access-Control-Allow-Origin: null` (it matches any sandboxed frame on the
internet), so `allow-same-origin` is required, and that is only safe once every app has its own origin. On a
shared origin an app opened in a tab could also read another app's token out of its HTML.

## Two unrelated "sessions"

The **user session** is the browser's identity on the studio (`anyapp_session` cookie, a `sessions` row,
`apps/studio/src/session.ts`, `packages/store/src/sessions.ts`). The **gateway session** is
`x-opencode-session`, which groups one app's provider calls for prompt caching
(`packages/generator/src/providers/session.ts`, `conversationId` = the generation id). Never pass one where the
other is expected; a fork gets its own `conversationId` (its own id), never the source's.

## One `Set-Cookie` per response

`res.setHeader("Set-Cookie", ...)` replaces an earlier one. "Sign-in worked but the next request is anonymous"
means something wrote the cookie again in the same response, or the response that set it redirected.
