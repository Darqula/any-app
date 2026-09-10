import type { Generation, Visibility } from "@any-app/store";
import type { CredentialHint, Owner } from "@any-app/store";
import type { Role, ProviderId } from "@any-app/generator";
import type { TokenMode } from "@any-app/protocol";
import type { RoleProblem } from "./credential-resolve";

/**
 * htmx 2.0.4's shipped default `responseHandling` is
 * `[{code:"204",swap:false},{code:"[23]..",swap:true},{code:"[45]..",swap:false,error:true}]`
 * — read straight out of the served `htmx.min.js`. That `swap:false` on `[45]..` means a
 * 4xx/5xx body is **never** swapped into its target, and this app returns its user-facing
 * error HTML exactly that way throughout: settings.ts's invalid-key path (400) and edits.ts's
 * failure paths (400/404/409/500/502/503) all render `editProblem()` with an error status.
 * Every one of them was silently discarded — `#cred-result`/`#edit-result` simply stayed as
 * they were, so a failed edit or a rejected credential looked like nothing had happened at
 * all (testing-review.md S11). The scrubbing worked and then the scrubbed message was thrown
 * away.
 *
 * Fixed here rather than by returning these problems with a 200: the status codes are real
 * contracts, asserted directly by the backend suite, and "200 OK" for a rejected credential
 * would be a worse API to make a UI bug go away. `error:true` is kept so htmx still fires its
 * own error events and console logging; only `swap` changes.
 *
 * A `<meta>` rather than an inline script on purpose — htmx reads this at load time, so there
 * is no ordering dependency on a separate script block, and S10 is a fresh reminder that an
 * inline block in a template literal is the more fragile of the two.
 */
const HTMX_CONFIG_META =
  `<meta name="htmx-config" content='{"responseHandling":[{"code":"204","swap":false},{"code":"[23]..","swap":true},{"code":"[45]..","swap":true,"error":true}]}'>`;

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/**
 * `grant` is the Phase 6 view grant (view-grant.ts) — a bearer capability to view THIS app
 * until it expires, minted by the caller (index.ts, which knows the viewer) and forwarded
 * blind by the sandbox all the way to studio's internal route. See architecture.md decision
 * #10.
 */
export function previewFrame(id: string, appOrigin: string, grant: string): string {
  // allow-same-origin is now correct, where before it was forbidden. `appOrigin` is this
  // app's own subdomain (<app-id>.apps.localhost:3001, see index.ts's appOrigin()) — the
  // frame becomes same-origin with itself, not with the studio (localhost:3000, still
  // cross-origin) and not with any other generated app (a different subdomain, so still
  // cross-origin to this one too). That per-app split is what makes allow-same-origin safe
  // to add now (locked decision #8) — adding it on a shared origin would let every app read
  // every other app's storage.
  return `<iframe
    class="preview"
    src="${escapeHtml(appOrigin)}/preview/${escapeHtml(id)}?g=${encodeURIComponent(grant)}"
    sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
    title="Generated app preview"></iframe>`;
}

const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: "Private",
  unlisted: "Unlisted (anyone with the link)",
  public: "Public",
};

/**
 * Shown only to the app's owner (see index.ts's frame route) — changing visibility and
 * remixing someone else's app are different actions with different audiences. `shareUrl` is
 * the plain studio frame link; there is deliberately no separate "public gallery" link,
 * because a browsable index of everyone's public apps is out of scope (see
 * impl-phase-6.md's "Deliberately deferred").
 */
export function ownerControls(id: string, visibility: Visibility, shareUrl: string): string {
  const options = (Object.keys(VISIBILITY_LABELS) as Visibility[])
    .map(
      (v) =>
        `<option value="${v}"${v === visibility ? " selected" : ""}>${escapeHtml(VISIBILITY_LABELS[v])}</option>`,
    )
    .join("");
  return `<form id="visibility-form" hx-post="/generations/${escapeHtml(id)}/visibility"
    hx-target="#visibility-result" hx-swap="innerHTML">
    <label>Visibility
      <select name="visibility">${options}</select>
    </label>
    <button>Update</button>
  </form>
  <div id="visibility-result"></div>
  ${visibility !== "private" ? `<p class="hint">Link: <code>${escapeHtml(shareUrl)}</code></p>` : ""}`;
}

/** Shown to any viewer of a shared (unlisted/public) app who is not its owner. `hx-target`
 * names an element ("#stage") that does not exist on `sharedAppPage` below — harmless: with
 * `hx-swap="none"` htmx never writes into it, and this control's only real effect is the
 * response's `HX-Redirect` header, which htmx follows regardless of target/swap. Kept as one
 * function so the frame-route fragment and the standalone share page render it identically. */
export function remixControl(id: string): string {
  return `<form hx-post="/generations/${escapeHtml(id)}/fork" hx-target="#stage" hx-swap="none">
    <button>Remix this app</button>
  </form>
  <p class="hint">Remixing copies the app, not its data — your copy starts empty.</p>`;
}

/**
 * `GET /apps/:id` — the page a shared link actually opens. The frame
 * route's own response (`previewFrame(...) + editFormHtml + ownerHtml`) is a bare htmx
 * fragment: no doctype, no stylesheet, no htmx `<script>`. Opened directly it has no sizing
 * for `.preview` (falls back to the ~300x150 replaced-element default) and "Remix this app"
 * is a `<button>` in a `<form>` with no real submission path — with no htmx loaded, clicking
 * it just re-GETs the current URL. This is a real, standalone page instead: same iframe,
 * same remix control, its own head.
 */
export function sharedAppPage(id: string, title: string, appOrigin: string, grant: string, mode: TokenMode): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
${HTMX_CONFIG_META}
<script src="https://cdnjs.cloudflare.com/ajax/libs/htmx/2.0.4/htmx.min.js"></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; display: flex; flex-direction: column; }
  header { padding: 10px 16px; border-bottom: 1px solid #8883; display: flex;
           justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  header a { color: inherit; font-weight: 600; text-decoration: none; }
  .preview-wrap { flex: 1; min-height: 400px; }
  .preview { width: 100%; height: 100%; border: 0; display: block; }
  form { margin: 0; }
  button { font: inherit; padding: 6px 12px; cursor: pointer; }
  .hint { font-size: 12px; opacity: .6; margin: 0; }
</style>
</head>
<body>
  <header>
    <a href="/">any-app</a>
    ${mode === "ro" ? remixControl(id) : `<span class="hint">This is your app — open it from your sidebar to edit it.</span>`}
  </header>
  <div class="preview-wrap">${previewFrame(id, appOrigin, grant)}</div>
</body>
</html>`;
}

export function notFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Not found</title></head>
<body style="font:15px system-ui;padding:24px"><p>Not found.</p></body>
</html>`;
}

export function editForm(id: string, slots: { id: string }[]): string {
  const options = slots
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.id)}</option>`)
    .join("");
  return `<form id="edit-form"
    hx-post="/generations/${escapeHtml(id)}/edits"
    hx-target="#edit-result"
    hx-swap="innerHTML"
    hx-disabled-elt="find button, find input, find select"
    hx-on::before-request="anyappBeforeEdit(event)">
    <input name="instruction" placeholder="Describe a change…" required>
    <select name="target" title="Which part to change">
      <option value="">Decide for me</option>
      <option value="css">Styling</option>
      ${options}
    </select>
    <button type="submit">Apply</button>
  </form>
  <div id="edit-result"></div>`;
}

/**
 * Embeds a value as a `<script type="application/json">` block. Attributes and inline JS
 * both need escaping that JSON does not survive cleanly (quotes, ampersands), so the payload
 * travels as a JSON block instead and is parsed on the other side. `<` is still escaped so
 * the payload cannot prematurely close the block with a literal `</script`.
 */
function jsonBlock(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function editApplied(
  id: string,
  appOrigin: string,
  target: { kind: "css" } | { kind: "slot"; id: string },
  next: { css: string; content: Record<string, string> },
): string {
  // `generationId` lets the bridge (anyappApplyEdit) refuse to post into whatever happens to
  // be in #stage when the response lands — see its own comment for why that can be a
  // different app than the one the edit was submitted against. `appOrigin` is what lets that
  // same bridge pin postMessage's targetOrigin instead of using "*" — see anyappApplyEdit.
  const payload =
    target.kind === "css"
      ? { channel: "anyapp", type: "css", css: next.css, generationId: id, appOrigin }
      : {
          channel: "anyapp",
          type: "slot-content",
          id: target.id,
          html: next.content[target.id],
          generationId: id,
          appOrigin,
        };

  const label = target.kind === "css" ? "styling" : target.id;

  return `<script type="application/json" id="edit-payload">${jsonBlock(payload)}</script>
<script>anyappApplyEdit()</script>
<p class="edit-ok">Updated ${escapeHtml(label)}.</p>`;
}

export function editProblem(message: string): string {
  return `<p class="edit-problem">${escapeHtml(message)}</p>`;
}

/** One row per saved credential — provider, a masked hint, and when it was last validated.
 * The key itself never appears here; `listCredentialHints` never reads it back either. */
export function credentialList(hints: CredentialHint[]): string {
  if (hints.length === 0) {
    return `<p class="empty">No credentials saved. The platform key from .env is used until you add one.</p>`;
  }
  return `<ul class="cred-list">${hints
    .map(
      (h) => `<li>
        <code>${escapeHtml(h.provider)}</code>
        <span>····${escapeHtml(h.hint)}</span>
        <span class="cred-validated">${h.validatedAt ? `validated ${h.validatedAt.toISOString().slice(0, 10)}` : "not validated"}</span>
        <button hx-delete="/settings/credentials/${escapeHtml(h.provider)}"
                hx-target="closest li" hx-swap="outerHTML"
                hx-confirm="Remove this credential?">Remove</button>
      </li>`,
    )
    .join("")}</ul>`;
}

export function credentialForm(): string {
  return `<form id="cred-form"
    hx-post="/settings/credentials"
    hx-target="#cred-result"
    hx-swap="innerHTML"
    hx-disabled-elt="find button, find input, find select">
    <label>Provider
      <select name="provider" required>
        <option value="openai">OpenAI-compatible</option>
        <option value="anthropic">Anthropic</option>
      </select>
    </label>
    <label>API key <input name="apiKey" type="password" autocomplete="off" required></label>
    <label>Base URL (optional) <input name="baseUrl" placeholder="leave blank for the provider's default"></label>
    <label>Model to validate with <input name="model" placeholder="e.g. gpt-4o or claude-opus-5" required></label>
    <button type="submit">Save</button>
  </form>
  <div id="cred-result"></div>`;
}

export function credentialSaved(provider: string): string {
  return `<p class="edit-ok">Saved and validated ${escapeHtml(provider)}.</p>`;
}

const ROLE_LABELS: Record<Role, string> = {
  planner: "Planner",
  fill: "Fill",
  edit: "Edit",
  router: "Router",
};

/** Read-only view of the current per-role config — env-driven (LLM_*), not yet editable
 * from this page. A per-role override UI needs its own storage beyond the credentials
 * table this phase adds, so it is deliberately deferred rather than half-built. */
export function roleConfigTable(
  rows: { role: Role; provider: ProviderId; model: string; maxTokens: number }[],
): string {
  return `<table class="role-table">
    <thead><tr><th>Role</th><th>Provider</th><th>Model</th><th>Max tokens</th></tr></thead>
    <tbody>${rows
      .map(
        (r) => `<tr>
          <td>${ROLE_LABELS[r.role]}</td>
          <td>${escapeHtml(r.provider)}</td>
          <td>${escapeHtml(r.model)}</td>
          <td>${r.maxTokens}</td>
        </tr>`,
      )
      .join("")}</tbody>
  </table>
  <p class="hint">Set via <code>LLM_MODEL</code> / <code>LLM_&lt;ROLE&gt;_MODEL</code> etc. in <code>.env</code>.</p>`;
}

/** Sign-in/sign-up forms for an anonymous visitor, or an account summary + sign-out for a
 * signed-in one. Deliberately no password-reset link — see impl-phase-6.md's "Deliberately
 * deferred" (no email infrastructure exists to send one). */
// Every button below deliberately has NO explicit `type="submit"` attribute — a bare
// `<button>` inside a `<form>` submits by default, so behavior is unchanged, but the CSS
// attribute selector `button[type="submit"]` (which the pre-Phase-6 frontend suite already
// uses, page-wide, to find the ONE original prompt-generate button) then does not also match
// these new buttons. Confirmed live: with an explicit attribute, `page.click('button[type=
// "submit"]')` resolved to 3 elements on the home page alone and every case using it timed
// out waiting for whichever one it guessed wasn't visible.
export function authForms(owner: Owner): string {
  if (owner.kind === "user") {
    return `<form hx-post="/signout" hx-target="body" hx-swap="none">
      <button>Sign out</button>
    </form>`;
  }
  return `<details class="auth">
    <summary>Sign in / sign up</summary>
    <form hx-post="/signup" hx-target="#auth-result" hx-swap="innerHTML">
      <label>Email <input name="email" type="email" required></label>
      <label>Password (8+ characters) <input name="password" type="password" minlength="8" required></label>
      <button>Sign up</button>
    </form>
    <form hx-post="/signin" hx-target="#auth-result" hx-swap="innerHTML">
      <label>Email <input name="email" type="email" required></label>
      <label>Password <input name="password" type="password" required></label>
      <button>Sign in</button>
    </form>
    <div id="auth-result"></div>
    <p class="hint">Anonymous work is kept while you browse and claimed automatically if you sign up.
      Signing in to an existing account instead leaves any apps you made in this browser
      behind — they are not moved into the account.</p>
  </details>`;
}

export function settingsPage(
  hints: CredentialHint[],
  roleRows: { role: Role; provider: ProviderId; model: string; maxTokens: number }[],
  owner: Owner,
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>any-app settings</title>
${HTMX_CONFIG_META}
<script src="https://cdnjs.cloudflare.com/ajax/libs/htmx/2.0.4/htmx.min.js"></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; padding: 24px; max-width: 640px; }
  a { color: inherit; }
  section { margin-bottom: 32px; }
  h2 { font-size: 16px; }
  form { display: grid; gap: 10px; max-width: 420px; }
  label { display: grid; gap: 4px; font-size: 13px; opacity: .85; }
  input, select, button { font: inherit; padding: 6px 8px; }
  button { cursor: pointer; width: fit-content; }
  .cred-list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
  .cred-list li { display: flex; gap: 10px; align-items: center; }
  .cred-validated { opacity: .6; font-size: 12px; }
  .role-table { border-collapse: collapse; font-size: 13px; }
  .role-table th, .role-table td { text-align: left; padding: 4px 12px 4px 0; }
  .hint { font-size: 12px; opacity: .6; }
  .edit-ok { color: #0a7d2c; }
  .edit-problem, .problem { color: #b00020; margin: 4px 0; }
  .empty { opacity: .6; }
  .auth form { margin: 8px 0; }
  .auth summary { cursor: pointer; }
</style>
</head>
<body>
  <p><a href="/">&larr; back</a></p>
  <h1>Settings</h1>

  <section>
    <h2>Account</h2>
    ${authForms(owner)}
  </section>

  <section>
    <h2>Provider credentials</h2>
    <p class="hint">${owner.kind === "user"
      ? "Tied to your account — available on any device you sign in on."
      : "Session-scoped — cleared if you clear cookies, and claimed automatically if you sign up."}
      Used in preference to the platform key in <code>.env</code> for whichever role is
      configured to use that provider.</p>
    ${credentialList(hints)}
    ${credentialForm()}
  </section>

  <section>
    <h2>Per-role configuration</h2>
    ${roleConfigTable(roleRows)}
  </section>
</body>
</html>`;
}

/** Shown at the top of the home page when a generation would fail right now — for lack of a
 * credential, or because a role has no model configured at all — so the gap surfaces before
 * someone spends a wait on a failed generation. */
export function missingCredentialBanner(missing: RoleProblem[]): string {
  if (missing.length === 0) return "";
  const parts = missing.map((m) => m.message).join(", ");
  return `<p class="cred-banner">${escapeHtml(parts)}. <a href="/settings">Add a credential</a> or check the matching <code>LLM_*</code> vars in <code>.env</code>.</p>`;
}

export function generationList(generations: Generation[]): string {
  if (generations.length === 0) {
    return `<p class="empty">No apps yet. Describe one above.</p>`;
  }
  return generations
    .map(
      (g) => `<li>
        <button hx-get="/generations/${g.id}/frame"
                hx-target="#stage"
                hx-swap="innerHTML">${escapeHtml(g.prompt.slice(0, 80))}</button>
        <span class="status status-${g.status}">${g.status}</span>
      </li>`,
    )
    .join("");
}

// `owner` is required, not optional — this function has exactly
// one caller (index.ts's `GET /`), which always has one by the time it renders the page; an
// optional third parameter here means a future caller that forgets it drops the entire auth
// UI silently instead of failing to compile.
export function homePage(generations: Generation[], missing: RoleProblem[], owner: Owner): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>any-app studio</title>
${HTMX_CONFIG_META}
<script src="https://cdnjs.cloudflare.com/ajax/libs/htmx/2.0.4/htmx.min.js"></script>
<style>
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body { margin: 0; font: 15px/1.5 system-ui, sans-serif; display: grid;
         grid-template-columns: 320px 1fr; height: 100vh; }
  .cred-banner { grid-column: 1 / -1; margin: 0; padding: 8px 16px; background: #fff3cd;
                 color: #664d03; font-size: 13px; }
  aside { border-right: 1px solid #8883; padding: 16px; overflow-y: auto; }
  main { display: flex; flex-direction: column; }
  form { display: flex; gap: 8px; padding: 16px; border-bottom: 1px solid #8883; }
  textarea { flex: 1; min-height: 64px; font: inherit; padding: 8px; resize: vertical; }
  button { font: inherit; padding: 8px 14px; cursor: pointer; }
  #stage { flex: 1; display: flex; flex-direction: column; min-height: 0; }
  .preview { flex: 1; border: 0; width: 100%; height: 100%; background: #fff; }
  .placeholder { margin: auto; opacity: .6; }
  ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
  li { display: grid; gap: 2px; }
  li button { text-align: left; width: 100%; }
  .status { font-size: 12px; opacity: .7; }
  .status-failed { color: #b00020; }
  .empty { opacity: .6; }
  #edit-form { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid #8883; }
  #edit-form input { flex: 1; font: inherit; padding: 6px 8px; }
  #edit-form select, #edit-form button { font: inherit; padding: 6px 8px; }
  #edit-result { padding: 0 16px 12px; font-size: 13px; }
  .edit-ok { color: #0a7d2c; margin: 0; }
  .edit-problem, .problem { color: #b00020; margin: 0; }
  .auth form { margin: 8px 0; display: flex; flex-direction: column; gap: 4px; }
  .auth summary { cursor: pointer; margin: 8px 0; }
  .hint { font-size: 12px; opacity: .6; }
</style>
</head>
<body>
  ${missingCredentialBanner(missing)}
  <aside>
    <h1>any-app</h1>
    <p><a href="/settings">Settings</a></p>
    ${authForms(owner)}
    <ul id="generation-list">${generationList(generations)}</ul>
  </aside>
  <main>
    <form hx-post="/generations" hx-target="#stage" hx-swap="innerHTML">
      <textarea name="prompt" placeholder="Describe the app you want…" required></textarea>
      <button type="submit">Generate</button>
    </form>
    <div id="stage"><p class="placeholder">Your app will appear here.</p></div>
  </main>
  <script>
    // Returns the stage's iframe, but only if it is still showing the app named by
    // generationId. An edit's model call takes seconds — long enough for the user to click
    // a different app in the sidebar before the response lands. Without this check the
    // payload would go to whatever is in #stage *now*, not what was there when the edit was
    // submitted; since slot ids repeat across apps, that can make an unrelated app visibly
    // (if transiently) take on this one's content, which looks exactly like data corruption
    // to whoever sees it happen.
    function anyappFrameFor(generationId) {
      var frame = document.querySelector("#stage iframe");
      if (!frame || !generationId || frame.src.indexOf(generationId) === -1) return null;
      return frame;
    }

    // Pushes an applied edit into the live preview frame. The response fragment (see
    // editApplied) carries the payload as a JSON block and calls this after swapping it in.
    // Each generated app now has its own origin (locked decision #8), so the payload can
    // name an exact targetOrigin instead of "*" — "*" would deliver the message no matter
    // what document is in the frame, including one it navigated itself to. The receiving
    // side still independently checks event.origin against the studio origin baked into
    // swapRuntime; this is the sending side's half of the same discipline.
    function anyappApplyEdit() {
      var block = document.getElementById("edit-payload");
      if (!block) return;
      var payload = JSON.parse(block.textContent);
      var frame = anyappFrameFor(payload.generationId);
      if (!frame) return;
      frame.contentWindow.postMessage(payload, payload.appOrigin);
    }

    // Freezes the target region into a skeleton the instant an explicit slot edit is
    // submitted, so the wait has visible feedback instead of the page looking unchanged
    // until the whole response comes back. Only meaningful for an explicit slot choice —
    // an auto-routed edit does not know its target until the response arrives.
    function anyappBeforeEdit(event) {
      var form = event.target;
      var target = form.elements["target"].value;
      if (!target || target === "css") return;
      // Built with the RegExp constructor, not a regex literal, on purpose: this whole
      // script is the body of a TEMPLATE LITERAL, where \\/ is not a recognised escape, so a
      // literal /\\/generations\\/.../ silently loses its backslashes on the way out and the
      // served line becomes a // comment — which killed the parse of this entire block, and
      // with it all three helpers here, on every homepage load (testing-review.md S10).
      // A constructor string needs no backslash at all, so it cannot regress the same way.
      var match = new RegExp("/generations/([^/]+)/edits").exec(form.getAttribute("hx-post") || "");
      var frame = match && anyappFrameFor(match[1]);
      if (!frame) return;
      // No JSON block to read appOrigin off of yet (the response hasn't come back) — the
      // frame's own src carries the same origin, so read it back off that instead.
      frame.contentWindow.postMessage(
        { channel: "anyapp", type: "slot-pending", id: target },
        new URL(frame.src).origin,
      );
    }
  </script>
</body>
</html>`;
}
