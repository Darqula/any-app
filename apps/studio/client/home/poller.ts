/**
 * Keeps the sidebar and the conversation current. Polls fast while a row is being generated or edited and slowly
 * otherwise, backs off while nothing changes, and pauses while the tab is hidden.
 */
import { refreshChat } from "./chat";
import { hasLiveRows, refreshList } from "./sidebar";

const FAST_MS = 2000;
const SLOW_MS = 15000;

// Polls in a row that found the list unchanged; stretches the fast interval.
let unchanged = 0;
let timer: ReturnType<typeof setTimeout> | undefined;

async function poll(): Promise<void> {
  const result = await refreshList();
  if (result === "same") unchanged++;
  else if (result === "changed") unchanged = 0;
  await refreshChat();
}

function schedule(): void {
  clearTimeout(timer);
  const delay = hasLiveRows() ? Math.min(SLOW_MS, FAST_MS * (1 + unchanged)) : SLOW_MS;
  timer = setTimeout(() => poll().then(schedule), delay);
}

/** Polls immediately, at the fast pace again, then keeps polling. */
export function pollNow(): Promise<void> {
  unchanged = 0;
  return poll().then(schedule);
}

export function startPolling(): void {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void pollNow();
  });
  schedule();
}
