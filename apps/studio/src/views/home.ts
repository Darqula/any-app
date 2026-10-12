import type { Generation, Owner } from "@any-app/store";
import type { RoleProblem } from "../credential-resolve.ts";
import { html, type Html } from "./escape.ts";
import { HTMX_CONFIG_META, HTMX_SCRIPT, cssLinks, scriptTag } from "./layout.ts";
import { generationList } from "./app-list.ts";
import { sidebarFooter, authDialog } from "./sidebar-footer.ts";

/** Shown when a generation would fail right now, before anyone waits on a failed one. */
export function missingCredentialBanner(missing: RoleProblem[]): Html | null {
  if (missing.length === 0) return null;
  const parts = missing.map((m) => m.message).join(", ");
  return html`<p class="cred-banner">${parts}. <a class="banner-link" href="/settings">Add a credential</a> or check the matching <code>LLM_*</code> vars in <code>.env</code>.</p>`;
}

// `owner` is required so a future caller cannot silently drop the auth UI.
export function homePage(generations: Generation[], missing: RoleProblem[], owner: Owner, email: string | null): Html {
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>any-app studio</title>
${HTMX_CONFIG_META}
${HTMX_SCRIPT}
${cssLinks(["home", "sidebar", "workspace", "auth", "owner-controls"])}
</head>
<body class="page-home creating">
  ${missingCredentialBanner(missing)}
  <div class="shell">
  <aside class="sidebar">
    <div class="side-head">
      <div class="brand"><span class="brand-mark"></span>any-app</div>
    </div>
    <div class="list-label">
      Your apps
      <button class="btn btn--primary newapp" id="newapp-btn"><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>New app</button>
    </div>
    <ul id="generation-list" class="app-list">${generationList(generations)}</ul>
    ${sidebarFooter(owner, email)}
  </aside>
  <main class="workspace">
    <div class="stage-head">
      <span class="stream-pill"><span class="stream-dot"></span>Generating…</span>
      <div id="owner-slot" class="owner-controls stage-owner"></div>
    </div>
    <div id="stage" class="stage"><p class="placeholder">Your app will appear here.</p></div>
    <section class="chat-panel">
      <button type="button" id="chat-toggle" class="btn-bare chat-head" aria-expanded="false" aria-controls="chat-log">
        <span>Conversation</span><span class="chat-dot" id="chat-dot" hidden></span>
        <svg class="chat-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 10l5-5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </button>
      <ol id="chat-log" class="chat-log" data-app="" aria-label="Conversation" aria-live="polite"></ol>
    </section>
    <div class="dock">
      <form id="create-form" class="composer-row composer-create" hx-post="/generations" hx-target="#stage" hx-swap="innerHTML">
        <textarea class="composer-textarea" name="prompt" rows="1" placeholder="Describe the app you want…" required></textarea>
        <button type="submit" class="btn btn--primary composer-submit">Create app</button>
      </form>
      <div id="edit-slot" class="composer-row composer-slot"></div>
    </div>
    <div id="edit-result" class="toasts"></div>
  </main>
  <dialog id="confirm-dialog" class="dialog" aria-labelledby="confirm-title">
    <form method="dialog" class="confirm-form">
      <h2 id="confirm-title" class="confirm-title">Delete this app?</h2>
      <p class="confirm-name" id="confirm-name"></p>
      <p class="confirm-body">This permanently removes the app and any data it has saved. This cannot be undone.</p>
      <div class="confirm-actions">
        <button value="cancel" class="btn confirm-btn" autofocus>Cancel</button>
        <button value="delete" class="btn btn--danger confirm-btn">Delete</button>
      </div>
    </form>
  </dialog>
  ${authDialog(owner)}
  </div>

  ${scriptTag("auth")}
  ${scriptTag("home")}
</body>
</html>`;
}
