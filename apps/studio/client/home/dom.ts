/** Small DOM and htmx helpers shared by the home page modules. */

/** What htmx puts in `event.detail`, as far as this page reads it. */
export interface HtmxDetail {
  pathInfo?: { requestPath?: string };
  requestConfig?: { verb?: string };
  xhr?: XMLHttpRequest;
  successful?: boolean;
  /** htmx:confirm only. */
  question?: string;
  /** htmx:confirm only. */
  elt?: Element;
  /** htmx:confirm only. */
  issueRequest?: (skipConfirm?: boolean) => void;
}

export type HtmxEvent = CustomEvent<HtmxDetail>;

/** An element the page is built around; throws at load, not at first use, if the markup lacks it. */
export function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error("home: missing #" + id);
  return el as T;
}

/** Listens on the body for an htmx event, with `event.detail` typed. */
export function onHtmx(name: string, handler: (event: HtmxEvent) => void): void {
  document.body.addEventListener(name, (event) => handler(event as HtmxEvent));
}

export function targetOf(event: Event): Element | null {
  return event.target instanceof Element ? event.target : null;
}

/** The request's HTTP verb in lower case, e.g. "get". */
export function verbOf(event: HtmxEvent): string {
  return String(event.detail?.requestConfig?.verb ?? "").toLowerCase();
}

/** The request's path, e.g. "/generations". */
export function pathOf(event: HtmxEvent): string {
  return event.detail?.pathInfo?.requestPath ?? "";
}

/** Fetches an HTML fragment fresh; null when the server answered with an error. */
export async function fetchFragment(url: string): Promise<string | null> {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  return res.ok ? res.text() : null;
}
