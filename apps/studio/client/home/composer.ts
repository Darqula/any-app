/** The prompt boxes: the create form and the edit form. */
import { byId, onHtmx, targetOf } from "./dom";
import { pollNow } from "./poller";
import { invalidate } from "./sidebar";

type PromptField = HTMLInputElement | HTMLTextAreaElement;

const body = document.body;
const createForm = byId<HTMLFormElement>("create-form");
const createPrompt = createForm.elements.namedItem("prompt") as HTMLTextAreaElement;

/** What each form last submitted, to put back if the request fails. */
const submitted: Record<string, string> = {};

/** The form an htmx event came from, if it is one of the two prompt forms. */
function composerForm(event: Event): HTMLFormElement | null {
  const form = targetOf(event);
  return form instanceof HTMLFormElement && (form.id === "create-form" || form.id === "edit-form") ? form : null;
}

function promptField(form: HTMLFormElement): PromptField | null {
  const name = form.id === "create-form" ? "prompt" : "instruction";
  return form.elements.namedItem(name) as PromptField | null;
}

export function initComposer(): void {
  byId("newapp-btn").addEventListener("click", () => {
    body.classList.add("creating");
    createPrompt.focus();
  });

  // Enter sends and Shift+Enter is a newline. requestSubmit, not submit, keeps htmx and the required validation.
  createPrompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      createForm.requestSubmit();
    }
  });

  // The box clears on submit; htmx has already read the value by then.
  onHtmx("htmx:beforeRequest", (event) => {
    const form = composerForm(event);
    const field = form && promptField(form);
    if (!form || !field) return;
    submitted[form.id] = field.value;
    field.value = "";
  });

  onHtmx("htmx:afterRequest", (event) => {
    const form = composerForm(event);
    if (!form) return;
    const field = promptField(form);
    const ok = !!event.detail?.successful;
    // A failed request puts the text back, unless the user has typed something new meanwhile.
    if (field && !ok && !field.value) field.value = submitted[form.id] ?? "";
    // hx-disabled-elt took the focus with it: restore it unless the user moved elsewhere.
    if (field && ok && document.activeElement === body) field.focus();
    if (form === createForm && ok) {
      // The new row exists server-side already, so the list shows it as pending without a reload.
      invalidate();
      void pollNow();
    }
  });
}
