/** The stage (preview area): opening an app, the streaming state of a new one, and resetting it when empty. */
import { byId, onHtmx, pathOf, targetOf, verbOf } from "./dom";
import { clearChat, onAppOpened } from "./chat";
import { stageFrame } from "./preview";
import { pollNow } from "./poller";
import { markActive } from "./sidebar";

const body = document.body;

function setStreaming(on: boolean): void {
  body.classList.toggle("streaming", on);
}

/** Back to the empty state, with the composer in create mode. */
export function showEmptyStage(): void {
  byId("stage").innerHTML = '<p class="placeholder">Your app will appear here.</p>';
  byId("edit-slot").innerHTML = "";
  byId("owner-slot").innerHTML = "";
  clearChat();
  body.classList.add("creating");
  setStreaming(false);
}

export function initStage(): void {
  onHtmx("htmx:afterSwap", (event) => {
    if (targetOf(event)?.id !== "stage") return;
    const path = pathOf(event);
    const verb = verbOf(event);

    if (verb === "get" && path.endsWith("/frame")) {
      // Picking an app from the list: the composer switches to edit mode.
      body.classList.remove("creating");
      setStreaming(false);
      markActive();
      onAppOpened();
    } else if (verb === "post" && path === "/generations") {
      // Creating: the response is the streaming iframe, and its load event means the document has arrived.
      const frame = stageFrame();
      setStreaming(!!frame);
      frame?.addEventListener("load", () => {
        setStreaming(false);
        void pollNow();
      });
    }
  });
}
