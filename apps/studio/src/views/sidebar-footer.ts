import type { Owner } from "@any-app/store";
import { html, raw, type Html } from "./escape.ts";

/** Sidebar footer: the account menu for a signed-in user, else the sign-in / sign-up buttons. `email` is null for an anonymous owner. */
export function sidebarFooter(owner: Owner, email: string | null): Html {
  if (owner.kind === "user") {
    const label = email ?? "Signed in";
    return html`<div class="side-foot">
      <details class="account-menu">
        <summary class="user-chip" aria-label="Account menu">
          <span class="avatar" aria-hidden="true">${(label[0] ?? "?").toUpperCase()}</span>
          <span class="who">${label}</span>
          <svg class="chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M3 10l5-5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </summary>
        <div class="user-menu">
          <p class="menu-email">${label}</p>
          <a class="menu-item" href="/settings">Settings</a>
          <form hx-post="/signout" hx-target="body" hx-swap="none">
            <button type="submit" class="menu-item">Sign out</button>
          </form>
        </div>
      </details>
    </div>`;
  }
  return html`<div class="side-foot">
    ${authButtons()}
    <a class="icon-link" href="/settings" title="Settings" aria-label="Settings"><svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M2 4h7M12 4h2M2 12h2M7 12h7" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10.5" cy="4" r="1.7" stroke="currentColor" stroke-width="1.6"/><circle cx="5.5" cy="12" r="1.7" stroke="currentColor" stroke-width="1.6"/></svg></a>
  </div>`;
}

/** `inline` keeps the buttons beside other content instead of filling a row. */
function authButtons(inline = false): Html {
  return html`<div class="auth-actions${inline ? " auth-actions--inline" : ""}">
      <button type="button" class="btn auth-btn" data-auth-open="signin">Sign in</button>
      <button type="button" class="btn btn--primary auth-btn" data-auth-open="signup">Sign up</button>
    </div>`;
}

/** The settings page's Account section. Anonymous visitors get the same dialog the sidebar opens. */
export function accountSection(owner: Owner, email: string | null): Html {
  if (owner.kind === "user") {
    return html`<div class="account-row">
      <p class="account-who">Signed in as <strong>${email ?? "your account"}</strong></p>
      <form hx-post="/signout" hx-target="body" hx-swap="none">
        <button type="submit" class="btn">Sign out</button>
      </form>
    </div>`;
  }
  return html`<p class="hint">You are browsing anonymously. Your apps and credentials live in this browser's session.</p>
    <div class="account-row">${authButtons(true)}</div>`;
}

function authPane(mode: "signin" | "signup"): Html {
  const signup = mode === "signup";
  return html`<div class="auth-pane" data-pane="${mode}" role="group" aria-labelledby="auth-title-${mode}">
      <h2 id="auth-title-${mode}" class="auth-title">${signup ? "Create your account" : "Welcome back"}</h2>
      <form class="auth-form" hx-post="/${mode}" hx-target="#${mode}-result" hx-swap="innerHTML" hx-disabled-elt="find button">
        <label class="field">Email <input class="auth-input" name="email" type="email" autocomplete="email" required></label>
        <label class="field">${signup ? "Password (8+ characters)" : "Password"} <input class="auth-input" name="password" type="password" autocomplete="${signup ? "new-password" : "current-password"}"${signup && raw(` minlength="8"`)} required></label>
        <button type="submit" class="btn btn--primary auth-submit">${signup ? "Sign up" : "Sign in"}</button>
        <div id="${mode}-result" class="auth-result" role="alert"></div>
      </form>
      <p class="hint">${signup
        ? "Apps you made in this browser so far are moved into your new account."
        : "Apps you made in this browser before signing in stay here; they are not moved into your account."}</p>
      <p class="auth-switch">${signup ? "Already have an account?" : "No account yet?"}
        <button type="button" class="btn-bare link-btn" data-auth-open="${signup ? "signin" : "signup"}">${signup ? "Sign in" : "Sign up"}</button></p>
    </div>`;
}

/** Modal holding both flows; `data-mode` picks the pane. Anonymous owners only. */
export function authDialog(owner: Owner): Html | null {
  if (owner.kind === "user") return null;
  return html`<dialog id="auth-dialog" class="dialog auth-dialog" data-mode="signin" aria-label="Account">
    <button type="button" class="btn-bare auth-close" data-auth-close aria-label="Close">&times;</button>
    ${authPane("signin")}
    ${authPane("signup")}
  </dialog>`;
}
