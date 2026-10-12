/** The preview iframe on the stage: finding it, and hiding its planning overlay once the app has content. */
import { targetOf } from "./dom";

export function stageFrame(): HTMLIFrameElement | null {
  return document.querySelector<HTMLIFrameElement>("#stage iframe");
}

/** The id of the app the stage shows, or "" when it shows none. */
export function stageAppId(): string {
  const frame = stageFrame();
  return frame ? (new URL(frame.src).pathname.split("/")[2] ?? "") : "";
}

/**
 * The stage's iframe, only if it still shows generationId: a slow edit can land after the user opened
 * another app, and slot ids repeat across apps.
 */
export function frameFor(generationId: string): HTMLIFrameElement | null {
  const frame = stageFrame();
  if (!frame || !generationId || !frame.src.includes(generationId)) return null;
  return frame;
}

function hideWait(frame: Element): void {
  const wait = frame.parentNode?.querySelector<HTMLElement>(".preview-wait");
  if (wait) wait.hidden = true;
}

/** The overlay goes at the document's first-content signal, or at its load when the document sends none. */
export function initPreview(): void {
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.channel !== "anyapp" || data.type !== "first-content") return;
    for (const frame of document.querySelectorAll<HTMLIFrameElement>("iframe.preview")) {
      // Only the frame that sent it, and only from its own origin.
      if (frame.contentWindow === event.source && new URL(frame.src).origin === event.origin) hideWait(frame);
    }
  });

  // load does not bubble, but a capturing listener still sees every iframe's.
  document.addEventListener(
    "load",
    (event) => {
      const frame = targetOf(event);
      if (frame?.tagName === "IFRAME") hideWait(frame);
    },
    true,
  );
}
