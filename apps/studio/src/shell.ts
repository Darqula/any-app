import { SKELETON_CSS, swapRuntime, renderSkeletons } from "@any-app/protocol";
import type { AppPlan } from "@any-app/protocol";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * Everything up to and including the shell script. Sent as one write, so the browser gets
 * a complete, painted layout in a single flush.
 *
 * The 1KB padding from Phase 1 is no longer needed — this block is comfortably past the
 * browser's initial buffer on its own — but the doctype must still come first.
 *
 * `studioOrigin` is baked into the swap runtime so it can validate `postMessage` edits —
 * see `swapRuntime`'s doc comment. The stylesheet gets an id so an edit's `css` message can
 * find and replace it.
 */
export function renderShellHead(plan: AppPlan, studioOrigin: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(plan.title)}</title>
<style>${SKELETON_CSS}</style>
<style id="anyapp-css">${plan.css}</style>
<script>${swapRuntime(studioOrigin)}</script>
</head>
<body>
${renderSkeletons(plan.shell, plan.slots)}
<script>${plan.script}</script>
`;
}

export const SHELL_TAIL = `</body>\n</html>\n`;
