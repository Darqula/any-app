import { SKELETON_CSS, swapRuntime, renderSkeletons, dataRuntime } from "@any-app/protocol";
import type { AppPlan } from "@any-app/protocol";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * The doctype plus 1KB of padding, sent as the very first bytes of a generation response —
 * before planning even starts (see internal.ts's heartbeat). Two jobs: puts the browser in
 * standards mode immediately, and gets past the ~1KB a browser buffers before it starts
 * parsing at all, so *something* is visibly happening from byte one. Kept separate from
 * `renderShellHead` so the route can send it up front and keep the connection demonstrably
 * alive (a periodic comment) while `planApp` is still running — a doctype arriving after
 * five minutes of silence is a connection undici has probably already killed.
 */
export const DOCTYPE_AND_PADDING = `<!doctype html>\n<!--${" ".repeat(1024)}-->\n`;

/**
 * Everything from `<html>` up to and including the shell script. Deliberately does NOT
 * include the doctype — see `DOCTYPE_AND_PADDING` — so a second, redundant doctype is never
 * written after planning succeeds.
 *
 * `studioOrigin` is baked into the swap runtime so it can validate `postMessage` edits —
 * see `swapRuntime`'s doc comment. The stylesheet gets an id so an edit's `css` message can
 * find and replace it.
 *
 * `appToken` is only ever emitted when the app has collections — a static app should not
 * carry a data-API token it never uses. Both call sites (internal.ts, edits.ts) mint it from
 * the generation id, so it is deliberately the same string every time this app is rendered;
 * see `mintAppToken`'s doc comment for why that matters.
 */
export function renderShellHead(plan: AppPlan, studioOrigin: string, appToken: string): string {
  const data = plan.collections.length > 0 ? `<script>${dataRuntime(appToken)}</script>\n` : "";
  return `<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(plan.title)}</title>
<style>${SKELETON_CSS}</style>
<style id="anyapp-css">${plan.css}</style>
<script>${swapRuntime(studioOrigin)}</script>
${data}</head>
<body>
${renderSkeletons(plan.shell, plan.slots)}
<script>${plan.script}</script>
`;
}

/**
 * `DOCTYPE_AND_PADDING` + `renderShellHead` — a complete, replayable document head. Used
 * wherever a document is being *rendered as a finished whole* (persistence, edits) rather
 * than *streamed live* (internal.ts writes the two pieces separately there, with the
 * heartbeat in between).
 */
export function renderFullHead(plan: AppPlan, studioOrigin: string, appToken: string): string {
  return DOCTYPE_AND_PADDING + renderShellHead(plan, studioOrigin, appToken);
}

export const SHELL_TAIL = `</body>\n</html>\n`;
