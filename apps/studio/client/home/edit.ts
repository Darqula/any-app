/** The edit round trip: marking the region being edited, and applying the server's result to the live preview. */
import { onHtmx, targetOf } from "./dom";
import { frameFor } from "./preview";
import { pollNow } from "./poller";
import { invalidate } from "./sidebar";

/**
 * The edit response's data block (editApplied). `type` is "css", "slot-content" or "reload"; the whole object is
 * forwarded to the preview frame as is.
 */
interface EditPayload {
  generationId: string;
  type: string;
  appOrigin: string;
}

/** Posts the applied edit (the JSON block of the edit response) into the preview, pinned to the app's exact origin. */
function applyEdit(): void {
  const block = document.getElementById("edit-payload");
  if (!block?.textContent) return;
  const payload = JSON.parse(block.textContent) as EditPayload;
  const frame = frameFor(payload.generationId);
  if (!frame?.contentWindow) return;
  if (payload.type === "reload") {
    // A shell edit cannot be patched in place: reload the frame (location.reload is blocked cross-origin).
    frame.src = frame.src;
    return;
  }
  frame.contentWindow.postMessage(payload, payload.appOrigin);
}

/** Tells the preview which region is about to change. An auto-routed edit has no target yet, so nothing is sent. */
function freezeTarget(form: HTMLFormElement): void {
  const target = (form.elements.namedItem("target") as HTMLSelectElement | null)?.value;
  if (!target || target === "css" || target === "@shell") return;
  const generationId = /\/generations\/([^/]+)\/edits/.exec(form.getAttribute("hx-post") ?? "")?.[1];
  const frame = generationId ? frameFor(generationId) : null;
  if (!frame?.contentWindow) return;
  // There is no JSON block yet, so the origin comes from the frame's own src.
  frame.contentWindow.postMessage({ channel: "anyapp", type: "slot-pending", id: target }, new URL(frame.src).origin);
}

export function initEdit(): void {
  // The response carries its payload as data. Swapping it into #edit-result applies it; an editProblem response
  // has no payload block, so nothing happens for it.
  onHtmx("htmx:afterSwap", (event) => {
    if (targetOf(event)?.id === "edit-result") applyEdit();
  });

  // An edit leaves the app complete, so its "updating" badge comes from the server's in-memory edit flag: poll
  // shortly after the request starts, and again when it finishes.
  onHtmx("htmx:beforeRequest", (event) => {
    const form = targetOf(event);
    if (!(form instanceof HTMLFormElement) || form.id !== "edit-form") return;
    freezeTarget(form);
    setTimeout(() => void pollNow(), 400);
  });

  onHtmx("htmx:afterRequest", (event) => {
    if (targetOf(event)?.id !== "edit-form") return;
    invalidate();
    void pollNow();
  });
}
