import type { Generation, Visibility } from "@any-app/store";
import type { CredentialHint, Owner } from "@any-app/store";
import type { Role, ProviderId } from "@any-app/generator";
import type { TokenMode } from "@any-app/protocol";
import type { RoleProblem } from "./credential-resolve";
import { THEME_CSS } from "./theme";

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

/**
 * The composer dock and the owner controls live OUTSIDE `#stage` (mockup D: one bottom bar,
 * one header row), but they belong to whichever app `#stage` is showing. htmx's out-of-band
 * swap lets a single response carry both: the main content replaces `#stage`'s children and
 * each slot below is swapped into its own element by id. An empty `html` is meaningful — it
 * clears the slot, which is how a freshly created (still streaming) app removes the previous
 * app's edit form instead of leaving it pointed at the wrong generation.
 */
export function oobSlot(id: "edit-slot" | "owner-slot", html: string): string {
  return `<div id="${id}" hx-swap-oob="innerHTML">${html}</div>`;
}

/** Owner-controls row (visibility form / remix form) — shared by the home page's header slot
 * and the standalone share page's header. */
const OWNER_CONTROLS_CSS = `
  .owner-controls { display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--muted); min-width: 0; }
  .owner-controls form { display: flex; align-items: center; gap: 8px; margin: 0; padding: 0; border: 0; }
  .owner-controls label { display: flex; align-items: center; gap: 8px; }
  .owner-controls select { font-size: 12px; padding: 4px 8px; border-radius: 8px; }
  .owner-controls button {
    border: 1px solid var(--border); background: var(--panel); color: var(--text);
    border-radius: 8px; padding: 4px 12px; font-size: 12px;
  }
  .owner-controls button:hover { background: var(--hover); }
  .owner-controls button.btn-accent { background: var(--accent); color: var(--accent-fg); border: 0; }
  .owner-controls button.btn-accent:hover { background: var(--accent-hover); }
  .owner-controls .hint { max-width: 280px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #visibility-result { display: contents; }
`;

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
    <button class="btn-accent">Remix this app</button>
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
<style>${THEME_CSS}${OWNER_CONTROLS_CSS}
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; }
  header { padding: 10px 18px; background: var(--panel); border-bottom: 1px solid var(--border);
           display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
  header .brand { text-decoration: none; }
  .preview-wrap { flex: 1; min-height: 400px; }
  .preview { width: 100%; height: 100%; border: 0; display: block; background: #fff; }
</style>
</head>
<body>
  <header>
    <a class="brand" href="/"><span class="brand-mark"></span>any-app</a>
    <div class="owner-controls">
      ${mode === "ro" ? remixControl(id) : `<span class="hint">This is your app — open it from your sidebar to edit it.</span>`}
    </div>
  </header>
  <div class="preview-wrap">${previewFrame(id, appOrigin, grant)}</div>
</body>
</html>`;
}

export function notFoundPage(): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title>
<style>${THEME_CSS} body { padding: 24px; }</style></head>
<body><p>Not found.</p></body>
</html>`;
}

export function editForm(id: string, slots: { id: string }[]): string {
  const options = slots
    .map((s) => `<option value="${escapeHtml(s.id)}">${escapeHtml(s.id)}</option>`)
    .join("");
  // `#edit-result` is deliberately NOT rendered here: the edit form arrives out-of-band into
  // the composer dock (see oobSlot) and `#edit-result` lives permanently in homePage next to
  // it — a second copy would duplicate the id.
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
  </form>`;
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
    return `<div class="auth-user">
      <span class="avatar"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="5.5" r="2.7" fill="currentColor"/><path d="M2.5 14c.4-2.9 2.7-4.4 5.5-4.4s5.1 1.5 5.5 4.4" fill="currentColor"/></svg></span>
      <span class="who">Signed in</span>
      <form hx-post="/signout" hx-target="body" hx-swap="none">
        <button>Sign out</button>
      </form>
    </div>`;
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

/** Account block (signed-in row, or the anonymous sign-in/sign-up `<details>`) — used by the
 * home sidebar and the settings page, so it is one stylesheet rather than two copies. */
const AUTH_CSS = `
  .auth-user { display: flex; align-items: center; gap: 10px; font-size: 13px; }
  .auth-user form { display: flex; margin: 0; padding: 0; max-width: none; }
  .auth-user .who { flex: 1; min-width: 0; color: var(--muted); }
  .auth-user button {
    width: auto; padding: 4px 10px; font-size: 12px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--panel); color: var(--muted);
  }
  .auth-user button:hover { background: var(--hover); color: var(--text); }
  .avatar {
    width: 28px; height: 28px; border-radius: 50%; flex: none;
    background: linear-gradient(135deg, #f59e0b, #ef4444); color: #fff;
    display: flex; align-items: center; justify-content: center;
  }
  details.auth summary { cursor: pointer; font-size: 13px; color: var(--muted); }
  details.auth summary:hover { color: var(--text); }
  details.auth form { display: flex; flex-direction: column; gap: 6px; margin: 10px 0; padding: 0; border: 0; }
  details.auth label { display: flex; flex-direction: column; gap: 3px; font-size: 12px; color: var(--muted); }
  details.auth input { padding: 6px 10px; font-size: 13px; }
  details.auth button {
    width: fit-content; padding: 5px 12px; font-size: 12px; border-radius: 8px;
    border: 1px solid var(--border); background: var(--panel); color: var(--text);
  }
  details.auth button:hover { background: var(--hover); }
`;

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
<style>${THEME_CSS}${AUTH_CSS}
  body { padding: 28px 24px 48px; max-width: 720px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 8px 0 20px; }
  section { margin-bottom: 20px; padding: 18px 20px; background: var(--panel);
            border: 1px solid var(--border); border-radius: 14px; }
  h2 { font-size: 15px; margin: 0 0 12px; }
  form { display: grid; gap: 10px; max-width: 420px; }
  label { display: grid; gap: 4px; font-size: 13px; color: var(--muted); }
  button { padding: 7px 14px; width: fit-content; border-radius: 10px;
           border: 1px solid var(--border); background: var(--panel); color: var(--text); }
  button:hover { background: var(--hover); }
  button[type="submit"] { background: var(--accent); color: var(--accent-fg); border: 0; font-weight: 600; }
  button[type="submit"]:hover { background: var(--accent-hover); }
  button:disabled { background: var(--btn-disabled); cursor: default; }
  .cred-list { list-style: none; margin: 0 0 14px; padding: 0; display: grid; gap: 8px; }
  .cred-list li { display: flex; gap: 10px; align-items: center; }
  .cred-validated { color: var(--muted); font-size: 12px; }
  .role-table { border-collapse: collapse; font-size: 13px; width: 100%; }
  .role-table th, .role-table td { text-align: left; padding: 6px 12px 6px 0; border-bottom: 1px solid var(--border); }
  .role-table th { color: var(--faint); font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; }
  .hint { margin: 8px 0; }
  .edit-problem, .problem { margin: 4px 0; }
  .auth summary { cursor: pointer; }
  .auth form { margin: 8px 0; }
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
        <input type="button" class="app-delete" value="×" title="Delete this app" aria-label="Delete this app"
               hx-delete="/generations/${g.id}"
               hx-target="#edit-result"
               hx-swap="innerHTML"
               hx-confirm="Delete this app?">
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
<style>${THEME_CSS}${AUTH_CSS}${OWNER_CONTROLS_CSS}
  html, body { height: 100%; }
  body { display: flex; flex-direction: column; height: 100vh; overflow: hidden; }
  .cred-banner {
    margin: 0; padding: 8px 18px; font-size: 13px;
    background: var(--warn-bg); color: var(--warn-text); border-bottom: 1px solid var(--warn-border);
  }
  .cred-banner a { color: inherit; font-weight: 600; text-decoration: underline; }
  .shell { flex: 1; min-height: 0; display: grid; grid-template-columns: 300px 1fr; }

  aside { background: var(--panel); border-right: 1px solid var(--border);
          display: flex; flex-direction: column; min-height: 0; }
  .side-head { padding: 18px 18px 14px; border-bottom: 1px solid var(--border); }
  .side-links { display: flex; gap: 14px; margin-top: 10px; font-size: 13px; }
  .side-links a { color: var(--muted); }
  .side-links a:hover { color: var(--accent); }
  .side-auth { padding: 12px 18px; border-bottom: 1px solid var(--border); }
  .list-label {
    padding: 14px 18px 6px; display: flex; align-items: center; justify-content: space-between;
    font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase; color: var(--faint);
  }
  .list-label .newapp { text-transform: none; letter-spacing: 0; }
  body.creating .newapp { background: var(--accent-soft); color: var(--accent); }
  .app-list { flex: 1; overflow-y: auto; padding: 0 10px 16px; list-style: none; margin: 0; }
  .app-list li { display: flex; align-items: center; gap: 10px; padding: 0 10px 0 0; border-radius: 9px; }
  .app-list li:hover { background: var(--hover); }
  .app-list li.active { background: var(--accent-soft); }
  .app-list li button {
    flex: 1; min-width: 0; text-align: left; border: 0; background: transparent; color: var(--text);
    padding: 9px 10px; font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .app-list .empty { padding: 9px 10px; margin: 0; }
  /* An <input type="button">, not a <button>: the frontend suite finds a row's open-app control
     as the only "button" inside its li, which a second <button> in the row would make ambiguous. */
  /* Collapsed to zero width (and pulled over the flex gap with a negative margin) until the row
     is hovered, so it takes no room at rest; expanding it pushes the badge left. Keyboard users
     get it via :focus-visible only — NOT :focus-within, which a mouse click on the row's name
     button also satisfies, leaving the cross stuck open after the pointer has left. */
  .app-list .app-delete {
    flex: none; width: 0; height: 22px; margin-left: -10px; padding: 0; border: 0; border-radius: 6px;
    overflow: hidden; background: transparent; color: var(--faint); font-size: 16px; line-height: 1;
    opacity: 0; pointer-events: none;
    transition: width .15s ease, margin-left .15s ease, opacity .15s ease, background .12s, color .12s;
  }
  .app-list li:hover .app-delete, .app-list li:has(:focus-visible) .app-delete {
    width: 22px; margin-left: 0; opacity: 1; pointer-events: auto;
  }
  .app-list .app-delete:hover, .app-list .app-delete:focus-visible { background: var(--status-failed-bg); color: var(--bad); }
  @media (hover: none) { .app-list .app-delete { width: 22px; margin-left: 0; opacity: 1; pointer-events: auto; } }
  .status {
    flex: none; width: 76px; text-align: center; font-size: 10px; font-weight: 600; letter-spacing: .03em;
    padding: 2px 0; border-radius: 999px;
  }
  .status-complete { background: var(--status-complete-bg); color: var(--status-complete-fg); }
  .status-streaming { background: var(--status-streaming-bg); color: var(--status-streaming-fg); }
  .status-pending { background: var(--status-pending-bg); color: var(--status-pending-fg); }
  .status-failed { background: var(--status-failed-bg); color: var(--status-failed-fg); }

  main { display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .stage-head { display: flex; align-items: center; gap: 10px; padding: 10px 20px 0; min-height: 38px; }
  .stage-head .owner-controls { margin-left: auto; }
  .stream-pill {
    display: none; align-items: center; gap: 7px; font-size: 12px; font-weight: 500;
    color: var(--accent); background: var(--accent-soft); border: 1px solid var(--pill-border);
    padding: 4px 11px; border-radius: 999px;
  }
  body.streaming .stream-pill { display: inline-flex; }
  .stream-pill .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); animation: blink 1.1s infinite; }
  @keyframes blink { 50% { opacity: .25; } }
  #stage {
    flex: 1; min-height: 0; margin: 12px 20px; display: flex; flex-direction: column;
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px; overflow: hidden;
  }
  .preview { flex: 1; border: 0; width: 100%; height: 100%; background: #fff; }
  .placeholder { margin: auto; padding: 0 40px; text-align: center; }

  /* One composer, two modes (mockup D): the create form is always in the DOM, the edit form
     arrives out-of-band into #edit-slot. body.creating picks which one shows. */
  .dock { display: flex; gap: 10px; align-items: center; padding: 12px 20px;
          background: var(--panel); border-top: 1px solid var(--border); }
  body.creating #edit-slot { display: none; }
  body:not(.creating) #create-form { display: none; }
  body:not(.creating) .dock:has(#edit-slot:empty) { display: none; }
  #create-form, #edit-slot, #edit-form { flex: 1; min-width: 0; display: flex; gap: 10px; align-items: center; margin: 0; }
  #create-form textarea {
    flex: 1; height: 40px; padding: 9px 13px; line-height: 20px; resize: none;
  }
  #edit-form input { flex: 1; min-width: 0; height: 40px; padding: 0 13px; }
  #edit-form select { font-size: 13px; height: 40px; }
  .apply, #edit-form button {
    background: var(--accent); color: var(--accent-fg); border: 0; border-radius: 10px;
    padding: 9px 18px; font-weight: 600; height: 40px;
  }
  .apply:hover, #edit-form button:hover { background: var(--accent-hover); }
  .apply:disabled, #edit-form button:disabled { background: var(--btn-disabled); cursor: default; }

  /* editApplied / editProblem land in #edit-result; only the inner paragraph is drawn (as a
     toast), so an empty container shows nothing. The text stays in the DOM after it fades. */
  #edit-result { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%); z-index: 50; pointer-events: none; }
  #edit-result > p {
    padding: 9px 16px; border-radius: 10px; font-size: 13px; font-weight: 500;
    box-shadow: var(--shadow); animation: toast-out 4.5s ease forwards;
  }
  #edit-result > .edit-ok { background: var(--toast-ok-bg); color: var(--toast-ok-fg); }
  #edit-result > .edit-problem { background: var(--toast-bad-bg); color: var(--toast-bad-fg); }
  @keyframes toast-out { 0%, 80% { opacity: 1; } 100% { opacity: 0; } }

  /* Delete confirmation (replaces the browser's native confirm, via htmx:confirm below). */
  #confirm-dialog {
    border: 1px solid var(--border); border-radius: 16px; padding: 0; width: min(420px, calc(100vw - 32px));
    background: var(--panel); color: var(--text); box-shadow: var(--shadow);
  }
  #confirm-dialog::backdrop { background: rgba(10, 12, 18, .5); backdrop-filter: blur(2px); }
  #confirm-dialog[open] { animation: dialog-in .16s ease; }
  @keyframes dialog-in { from { opacity: 0; transform: translateY(6px) scale(.98); } }
  #confirm-dialog form { display: block; margin: 0; padding: 22px 22px 18px; }
  #confirm-dialog h2 { margin: 0 0 6px; font-size: 16px; }
  #confirm-dialog .confirm-name {
    margin: 0 0 8px; padding: 6px 10px; border-radius: 8px; background: var(--hover);
    font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  #confirm-dialog .confirm-body { margin: 0; color: var(--muted); }
  #confirm-dialog .confirm-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px; }
  #confirm-dialog .confirm-actions button {
    height: 36px; padding: 0 16px; border-radius: 10px; font-weight: 600;
    border: 1px solid var(--border); background: var(--panel); color: var(--text);
  }
  #confirm-dialog .confirm-actions button:hover { background: var(--hover); }
  #confirm-dialog .confirm-actions .confirm-danger { background: var(--bad); border-color: transparent; color: var(--danger-fg); }
  #confirm-dialog .confirm-actions .confirm-danger:hover { background: var(--bad); filter: brightness(1.1); }
  #confirm-dialog button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  @media (max-width: 760px) {
    .shell { grid-template-columns: 1fr; grid-template-rows: auto 1fr; }
    aside { border-right: 0; border-bottom: 1px solid var(--border); max-height: 38vh; }
  }
</style>
</head>
<body class="creating">
  ${missingCredentialBanner(missing)}
  <div class="shell">
  <aside>
    <div class="side-head">
      <div class="brand"><span class="brand-mark"></span>any-app</div>
      <div class="side-links"><a href="/settings">Settings</a></div>
    </div>
    <div class="side-auth">${authForms(owner)}</div>
    <div class="list-label">
      Your apps
      <button class="newapp" id="newapp-btn"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>New app</button>
    </div>
    <ul id="generation-list" class="app-list">${generationList(generations)}</ul>
  </aside>
  <main>
    <div class="stage-head">
      <span class="stream-pill"><span class="dot"></span>Generating…</span>
      <div id="owner-slot" class="owner-controls"></div>
    </div>
    <div id="stage"><p class="placeholder">Your app will appear here.</p></div>
    <div class="dock">
      <form id="create-form" hx-post="/generations" hx-target="#stage" hx-swap="innerHTML">
        <textarea name="prompt" rows="1" placeholder="Describe the app you want…" required></textarea>
        <button type="submit" class="apply">Create app</button>
      </form>
      <div id="edit-slot"></div>
    </div>
    <div id="edit-result"></div>
  </main>
  <dialog id="confirm-dialog" aria-labelledby="confirm-title">
    <form method="dialog">
      <h2 id="confirm-title">Delete this app?</h2>
      <p class="confirm-name" id="confirm-name"></p>
      <p class="confirm-body">This permanently removes the app and any data it has saved. This cannot be undone.</p>
      <div class="confirm-actions">
        <button value="cancel" autofocus>Cancel</button>
        <button value="delete" class="confirm-danger">Delete</button>
      </div>
    </form>
  </dialog>
  </div>
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

    // Composer mode + sidebar selection + the "Generating…" pill. Same template-literal rule
    // as above: no regex literals and no backslashes in here, string methods only.
    (function () {
      var body = document.body;
      var createForm = document.getElementById("create-form");
      var prompt = createForm.elements["prompt"];

      function setStreaming(on) {
        body.classList.toggle("streaming", on);
      }

      document.getElementById("newapp-btn").addEventListener("click", function () {
        body.classList.add("creating");
        prompt.focus();
      });

      // Enter sends, Shift+Enter is a newline. requestSubmit (not submit) so htmx's own
      // submit listener and the textarea's "required" validation both still run.
      prompt.addEventListener("keydown", function (event) {
        if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
          event.preventDefault();
          createForm.requestSubmit();
        }
      });

      document.body.addEventListener("htmx:afterSwap", function (event) {
        if (!event.target || event.target.id !== "stage") return;
        var detail = event.detail || {};
        var path = (detail.pathInfo && detail.pathInfo.requestPath) || "";
        var verb = String((detail.requestConfig && detail.requestConfig.verb) || "").toLowerCase();

        if (verb === "get" && path.endsWith("/frame")) {
          // Picking an app from the sidebar switches the composer to edit mode.
          body.classList.remove("creating");
          setStreaming(false);
          var rows = document.querySelectorAll("#generation-list li");
          for (var i = 0; i < rows.length; i++) rows[i].classList.remove("active");
          var row = detail.elt && detail.elt.closest ? detail.elt.closest("li") : null;
          if (row) row.classList.add("active");
        } else if (verb === "post" && path === "/generations") {
          // A create response is the streaming iframe; it fires "load" when the document
          // has fully arrived. A 400 response has no iframe and shows no pill.
          var frame = document.querySelector("#stage iframe");
          setStreaming(!!frame);
          if (frame) frame.addEventListener("load", function () { setStreaming(false); });
        }
      });

      // Custom confirmation instead of window.confirm. htmx raises htmx:confirm for any element
      // with hx-confirm; cancelling the event holds the request until we call issueRequest.
      var dialog = document.getElementById("confirm-dialog");
      document.body.addEventListener("htmx:confirm", function (event) {
        if (!event.detail.question || !dialog.showModal) return;
        event.preventDefault();
        var row = event.detail.elt.closest("li");
        var opener = row ? row.querySelector("button") : null;
        document.getElementById("confirm-title").textContent = event.detail.question;
        document.getElementById("confirm-name").textContent = opener ? opener.textContent : "";
        dialog.returnValue = "cancel";
        dialog.addEventListener("close", function onClose() {
          dialog.removeEventListener("close", onClose);
          if (dialog.returnValue === "delete") event.detail.issueRequest(true);
        });
        dialog.showModal();
      });
      // Clicking the dimmed backdrop (the dialog element itself, not its form) cancels.
      dialog.addEventListener("click", function (event) {
        if (event.target === dialog) dialog.close("cancel");
      });

      // A delete succeeded (200) or the app was already gone (404): drop its sidebar row, and
      // if it is the app on the stage, put the stage and composer back to their empty state.
      // Anything else (409 "still generating") leaves the row alone; the server's message has
      // already landed in #edit-result as a toast.
      document.body.addEventListener("htmx:afterRequest", function (event) {
        var detail = event.detail || {};
        var verb = String((detail.requestConfig && detail.requestConfig.verb) || "").toLowerCase();
        var status = detail.xhr ? detail.xhr.status : 0;
        if (verb !== "delete" || (status !== 200 && status !== 404)) return;
        var path = (detail.pathInfo && detail.pathInfo.requestPath) || "";
        var deletedId = path.split("/").pop();
        var row = event.target && event.target.closest ? event.target.closest("li") : null;
        if (row) row.remove();
        if (anyappFrameFor(deletedId)) {
          document.getElementById("stage").innerHTML = '<p class="placeholder">Your app will appear here.</p>';
          document.getElementById("edit-slot").innerHTML = "";
          document.getElementById("owner-slot").innerHTML = "";
          body.classList.add("creating");
          setStreaming(false);
        }
        var list = document.getElementById("generation-list");
        if (!list.querySelector("li")) list.innerHTML = '<p class="empty">No apps yet. Describe one above.</p>';
      });

      document.body.addEventListener("htmx:afterRequest", function (event) {
        if (event.target === createForm && event.detail && event.detail.successful) prompt.value = "";
      });
    })();
  </script>
</body>
</html>`;
}
