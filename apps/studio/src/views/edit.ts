import { html, raw, type Html } from "./escape";
import { editOk } from "./notices";

export function editForm(id: string, slots: { id: string }[]): Html {
  const options = slots.map((s) => html`<option value="${s.id}">${s.id}</option>`);
  // #edit-result is not rendered here: it lives in homePage, and a copy would duplicate the id.
  // Freezing the target region on submit is done in client/home/edit.ts.
  return html`<form id="edit-form" class="composer-row"
    hx-post="/generations/${id}/edits"
    hx-target="#edit-result"
    hx-swap="innerHTML"
    hx-disabled-elt="find button, find input, find select">
    <input class="composer-input" name="instruction" placeholder="Describe a change…" required>
    <select class="composer-select" name="target" title="Which part to change">
      <option value="">Decide for me</option>
      <option value="css">Styling</option>
      <option value="@shell">Page frame (heading, caption, footer)</option>
      ${options}
    </select>
    <button type="submit" class="btn btn--primary composer-submit">Apply</button>
  </form>`;
}

/**
 * Embeds a value as a JSON <script> block, which survives quoting that attributes do not. `<` is escaped so the
 * payload cannot close the block.
 */
function jsonBlock(value: unknown): Html {
  return raw(JSON.stringify(value).replaceAll("<", "\\u003c"));
}

export function editApplied(
  id: string,
  appOrigin: string,
  target: { kind: "css" } | { kind: "shell" } | { kind: "slot"; id: string },
  next: { css: string; content: Record<string, string> },
): Html {
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

  // The payload is data; client/home/edit.ts applies it when this response is swapped into #edit-result.
  return html`<script type="application/json" id="edit-payload">${jsonBlock(payload)}</script>
${editOk(`Updated ${label}.`)}`;
}
