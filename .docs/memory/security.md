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


## Provider base URL guard (SSRF)

`POST /settings/credentials` took any `baseUrl` from any visitor, called it at once and reflected the SDK error text, so
the studio (the process with the provider keys and the privileged pool) could be aimed at loopback, the database port or
169.254.169.254, and parts of the reply read back. What stands now:

- **Scope.** Only user-supplied credentials are guarded: `build(credential, { userSupplied: true })`, set by the settings
  route and by `resolve()` when the user's credential (not the platform one) is chosen. A platform credential, with the
  operator's `OPENAI_BASE_URL` / `ANTHROPIC_BASE_URL`, is never guarded or restricted (the test harness points those at a
  fake on localhost). A user credential saved with no base URL is guarded too and goes to the provider's public API
  (`https://api.openai.com/v1`, `https://api.anthropic.com`) passed explicitly: both SDKs otherwise fall back to the
  operator's base URL from the environment, which sent the user's key to the operator's gateway (a key leak) and, once
  guarded, made every such key fail against a private or http gateway. For the same reason a user-supplied client passes
  `organization`/`project` (OpenAI) and `authToken` (Anthropic) as `null`, so the operator's `OPENAI_ORG_ID`,
  `OPENAI_PROJECT_ID` and `ANTHROPIC_AUTH_TOKEN` are never attached.
- **The boundary is the connection, not the URL.** The save-time check (`checkProviderBaseUrl`: https, no `user:pass@`,
  parseable) is usability only. The guard is a custom undici connector (`providers/net-guard.ts`) passed to the SDKs as
  `fetch`: it refuses an IP-literal host before connecting, resolves names through a lookup hook that refuses any
  non-public answer (so nothing is sent to an internal address), and finally judges `socket.remoteAddress` of the
  connection really made, which is what defeats DNS rebinding and any resolver quirk. **Redirects are refused outright**
  (`redirect: "error"`, overriding whatever the SDK passes): a provider API never needs one, and following a 30x would
  re-send the body and key (to `http://<public host>` too, which no address check objects to).
- **Why a lookup hook alone is not enough.** `net.connect` / `tls.connect` do not call `lookup` for an IP literal, and
  the WHATWG URL parser turns `2130706433`, `0x7f.1` and `127.1` into `127.0.0.1` before the connector sees the host.
  The literal check in the connector is what stops those; the peer check is the backstop for the rest.
- **Why undici as a dependency.** The SDKs take `fetch` and `fetchOptions`. Node's bundled undici (6.21 on Node 22.16)
  is not importable, and pairing a package `Agent` with the bundled `fetch` depends on the two versions agreeing, so
  `@any-app/generator` depends on `undici` and uses its own `fetch` with its own `Agent` (same defaults: five-minute
  header and body timeouts as before). Bad ports (1, 9, ...) are refused by fetch itself before the guard: use port 8443
  in tests that need a refused port.
- **Classifier.** IPv4 deny-list through `node:net` `BlockList`; IPv6 is an allow-list of 2000::/3 minus special ranges
  (6to4, Teredo, NAT64, documentation, discard). `::ffff:a.b.c.d` is judged as its IPv4. Anything unparseable is refused.
  A name with one public and one private answer is refused whole.
- **Escape hatch.** `ANYAPP_ALLOW_PRIVATE_PROVIDER_URLS=1` (exactly `1`) returns no guarded fetch and lifts the https
  requirement. The studio throws at boot if it is set with `NODE_ENV=production`, and also if the host of
  `STUDIO_PUBLIC_URL` is not loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`), because nothing guarantees
  `NODE_ENV` is set on a real deployment; whenever it is on, boot logs one loud warning (`escapeHatchProblem`). `startServers` sets it by default; the
  guard cases pass `""`. Policy is injectable (`NetPolicy`: `isAddressAllowed`, `resolve`, `requireHttps`) so tests need
  neither the hatch off globally nor real DNS.
- **No reflection.** The route answers with a fixed sentence per outcome (`describeValidationFailure`: blocked literal or
  scheme, 401/403, 404, "The provider answered with HTTP <status>." for any other status, and "Could not reach the
  provider" for failures with no status) and logs the scrubbed detail plus the refused address. The status is a number
  only, never the body. `validate()` uses a 15 s timeout (`validateTimeoutMs` shortens it for tests) and
  `maxRetries: 0`; generation calls keep the SDK defaults.
- **DNS oracle.** A hostname refused because it resolved to a non-public address (`BlockedAddressError.byName`) and a
  hostname that does not resolve give the same sentence ("Could not reach the provider"); otherwise an anonymous visitor
  could map which internal names exist. Only an IP literal or a scheme/credentials refusal says "not allowed", since
  those reveal nothing. What still shows for public hosts is the status class (401 vs 404 vs reached), which is
  unavoidable for a validation call; private targets are unreachable.
- **Not covered.** Outbound proxies are not supported (the Agent connects directly).

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
