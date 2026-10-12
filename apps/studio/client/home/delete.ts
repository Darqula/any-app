/** Deleting an app: the confirmation dialog, then removing it from the page. */
import { byId, onHtmx, pathOf, verbOf } from "./dom";
import { frameFor } from "./preview";
import { pollNow } from "./poller";
import { removeApp } from "./sidebar";
import { showEmptyStage } from "./stage";

const confirmDialog = byId<HTMLDialogElement>("confirm-dialog");

export function initDelete(): void {
  // A custom dialog instead of window.confirm: cancel htmx's own confirm, then issue the request on Delete.
  onHtmx("htmx:confirm", (event) => {
    const { question, elt, issueRequest } = event.detail;
    if (!question || !elt || !issueRequest || !confirmDialog.showModal) return;
    event.preventDefault();
    byId("confirm-title").textContent = question;
    byId("confirm-name").textContent = elt.closest("li")?.querySelector(".app-row-open")?.textContent ?? "";
    confirmDialog.returnValue = "cancel";
    confirmDialog.addEventListener("close", function onClose() {
      confirmDialog.removeEventListener("close", onClose);
      if (confirmDialog.returnValue === "delete") issueRequest(true);
    });
    confirmDialog.showModal();
  });

  // A click on the backdrop (the dialog itself) cancels.
  confirmDialog.addEventListener("click", (event) => {
    if (event.target === confirmDialog) confirmDialog.close("cancel");
  });

  // Deleted (200) or already gone (404): drop the row, and reset the stage if that app was open.
  // Anything else (409) keeps the row; the toast already shows the message.
  onHtmx("htmx:afterRequest", (event) => {
    const status = event.detail?.xhr?.status ?? 0;
    if (verbOf(event) !== "delete" || (status !== 200 && status !== 404)) return;
    const id = pathOf(event).split("/").pop() ?? "";
    if (frameFor(id)) showEmptyStage();
    removeApp(id);
    void pollNow();
  });
}
