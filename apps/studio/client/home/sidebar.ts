/** The app list in the sidebar: fetched fresh from the server, kept in step with local changes. */
import { byId, fetchFragment } from "./dom";
import { stageAppId } from "./preview";

const list = byId("generation-list");
const confirmDialog = byId<HTMLDialogElement>("confirm-dialog");

let lastHtml: string | null = null;
let refreshing = false;
let rerun = false;
// Bumped by local changes: a fetch that started before one is stale and gets dropped.
let epoch = 0;

/** Call after a local change (create, edit, delete) so an in-flight fetch cannot overwrite it. */
export function invalidate(): void {
  epoch++;
}

/** True while any row is being generated or edited, which is when the list should be polled quickly. */
export function hasLiveRows(): boolean {
  return !!list.querySelector(".status-pending, .status-streaming, .status-updating");
}

/** The highlighted row follows the stage, so this runs after every re-render and every stage change. */
export function markActive(): void {
  const id = stageAppId();
  for (const row of list.querySelectorAll("li")) {
    row.classList.toggle("active", !!id && row.getAttribute("data-id") === id);
  }
}

export type RefreshResult = "changed" | "same" | "skipped";

/** Re-fetches the list and swaps it in if it changed. "skipped" means nothing was fetched or the result was dropped. */
export async function refreshList(): Promise<RefreshResult> {
  // Not while a delete dialog is open: replacing the list would detach the control it holds.
  if (document.hidden || confirmDialog.open) return "skipped";
  // A refresh requested mid-flight may predate the change, so run once more when this one lands.
  if (refreshing) {
    rerun = true;
    return "skipped";
  }
  refreshing = true;
  let result: RefreshResult = "skipped";
  const startedAt = epoch;
  try {
    const html = await fetchFragment("/generations");
    if (html !== null && startedAt === epoch) {
      if (html === lastHtml) {
        result = "same";
      } else {
        result = "changed";
        lastHtml = html;
        list.innerHTML = html;
        htmx.process(list);
        markActive();
      }
    }
  } catch {
    // Offline or interrupted: the next poll retries.
  }
  refreshing = false;
  if (rerun) {
    rerun = false;
    return refreshList();
  }
  return result;
}

/** Drops an app's row at once instead of waiting for the next fetch. */
export function removeApp(id: string): void {
  invalidate();
  for (const row of list.querySelectorAll("li")) {
    if (row.getAttribute("data-id") === id) row.remove();
  }
  if (!list.querySelector("li")) list.innerHTML = '<p class="empty">No apps yet. Describe one above.</p>';
  markActive();
}
