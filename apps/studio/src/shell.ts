import {
  SKELETON_CSS,
  swapRuntime,
  renderSkeletons,
  dataRuntime,
  utilityCss,
  APP_TOKEN_PLACEHOLDER,
} from "@any-app/protocol";
import type { AppPlan } from "@any-app/protocol";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Doctype plus 1KB of padding, sent first and before planning. Standards mode at once, past the browser's initial
 * buffering, and separate so the route can keep the connection alive while planning runs.
 */
export const DOCTYPE_AND_PADDING = `<!doctype html>\n<!--${" ".repeat(1024)}-->\n`;

/**
 * From <html> through the shell script, without the doctype. The data runtime appears only for apps with collections
 * and always with APP_TOKEN_PLACEHOLDER, since the stored row is served to every viewer.
 */
export function renderShellHead(plan: AppPlan, studioOrigin: string): string {
  const data = plan.collections.length > 0 ? `<script>${dataRuntime(APP_TOKEN_PLACEHOLDER)}</script>\n` : "";
  // After <style id="anyapp-css"> and only when the planner has no .hidden: source order is what makes it win.
  const utility = utilityCss(plan.css);
  const utilityStyle = utility ? `<style>${utility}</style>\n` : "";
  return `<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(plan.title)}</title>
<style>${SKELETON_CSS}</style>
<style id="anyapp-css">${plan.css}</style>
${utilityStyle}<script>${swapRuntime(studioOrigin)}</script>
${data}</head>
<body>
${renderSkeletons(plan.shell, plan.slots)}
<script>${plan.script}</script>
`;
}

/** Doctype plus head: a complete replayable head, for persistence and edits (the stream writes the parts separately). */
export function renderFullHead(plan: AppPlan, studioOrigin: string): string {
  return DOCTYPE_AND_PADDING + renderShellHead(plan, studioOrigin);
}

export const SHELL_TAIL = `</body>\n</html>\n`;

/**
 * Live-only, never stored: tells the studio page that visible content has started, so it can drop its planning
 * overlay. A stored document lacks it, and the studio falls back to the frame's load event.
 */
export function firstContentSignal(studioOrigin: string): string {
  return `<script>if (parent !== window) parent.postMessage({ channel: "anyapp", type: "first-content" }, ${JSON.stringify(studioOrigin)});</script>\n`;
}
