import { html, raw, type Html } from "./escape";

/** Stylesheets under public/css. A name that is not listed here does not compile, instead of 404ing quietly. */
export type CssName =
  | "theme" | "base" | "components"
  | "home" | "sidebar" | "workspace" | "auth" | "owner-controls" | "settings" | "shared";

/** Loaded first on every page: the tokens, the element defaults, then the shared components. */
const COMMON: readonly CssName[] = ["theme", "base", "components"];

export type ScriptName = "auth" | "home";

/** `<link>`s for a page: the common sheets, then the page's own. */
export function cssLinks(names: readonly CssName[]): Html {
  return raw([...COMMON, ...names].map((n) => `<link rel="stylesheet" href="/css/${n}.css">`).join("\n"));
}

export function scriptTag(name: ScriptName): Html {
  return raw(`<script src="/js/${name}.js"></script>`);
}

/**
 * htmx skips 4xx/5xx bodies by default, which hides every user-facing error. Swap them, keeping error:true.
 * A <meta>, not a script, so there is no load-order dependency.
 */
export const HTMX_CONFIG_META = raw(
  `<meta name="htmx-config" content='{"responseHandling":[{"code":"204","swap":false},{"code":"[23]..","swap":true},{"code":"[45]..","swap":true,"error":true}]}'>`,
);

export const HTMX_SCRIPT = raw(`<script src="https://cdnjs.cloudflare.com/ajax/libs/htmx/2.0.4/htmx.min.js"></script>`);

/**
 * Composer and owner controls live outside #stage but belong to the app it shows, so they arrive
 * out-of-band. No content clears the slot.
 */
export function oobSlot(id: "edit-slot" | "owner-slot", content?: Html): Html {
  return html`<div id="${id}" hx-swap-oob="innerHTML">${content}</div>`;
}
