import { html, type Html } from "./escape";

/**
 * `grant` is the view grant: minted by the caller, forwarded blind by the sandbox. `planning` adds the overlay shown
 * until the frame's first content, for a frame that will start a generation.
 */
export function previewFrame(id: string, appOrigin: string, grant: string, planning = false): Html {
  // allow-same-origin is safe only because each app has its own origin; on a shared
  // origin every app could read every other's storage.
  const frame = html`<iframe
    class="preview"
    src="${appOrigin}/preview/${id}?g=${encodeURIComponent(grant)}"
    sandbox="allow-scripts allow-forms allow-popups allow-same-origin"
    title="Generated app preview"></iframe>`;
  if (!planning) return frame;
  return html`${frame}<div class="preview-wait" role="status">
    <span class="wait-spinner" aria-hidden="true"></span>
    <p class="wait-title">Planning your app…</p>
    <p class="wait-hint">The layout appears once the plan is ready. Reasoning models can take a few minutes.</p>
  </div>`;
}
