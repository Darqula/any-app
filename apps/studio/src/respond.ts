import type { Response } from "express";
import type { Html } from "./views/index.ts";

/**
 * Sends a view as an HTML response. Views return `Html` objects, and `res.send(object)` would JSON-encode one,
 * so every route sends through here.
 */
export function sendHtml(res: Response, body: Html, status = 200): void {
  res.status(status).type("html").send(body.toString());
}
