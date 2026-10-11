import type { Visibility } from "@any-app/store";
import type { TokenMode } from "@any-app/protocol";
import { html, type Html } from "./escape";
import { HTMX_CONFIG_META, HTMX_SCRIPT, cssLinks } from "./layout";
import { previewFrame } from "./preview";

const VISIBILITY_LABELS: Record<Visibility, string> = {
  private: "Private",
  unlisted: "Unlisted (anyone with the link)",
  public: "Public",
};

/** Owner-only controls in the home page's header slot. `shareUrl` is the plain share link; there is no public gallery. */
export function ownerControls(id: string, visibility: Visibility, shareUrl: string): Html {
  const options = (Object.keys(VISIBILITY_LABELS) as Visibility[]).map(
    (v) => html`<option value="${v}"${v === visibility ? " selected" : ""}>${VISIBILITY_LABELS[v]}</option>`,
  );
  return html`<form id="visibility-form" class="owner-form" hx-post="/generations/${id}/visibility"
    hx-target="#visibility-result" hx-swap="innerHTML">
    <label class="owner-field">Visibility
      <select class="owner-select" name="visibility">${options}</select>
    </label>
    <button class="btn btn--sm">Update</button>
  </form>
  <div id="visibility-result" class="result-inline"></div>
  ${visibility !== "private" && html`<p class="hint">Link: <code>${shareUrl}</code></p>`}`;
}

/**
 * For a non-owner viewer of a shared app. hx-target names an element the share page lacks: harmless,
 * because with hx-swap="none" only the HX-Redirect header matters.
 */
export function remixControl(id: string): Html {
  return html`<form class="owner-form" hx-post="/generations/${id}/fork" hx-target="#stage" hx-swap="none">
    <button class="btn btn--primary btn--sm">Remix this app</button>
  </form>
  <p class="hint">Remixing copies the app, not its data — your copy starts empty.</p>`;
}

/**
 * The page a shared link opens. The frame route's response is a bare htmx fragment (no doctype,
 * stylesheet or htmx), so opened directly it is a small iframe and Remix does nothing.
 */
export function sharedAppPage(id: string, title: string, appOrigin: string, grant: string, mode: TokenMode): Html {
  const controls =
    mode === "ro" ? remixControl(id) : html`<span class="hint">This is your app — open it from your sidebar to edit it.</span>`;
  return html`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
${HTMX_CONFIG_META}
${HTMX_SCRIPT}
${cssLinks(["owner-controls", "shared"])}
</head>
<body class="page-shared">
  <header class="shared-header">
    <a class="brand" href="/"><span class="brand-mark"></span>any-app</a>
    <div class="owner-controls">
      ${controls}
    </div>
  </header>
  <div class="preview-wrap">${previewFrame(id, appOrigin, grant)}</div>
</body>
</html>`;
}

export function notFoundPage(): Html {
  return html`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found</title>
${cssLinks(["shared"])}</head>
<body class="page-not-found"><p>Not found.</p></body>
</html>`;
}
