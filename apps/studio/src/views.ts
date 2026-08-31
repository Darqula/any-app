import type { Generation } from "@any-app/store";
import type { CredentialHint } from "@any-app/store";
import type { Role, ProviderId } from "@any-app/generator";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function previewFrame(id: string, sandboxUrl: string): string {
  // allow-scripts WITHOUT allow-same-origin gives the frame an opaque origin, on top of
  // the fact that it is already served from a different host. Do not add
  // allow-same-origin — it would undo the sandbox attribute entirely.
  return `<iframe
    class="preview"
    src="${sandboxUrl}/preview/${escapeHtml(id)}"
    sandbox="allow-scripts allow-forms allow-popups"
    title="Generated app preview"></iframe>`;
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
  target: { kind: "css" } | { kind: "slot"; id: string },
  next: { css: string; content: Record<string, string> },
): string {
  // `generationId` lets the bridge (anyappApplyEdit) refuse to post into whatever happens to
  // be in #stage when the response lands — see its own comment for why that can be a
  // different app than the one the edit was submitted against.
  const payload =
    target.kind === "css"
      ? { channel: "anyapp", type: "css", css: next.css, generationId: id }
      : {
          channel: "anyapp",
          type: "slot-content",
          id: target.id,
          html: next.content[target.id],
          generationId: id,
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

export function settingsPage(hints: CredentialHint[], roleRows: { role: Role; provider: ProviderId; model: string; maxTokens: number }[]): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>any-app settings</title>
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
  .edit-problem { color: #b00020; }
  .empty { opacity: .6; }
</style>
</head>
<body>
  <p><a href="/">&larr; back</a></p>
  <h1>Settings</h1>

  <section>
    <h2>Provider credentials</h2>
    <p class="hint">Session-scoped — cleared if you clear cookies. Used in preference to the
      platform key in <code>.env</code> for whichever role is configured to use that provider.</p>
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

/** Shown at the top of the home page when a generation would fail right now for lack of a
 * credential, so the gap surfaces before someone spends a wait on a failed generation. */
export function missingCredentialBanner(missing: { role: Role; provider: ProviderId }[]): string {
  if (missing.length === 0) return "";
  const parts = missing.map((m) => `${m.role} needs ${m.provider}`).join(", ");
  return `<p class="cred-banner">No credential configured for: ${escapeHtml(parts)}. <a href="/settings">Add one</a> or set the matching key in <code>.env</code>.</p>`;
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

export function homePage(
  generations: Generation[],
  sandboxUrl: string,
  missing: { role: Role; provider: ProviderId }[] = [],
): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>any-app studio</title>
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
  .edit-problem { color: #b00020; margin: 0; }
</style>
</head>
<body>
  ${missingCredentialBanner(missing)}
  <aside>
    <h1>any-app</h1>
    <p><a href="/settings">Settings</a></p>
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
    // The frame runs on an opaque origin, so a specific targetOrigin is impossible here —
    // the receiving side is what validates the sender, by checking event.origin against the
    // studio origin baked into swapRuntime.
    function anyappApplyEdit() {
      var block = document.getElementById("edit-payload");
      if (!block) return;
      var payload = JSON.parse(block.textContent);
      var frame = anyappFrameFor(payload.generationId);
      if (!frame) return;
      frame.contentWindow.postMessage(payload, "*");
    }

    // Freezes the target region into a skeleton the instant an explicit slot edit is
    // submitted, so the wait has visible feedback instead of the page looking unchanged
    // until the whole response comes back. Only meaningful for an explicit slot choice —
    // an auto-routed edit does not know its target until the response arrives.
    function anyappBeforeEdit(event) {
      var form = event.target;
      var target = form.elements["target"].value;
      if (!target || target === "css") return;
      var match = /\/generations\/([^/]+)\/edits/.exec(form.getAttribute("hx-post") || "");
      var frame = match && anyappFrameFor(match[1]);
      if (!frame) return;
      frame.contentWindow.postMessage(
        { channel: "anyapp", type: "slot-pending", id: target },
        "*",
      );
    }
  </script>
</body>
</html>`;
}
