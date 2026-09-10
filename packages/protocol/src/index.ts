export const INTERNAL_SECRET_HEADER = "x-internal-secret";

export * from "./slots";
export { swapRuntime } from "./swap-runtime";
export { dataRuntime, APP_TOKEN_PLACEHOLDER, withAppToken } from "./data-runtime";
export { mintAppToken, verifyAppToken, UUID_PATTERN } from "./app-token";
export type { TokenMode } from "./app-token";
export { mintViewGrant, verifyViewGrant, VIEW_GRANT_TTL_MS } from "./view-grant";

/** Written into the streamed document when generation fails partway through. */
export function errorBanner(message: string): string {
  const escaped = message
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
  return `<pre style="white-space:pre-wrap;color:#b00020;font:14px ui-monospace,monospace;padding:16px;border:1px solid #b00020;margin:16px">Generation failed: ${escaped}</pre>`;
}
