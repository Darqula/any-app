import type { Generation } from "@any-app/store";
import { isEditing } from "../activity.ts";
import { html, type Html } from "./escape.ts";

/**
 * The sidebar's rows. `isUpdating` defaults to the live edit tracker (activity.ts): an edit leaves the stored status
 * `complete`. Only a complete app can show "updating".
 */
export function generationList(generations: Generation[], isUpdating: (id: string) => boolean = isEditing): Html {
  if (generations.length === 0) {
    return html`<p class="empty">No apps yet. Describe one above.</p>`;
  }
  return html`${generations.map((g) => {
    const state = g.status === "complete" && isUpdating(g.id) ? "updating" : g.status;
    return html`<li class="app-row" data-id="${g.id}">
        <button class="btn-bare app-row-open" hx-get="/generations/${g.id}/frame"
                hx-target="#stage"
                hx-swap="innerHTML">${g.prompt.slice(0, 80)}</button>
        <span class="status status-${state}">${state}</span>
        <button type="button" class="btn-bare app-delete" title="Delete this app" aria-label="Delete this app"
               hx-delete="/generations/${g.id}"
               hx-target="#edit-result"
               hx-swap="innerHTML"
               hx-confirm="Delete this app?">×</button>
      </li>`;
  })}`;
}
