/** The conversation panel: open/closed state, and appending new messages as the server records them. */
import { byId, fetchFragment } from "./dom";

const OPEN_KEY = "anyapp.chat.open";
const body = document.body;
const toggle = byId("chat-toggle");
const dot = byId("chat-dot");
let busy = false;

// #chat-log is replaced out-of-band, so it is looked up each time. An empty data-app means no app is open.
function logEl(): HTMLElement | null {
  return document.getElementById("chat-log");
}

function nearBottom(el: HTMLElement): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function scrollToEnd(): void {
  const el = logEl();
  if (el) el.scrollTop = el.scrollHeight;
}

function setOpen(on: boolean): void {
  body.classList.toggle("chat-open", on);
  toggle.setAttribute("aria-expanded", on ? "true" : "false");
  if (on) {
    dot.hidden = true;
    scrollToEnd();
  }
  try {
    localStorage.setItem(OPEN_KEY, on ? "1" : "0");
  } catch {
    // Private mode etc.: not persisted.
  }
}

/** The highest message number the log shows, 0 when empty. */
function lastSeq(log: HTMLElement): number {
  const rows = log.querySelectorAll("li[data-seq]");
  return Number(rows[rows.length - 1]?.getAttribute("data-seq") ?? 0);
}

export function initChat(): void {
  toggle.addEventListener("click", () => setOpen(!body.classList.contains("chat-open")));
  try {
    if (localStorage.getItem(OPEN_KEY) === "1") {
      body.classList.add("chat-open");
      toggle.setAttribute("aria-expanded", "true");
    }
  } catch {
    // Storage unavailable: start collapsed.
  }
}

/** Another app was opened: its log arrived with the stage, so show it from the end. */
export function onAppOpened(): void {
  dot.hidden = true;
  setTimeout(scrollToEnd, 0);
}

/** The open app was deleted. */
export function clearChat(): void {
  const log = logEl();
  if (!log) return;
  log.setAttribute("data-app", "");
  log.innerHTML = "";
}

/** Fetches messages newer than the log's last one, and replaces the transient "working" row. */
export async function refreshChat(): Promise<void> {
  const log = logEl();
  const appId = log?.getAttribute("data-app");
  if (!log || !appId || document.hidden || busy) return;
  busy = true;
  try {
    const html = await fetchFragment("/generations/" + encodeURIComponent(appId) + "/messages?after=" + lastSeq(log));
    const current = logEl();
    // The stage may have switched to another app while this was in flight.
    if (html === null || !current || current.getAttribute("data-app") !== appId) return;
    const stick = nearBottom(current);
    current.querySelector("[data-pending]")?.remove();
    const template = document.createElement("template");
    template.innerHTML = html;
    const added = template.content.querySelectorAll("li[data-seq]").length;
    current.appendChild(template.content);
    if (added && !body.classList.contains("chat-open")) dot.hidden = false;
    if (stick || added) scrollToEnd();
  } catch {
    // Offline or interrupted: the next poll retries.
  } finally {
    busy = false;
  }
}
