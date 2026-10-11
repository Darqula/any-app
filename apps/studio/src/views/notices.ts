import { html, type Html } from "./escape";

// One-line messages, shared by every route and view that answers with a status. They differ only in the CSS class, which
// decides where they are drawn.

/** A failure shown as a toast over the composer (`#edit-result > .edit-problem`). */
export function editProblem(message: string): Html {
  return html`<p class="edit-problem">${message}</p>`;
}

/** A success shown as a toast. */
export function editOk(message: string): Html {
  return html`<p class="edit-ok">${message}</p>`;
}

/** An inline error, e.g. inside the auth dialog (`.problem`). */
export function problem(message: string): Html {
  return html`<p class="problem">${message}</p>`;
}

/** A neutral line for the stage and sidebar placeholders (`.placeholder`). */
export function placeholder(message: string): Html {
  return html`<p class="placeholder">${message}</p>`;
}
