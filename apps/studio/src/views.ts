import type { Generation, Message, Visibility } from "@any-app/store";
import type { CredentialHint, Owner } from "@any-app/store";
import type { Role, ProviderId } from "@any-app/generator";
import type { TokenMode } from "@any-app/protocol";
import type { RoleProblem } from "./credential-resolve";
import { THEME_CSS } from "./theme";
import { isEditing } from "./activity";

/**
 * htmx skips 4xx/5xx bodies by default, which hides every user-facing error. Swap them, keeping error:true.
 * A <meta>, not a script, so there is no load-order dependency.
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
 * `grant` is the view grant: minted by the caller, forwarded blind by the sandbox. `planning` adds the overlay shown
 * until the frame's first content, for a frame that will start a generation.
 */
export function previewFrame(id: string, appOrigin: string, grant: string, planning = false): string {
  // allow-same-origin is safe only because each app has its own origin; on a shared
  // origin every app could read every other's storage.
  const frame = `<iframe
    class="preview"
    src="${escapeHtml(appOrigin)}/preview/${escapeHtml(id)}?g=${encodeURIComponent(grant)}"
    sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
    title="Generated app preview"></iframe>`;
  if (!planning) return frame;
  return `${frame}<div class="preview-wait" role="status">
    <span class="wait-spinner" aria-hidden="true"></span>
    <p class="wait-title">Planning your app…</p>
    <p class="wait-hint">The layout appears once the plan is ready. Reasoning models can take a few minutes.</p>
  </div>`;
}

/**
 * Composer and owner controls live outside #stage but belong to the app it shows, so they arrive
 * out-of-band. An empty html clears the slot.
 */
export function oobSlot(id: "edit-slot" | "owner-slot", html: string): string {
  return `<div id="${id}" hx-swap-oob="innerHTML">${html}</div>`;
}

/**
 * The conversation panel's rows. Every body is escaped text, never HTML. The pending row has
 * data-pending and no data-seq; the polling cursor is the highest data-seq.
 */
export function messageItems(
  messages: Pick<Message, "seq" | "role" | "kind" | "target" | "body">[],
  pending: string | null = null,
): string {
  const items = messages.map((m) => {
    const meta =
      m.role === "user" && m.kind === "edit" && m.target
        ? `<span class="chat-meta">${escapeHtml(m.target === "css" ? "styling" : m.target === "shell" || m.target === "@shell" ? "page frame" : m.target)}</span>`
        : "";
    return `<li class="chat-msg chat-${m.role}${m.kind === "error" ? " chat-error" : ""}" data-seq="${m.seq}">${meta}<p class="chat-body">${escapeHtml(m.body)}</p></li>`;
  });
  if (pending) {
    items.push(`<li class="chat-msg chat-assistant chat-pending" data-pending="1"><p class="chat-body">${escapeHtml(pending)}</p></li>`);
  }
  return items.join("");
}

/** Replaces the whole #chat-log element so data-app changes with it; an empty data-app hides the panel. */
export function chatLogOob(appId: string, itemsHtml: string): string {
  return `<ol id="chat-log" hx-swap-oob="true" data-app="${escapeHtml(appId)}" aria-label="Conversation" aria-live="polite">${itemsHtml}</ol>`;
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

/** Owner-only. shareUrl is the plain share link; there is no public gallery (deferred). */
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

/**
 * For a non-owner viewer of a shared app. hx-target names an element the share page lacks: harmless,
 * because with hx-swap="none" only the HX-Redirect header matters.
 */
export function remixControl(id: string): string {
  return `<form hx-post="/generations/${escapeHtml(id)}/fork" hx-target="#stage" hx-swap="none">
    <button class="btn-accent">Remix this app</button>
  </form>
  <p class="hint">Remixing copies the app, not its data — your copy starts empty.</p>`;
}

/**
 * The page a shared link opens. The frame route's response is a bare htmx fragment (no doctype,
 * stylesheet or htmx), so opened directly it is a small iframe and Remix does nothing.
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
  // #edit-result is not rendered here: it lives in homePage, and a copy would duplicate the id.
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
      <option value="@shell">Page frame (heading, caption, footer)</option>
      ${options}
    </select>
    <button type="submit">Apply</button>
  </form>`;
}

/**
 * Embeds a value as a JSON <script> block, which survives quoting that attributes do not. `<` is escaped so the
 * payload cannot close the block.
 */
function jsonBlock(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

export function editApplied(
  id: string,
  appOrigin: string,
  target: { kind: "css" } | { kind: "shell" } | { kind: "slot"; id: string },
  next: { css: string; content: Record<string, string> },
): string {
  // generationId lets the bridge skip a response that lands after the user opened another app; appOrigin pins
  // postMessage's targetOrigin.
  const payload =
    target.kind === "css"
      ? { channel: "anyapp", type: "css", css: next.css, generationId: id, appOrigin }
      : target.kind === "shell"
        // The frame cannot be patched in place the way a region or the stylesheet can — it is
        // the document's own markup — so the parent reloads the preview from the saved document.
        ? { channel: "anyapp", type: "reload", generationId: id, appOrigin }
        : {
          channel: "anyapp",
          type: "slot-content",
          id: target.id,
          html: next.content[target.id],
          generationId: id,
          appOrigin,
        };

  const label = target.kind === "css" ? "styling" : target.kind === "shell" ? "the page frame" : target.id;

  return `<script type="application/json" id="edit-payload">${jsonBlock(payload)}</script>
<script>anyappApplyEdit()</script>
<p class="edit-ok">Updated ${escapeHtml(label)}.</p>`;
}

export function editProblem(message: string): string {
  return `<p class="edit-problem">${escapeHtml(message)}</p>`;
}

/** Provider, a masked hint and the validation date. The key is never rendered or read back. */
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

/** Read-only for now: a per-role override UI would need its own storage. */
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

// No explicit type="submit" on these buttons: tests find the create button via button[type="submit"] and
// extra matches break them.
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

/** Shared by the home sidebar and the settings page. */
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

/** Shown when a generation would fail right now, before anyone waits on a failed one. */
export function missingCredentialBanner(missing: RoleProblem[]): string {
  if (missing.length === 0) return "";
  const parts = missing.map((m) => m.message).join(", ");
  return `<p class="cred-banner">${escapeHtml(parts)}. <a href="/settings">Add a credential</a> or check the matching <code>LLM_*</code> vars in <code>.env</code>.</p>`;
}

/**
 * `isUpdating` defaults to the live edit tracker (activity.ts): an edit leaves the stored status `complete`.
 * Only a complete app can show "updating".
 */
export function generationList(generations: Generation[], isUpdating: (id: string) => boolean = isEditing): string {
  if (generations.length === 0) {
    return `<p class="empty">No apps yet. Describe one above.</p>`;
  }
  return generations
    .map((g) => {
      const state = g.status === "complete" && isUpdating(g.id) ? "updating" : g.status;
      return `<li data-id="${g.id}">
        <button hx-get="/generations/${g.id}/frame"
                hx-target="#stage"
                hx-swap="innerHTML">${escapeHtml(g.prompt.slice(0, 80))}</button>
        <span class="status status-${state}">${state}</span>
        <input type="button" class="app-delete" value="×" title="Delete this app" aria-label="Delete this app"
               hx-delete="/generations/${g.id}"
               hx-target="#edit-result"
               hx-swap="innerHTML"
               hx-confirm="Delete this app?">
      </li>`;
    })
    .join("");
}

// `owner` is required so a future caller cannot silently drop the auth UI.
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
  /* An <input type="button">, not a <button>: the suite finds a row's open control as its only button. */
  /* Zero width until the row is hovered, so it takes no room at rest. Keyboard reveal uses :focus-visible,
     not :focus-within, which a mouse click on the row would leave stuck open. */
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
  .status-streaming, .status-updating { background: var(--status-streaming-bg); color: var(--status-streaming-fg); }
  .status-updating { animation: blink 1.4s infinite; }
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
    flex: 1; min-height: 0; margin: 12px 20px; display: flex; flex-direction: column; position: relative;
    background: var(--panel); border: 1px solid var(--border); border-radius: 14px; overflow: hidden;
  }
  .preview { flex: 1; border: 0; width: 100%; height: 100%; background: #fff; }
  /* Covers the blank frame while the planner runs. The delayed fade keeps a fast plan from flashing it. */
  .preview-wait {
    position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 6px; padding: 0 40px; text-align: center; background: var(--panel); pointer-events: none;
    animation: wait-in .2s ease .3s both;
  }
  .preview-wait[hidden] { display: none; }
  @keyframes wait-in { from { opacity: 0; } }
  .wait-spinner {
    width: 26px; height: 26px; margin-bottom: 8px; border-radius: 50%;
    border: 3px solid var(--border); border-top-color: var(--accent); animation: spin .9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .wait-title { margin: 0; font-weight: 600; }
  .wait-hint { margin: 0; font-size: 13px; color: var(--muted); max-width: 360px; }
  .placeholder { margin: auto; padding: 0 40px; text-align: center; }

  /* Conversation panel: a slim header that expands into a 30vh log. */
  .chat-panel { background: var(--panel); border-top: 1px solid var(--border); }
  .chat-panel:has(#chat-log[data-app=""]) { display: none; }
  .chat-head {
    display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 20px;
    border: 0; background: transparent; color: var(--muted); text-align: left;
    font-size: 11px; font-weight: 600; letter-spacing: .06em; text-transform: uppercase;
  }
  .chat-head:hover { color: var(--text); }
  .chat-head .chat-chevron { margin-left: auto; transition: transform .15s; }
  body.chat-open .chat-head .chat-chevron { transform: rotate(180deg); }
  .chat-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); }
  .chat-dot[hidden] { display: none; }
  #chat-log { display: none; list-style: none; margin: 0; padding: 4px 20px 12px; overflow-y: auto; flex-direction: column; gap: 10px; }
  body.chat-open #chat-log { display: flex; height: 30vh; }
  .chat-msg { max-width: 78%; display: flex; flex-direction: column; gap: 2px; }
  .chat-user { align-self: flex-end; align-items: flex-end; }
  .chat-assistant { align-self: flex-start; }
  .chat-body { margin: 0; padding: 8px 12px; border-radius: 12px; white-space: pre-wrap; overflow-wrap: anywhere; }
  .chat-user .chat-body { background: var(--accent); color: var(--accent-fg); border-bottom-right-radius: 4px; }
  .chat-assistant .chat-body { background: var(--hover); color: var(--text); border-bottom-left-radius: 4px; }
  .chat-error .chat-body { background: var(--status-failed-bg); color: var(--status-failed-fg); }
  .chat-meta { font-size: 11px; color: var(--faint); }
  .chat-pending .chat-body { color: var(--muted); animation: blink 1.4s infinite; }
  /* The log already says what the toast would; showing both is noise. */
  body.chat-open #edit-result > p { display: none; }

  /* Create form is always in the DOM; the edit form arrives out-of-band. body.creating picks one. */
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

  /* Only the inner paragraph is drawn (as a toast), so an empty container shows nothing. */
  #edit-result { position: fixed; left: 50%; bottom: 76px; transform: translateX(-50%); z-index: 50; pointer-events: none; }
  #edit-result > p {
    padding: 9px 16px; border-radius: 10px; font-size: 13px; font-weight: 500;
    box-shadow: var(--shadow); animation: toast-out 4.5s ease forwards;
  }
  #edit-result > .edit-ok { background: var(--toast-ok-bg); color: var(--toast-ok-fg); }
  #edit-result > .edit-problem { background: var(--toast-bad-bg); color: var(--toast-bad-fg); }
  @keyframes toast-out { 0%, 80% { opacity: 1; } 100% { opacity: 0; } }

  /* Delete confirmation, opened from htmx:confirm. */
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
    <section class="chat-panel">
      <button type="button" id="chat-toggle" class="chat-head" aria-expanded="false" aria-controls="chat-log">
        <span>Conversation</span><span class="chat-dot" id="chat-dot" hidden></span>
        <svg class="chat-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 10l5-5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <ol id="chat-log" data-app="" aria-label="Conversation" aria-live="polite"></ol>
    </section>
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
    // Returns the stage's iframe only if it still shows generationId: a slow edit can land after the user
    // opened another app, and slot ids repeat across apps.
    function anyappFrameFor(generationId) {
      var frame = document.querySelector("#stage iframe");
      if (!frame || !generationId || frame.src.indexOf(generationId) === -1) return null;
      return frame;
    }

    // Posts an applied edit (JSON block from editApplied) into the preview, pinned to the app's exact origin.
    function anyappApplyEdit() {
      var block = document.getElementById("edit-payload");
      if (!block) return;
      var payload = JSON.parse(block.textContent);
      var frame = anyappFrameFor(payload.generationId);
      if (!frame) return;
      if (payload.type === "reload") {
        // A shell edit cannot be patched in place: reload the frame (location.reload is blocked cross-origin).
        frame.src = frame.src;
        return;
      }
      frame.contentWindow.postMessage(payload, payload.appOrigin);
    }

    // Freezes the target region as soon as an explicit slot edit is submitted. An auto-routed edit has no target yet.
    function anyappBeforeEdit(event) {
      var form = event.target;
      var target = form.elements["target"].value;
      if (!target || target === "css" || target === "@shell") return;
      // RegExp constructor, not a literal: this script sits in a template literal, which drops backslashes.
      var match = new RegExp("/generations/([^/]+)/edits").exec(form.getAttribute("hx-post") || "");
      var frame = match && anyappFrameFor(match[1]);
      if (!frame) return;
      // No JSON block yet: read appOrigin off the frame's own src.
      frame.contentWindow.postMessage(
        { channel: "anyapp", type: "slot-pending", id: target },
        new URL(frame.src).origin,
      );
    }

    // Drops a frame's planning overlay at its first content, or at its load when the document carries no signal.
    (function () {
      function hideWait(frame) {
        var wait = frame.parentNode && frame.parentNode.querySelector(".preview-wait");
        if (wait) wait.hidden = true;
      }
      window.addEventListener("message", function (event) {
        var data = event.data;
        if (!data || data.channel !== "anyapp" || data.type !== "first-content") return;
        var frames = document.querySelectorAll("iframe.preview");
        for (var i = 0; i < frames.length; i++) {
          if (frames[i].contentWindow === event.source && new URL(frames[i].src).origin === event.origin) hideWait(frames[i]);
        }
      });
      // load does not bubble, but a capturing listener still sees every iframe's.
      document.addEventListener("load", function (event) {
        if (event.target && event.target.tagName === "IFRAME") hideWait(event.target);
      }, true);
    })();

    // Same rule as above: no regex literals or backslashes in here.
    (function () {
      var body = document.body;
      var createForm = document.getElementById("create-form");
      var prompt = createForm.elements["prompt"];

      function setStreaming(on) {
        body.classList.toggle("streaming", on);
      }

      var list = document.getElementById("generation-list");
      var dialog = document.getElementById("confirm-dialog");

      // Live sidebar: polls GET /generations, fast while a row is pending/streaming/updating and slow otherwise,
      // backing off when nothing changes and paused while the tab is hidden.
      var FAST_MS = 2000, SLOW_MS = 15000;
      var lastListHtml = null, refreshing = false, rerun = false, unchanged = 0, timer = null;
      // Bumped by local changes; a poll that started earlier is stale and dropped.
      var listEpoch = 0;

      // The highlight follows the stage, so it survives re-renders.
      function currentStageId() {
        var frame = document.querySelector("#stage iframe");
        if (!frame) return "";
        return new URL(frame.src).pathname.split("/")[2] || "";
      }
      function markActive() {
        var id = currentStageId();
        var rows = list.querySelectorAll("li");
        for (var i = 0; i < rows.length; i++) {
          rows[i].classList.toggle("active", !!id && rows[i].getAttribute("data-id") === id);
        }
      }
      function hasLiveRows() {
        return !!list.querySelector(".status-pending, .status-streaming, .status-updating");
      }

      function refreshList() {
        // Not while a delete dialog is open: replacing the list would detach the control it holds.
        if (document.hidden || dialog.open) return Promise.resolve();
        // A refresh requested mid-flight may predate the change; run once more when this one lands.
        if (refreshing) { rerun = true; return Promise.resolve(); }
        refreshing = true;
        var epoch = listEpoch;
        return fetch("/generations", { credentials: "same-origin", cache: "no-store" })
          .then(function (res) { return res.ok ? res.text() : null; })
          .then(function (html) {
            if (html === null || epoch !== listEpoch) return;
            if (html === lastListHtml) { unchanged++; return; }
            unchanged = 0;
            lastListHtml = html;
            list.innerHTML = html;
            htmx.process(list);
            markActive();
          })
          .catch(function () {})
          .then(function () {
            refreshing = false;
            if (rerun) { rerun = false; return refreshList(); }
          });
      }

      // Conversation panel. #chat-log is replaced out-of-band, so look it up each time; empty data-app hides the panel.
      var CHAT_KEY = "anyapp.chat.open";
      var chatToggle = document.getElementById("chat-toggle");
      var chatDot = document.getElementById("chat-dot");
      var chatBusy = false;
      function chatEl() { return document.getElementById("chat-log"); }
      function nearBottom(el) { return el.scrollHeight - el.scrollTop - el.clientHeight < 40; }
      function scrollChat() { var el = chatEl(); if (el) el.scrollTop = el.scrollHeight; }
      function setChatOpen(on) {
        body.classList.toggle("chat-open", on);
        chatToggle.setAttribute("aria-expanded", on ? "true" : "false");
        if (on) { chatDot.hidden = true; scrollChat(); }
        try { localStorage.setItem(CHAT_KEY, on ? "1" : "0"); } catch (e) { /* private mode etc.: not persisted */ }
      }
      chatToggle.addEventListener("click", function () { setChatOpen(!body.classList.contains("chat-open")); });
      try {
        if (localStorage.getItem(CHAT_KEY) === "1") {
          body.classList.add("chat-open");
          chatToggle.setAttribute("aria-expanded", "true");
        }
      } catch (e) { /* storage unavailable: start collapsed */ }

      function lastSeq(el) {
        var seqs = el.querySelectorAll("li[data-seq]");
        return seqs.length ? Number(seqs[seqs.length - 1].getAttribute("data-seq")) : 0;
      }
      // Fetches messages newer than the log's last data-seq and swaps the transient "working" row.
      function refreshChat() {
        var log = chatEl();
        var appId = log ? log.getAttribute("data-app") : "";
        if (!appId || document.hidden || chatBusy) return Promise.resolve();
        chatBusy = true;
        var url = "/generations/" + encodeURIComponent(appId) + "/messages?after=" + lastSeq(log);
        return fetch(url, { credentials: "same-origin", cache: "no-store" })
          .then(function (res) { return res.ok ? res.text() : null; })
          .then(function (html) {
            var cur = chatEl();
            // The stage may have changed app while this was in flight.
            if (html === null || !cur || cur.getAttribute("data-app") !== appId) return;
            var stick = nearBottom(cur);
            var pending = cur.querySelector("[data-pending]");
            if (pending) pending.remove();
            var tpl = document.createElement("template");
            tpl.innerHTML = html;
            var added = tpl.content.querySelectorAll("li[data-seq]").length;
            cur.appendChild(tpl.content);
            if (added && !body.classList.contains("chat-open")) chatDot.hidden = false;
            if (stick || added) scrollChat();
          })
          .catch(function () {})
          .then(function () { chatBusy = false; });
      }

      function tick() { return refreshList().then(refreshChat); }
      function schedule() {
        clearTimeout(timer);
        var delay = hasLiveRows() ? Math.min(SLOW_MS, FAST_MS * (1 + unchanged)) : SLOW_MS;
        timer = setTimeout(function () { tick().then(schedule); }, delay);
      }
      document.addEventListener("visibilitychange", function () {
        if (!document.hidden) { unchanged = 0; tick().then(schedule); }
      });
      schedule();

      document.getElementById("newapp-btn").addEventListener("click", function () {
        body.classList.add("creating");
        prompt.focus();
      });

      // Enter sends, Shift+Enter is a newline; requestSubmit keeps htmx and required validation.
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
          // Picking an app switches the composer to edit mode.
          body.classList.remove("creating");
          setStreaming(false);
          markActive();
          chatDot.hidden = true;
          setTimeout(scrollChat, 0);
        } else if (verb === "post" && path === "/generations") {
          // The create response is the streaming iframe; its load event means the document arrived.
          var frame = document.querySelector("#stage iframe");
          setStreaming(!!frame);
          if (frame) frame.addEventListener("load", function () { setStreaming(false); refreshList(); refreshChat(); });
        }
      });

      // Custom confirmation instead of window.confirm: cancel htmx:confirm, then issueRequest on Delete.
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
      // A click on the backdrop (the dialog itself) cancels.
      dialog.addEventListener("click", function (event) {
        if (event.target === dialog) dialog.close("cancel");
      });

      // Deleted (200) or already gone (404): drop the row, and reset the stage if that app was open.
      // Anything else (409) keeps the row; the toast already shows the message.
      document.body.addEventListener("htmx:afterRequest", function (event) {
        var detail = event.detail || {};
        var verb = String((detail.requestConfig && detail.requestConfig.verb) || "").toLowerCase();
        var status = detail.xhr ? detail.xhr.status : 0;
        if (verb !== "delete" || (status !== 200 && status !== 404)) return;
        var path = (detail.pathInfo && detail.pathInfo.requestPath) || "";
        var deletedId = path.split("/").pop();
        listEpoch++;
        var rows = list.querySelectorAll("li");
        for (var i = 0; i < rows.length; i++) {
          if (rows[i].getAttribute("data-id") === deletedId) rows[i].remove();
        }
        if (anyappFrameFor(deletedId)) {
          document.getElementById("stage").innerHTML = '<p class="placeholder">Your app will appear here.</p>';
          document.getElementById("edit-slot").innerHTML = "";
          document.getElementById("owner-slot").innerHTML = "";
          var log = chatEl();
          if (log) { log.setAttribute("data-app", ""); log.innerHTML = ""; }
          body.classList.add("creating");
          setStreaming(false);
        }
        if (!list.querySelector("li")) list.innerHTML = '<p class="empty">No apps yet. Describe one above.</p>';
        markActive();
        refreshList().then(schedule);
      });

      // An edit leaves the app complete, so the badge comes from the server's in-memory edit flag: pull the list
      // just after the request starts and again when it finishes.
      document.body.addEventListener("htmx:beforeRequest", function (event) {
        if (!event.target || event.target.id !== "edit-form") return;
        setTimeout(function () { unchanged = 0; tick().then(schedule); }, 400);
      });
      document.body.addEventListener("htmx:afterRequest", function (event) {
        if (!event.target || event.target.id !== "edit-form") return;
        listEpoch++;
        tick().then(schedule);
      });

      // Prompt boxes clear on submit (htmx has already read the value); a failed request puts the text back
      // unless the user typed something new.
      var submitted = {};
      function promptField(form) {
        return form.elements[form.id === "create-form" ? "prompt" : "instruction"];
      }
      document.body.addEventListener("htmx:beforeRequest", function (event) {
        var form = event.target;
        if (!form || (form.id !== "create-form" && form.id !== "edit-form")) return;
        var field = promptField(form);
        if (!field) return;
        submitted[form.id] = field.value;
        field.value = "";
      });
      document.body.addEventListener("htmx:afterRequest", function (event) {
        var form = event.target;
        if (!form || (form.id !== "create-form" && form.id !== "edit-form")) return;
        var field = promptField(form);
        var ok = !!(event.detail && event.detail.successful);
        if (field && !ok && !field.value) field.value = submitted[form.id] || "";
        // hx-disabled-elt took the focus with it: restore it unless the user moved elsewhere.
        if (field && ok && document.activeElement === document.body) field.focus();
        if (form === createForm && ok) {
          // The new row exists server-side already, so the list shows it as pending without a reload.
          listEpoch++;
          refreshList().then(schedule);
        }
      });
    })();
  </script>
</body>
</html>`;
}
