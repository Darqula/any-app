import type { CredentialHint, Owner } from "@any-app/store";
import type { Role, ProviderId } from "@any-app/generator";
import { html, type Html } from "./escape.ts";
import { editOk } from "./notices.ts";
import { HTMX_CONFIG_META, HTMX_SCRIPT, cssLinks, scriptTag } from "./layout.ts";
import { authDialog, accountSection } from "./sidebar-footer.ts";

type RoleRow = { role: Role; provider: ProviderId; model: string; maxTokens: number };

/** Provider, a masked hint and the validation date. The key is never rendered or read back. */
export function credentialList(hints: CredentialHint[]): Html {
  if (hints.length === 0) {
    return html`<p class="empty">No credentials saved. The platform key from .env is used until you add one.</p>`;
  }
  return html`<ul class="cred-list">${hints.map(
    (h) => html`<li class="cred-row">
        <code>${h.provider}</code>
        <span>····${h.hint}</span>
        <span class="cred-validated">${h.validatedAt ? `validated ${h.validatedAt.toISOString().slice(0, 10)}` : "not validated"}</span>
        <button class="btn" hx-delete="/settings/credentials/${h.provider}"
                hx-target="closest li" hx-swap="outerHTML"
                hx-confirm="Remove this credential?">Remove</button>
      </li>`,
  )}</ul>`;
}

export function credentialForm(): Html {
  return html`<form id="cred-form" class="form-stack"
    hx-post="/settings/credentials"
    hx-target="#cred-result"
    hx-swap="innerHTML"
    hx-disabled-elt="find button, find input, find select">
    <label class="field">Provider
      <select name="provider" required>
        <option value="openai">OpenAI-compatible</option>
        <option value="anthropic">Anthropic</option>
      </select>
    </label>
    <label class="field">API key <input name="apiKey" type="password" autocomplete="off" required></label>
    <label class="field">Base URL (optional) <input name="baseUrl" placeholder="leave blank for the provider's default"></label>
    <label class="field">Model to validate with <input name="model" placeholder="e.g. gpt-4o or claude-opus-5" required></label>
    <button type="submit" class="btn btn--primary">Save</button>
  </form>
  <div id="cred-result"></div>`;
}

export function credentialSaved(provider: string): Html {
  return editOk(`Saved and validated ${provider}.`);
}

const ROLE_LABELS: Record<Role, string> = {
  planner: "Planner",
  fill: "Fill",
  edit: "Edit",
  router: "Router",
};

/** Read-only for now: a per-role override UI would need its own storage. */
export function roleConfigTable(rows: RoleRow[]): Html {
  return html`<table class="role-table">
    <thead><tr><th class="role-cell role-head">Role</th><th class="role-cell role-head">Provider</th><th class="role-cell role-head">Model</th><th class="role-cell role-head">Max tokens</th></tr></thead>
    <tbody>${rows.map(
      (r) => html`<tr>
          <td class="role-cell">${ROLE_LABELS[r.role]}</td>
          <td class="role-cell">${r.provider}</td>
          <td class="role-cell">${r.model}</td>
          <td class="role-cell">${r.maxTokens}</td>
        </tr>`,
    )}</tbody>
  </table>
  <p class="hint">Set via <code>LLM_MODEL</code> / <code>LLM_&lt;ROLE&gt;_MODEL</code> etc. in <code>.env</code>.</p>`;
}

export function settingsPage(hints: CredentialHint[], roleRows: RoleRow[], owner: Owner, email: string | null): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>any-app settings</title>
${HTMX_CONFIG_META}
${HTMX_SCRIPT}
${cssLinks(["auth", "settings"])}
</head>
<body class="page-settings">
  <p><a href="/">&larr; back</a></p>
  <h1 class="page-title">Settings</h1>

  <section class="card">
    <h2 class="card-title">Account</h2>
    ${accountSection(owner, email)}
  </section>

  <section class="card">
    <h2 class="card-title">Provider credentials</h2>
    <p class="hint">${owner.kind === "user"
      ? "Tied to your account — available on any device you sign in on."
      : "Session-scoped — cleared if you clear cookies, and claimed automatically if you sign up."}
      Used in preference to the platform key in <code>.env</code> for whichever role is
      configured to use that provider.</p>
    ${credentialList(hints)}
    ${credentialForm()}
  </section>

  <section class="card">
    <h2 class="card-title">Per-role configuration</h2>
    ${roleConfigTable(roleRows)}
  </section>
  ${authDialog(owner)}
  ${scriptTag("auth")}
</body>
</html>`;
}
