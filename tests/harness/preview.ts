/**
 * Extracts the generation id AND the Phase 6 view grant from a rendered iframe's `src`
 * attribute — `previewFrame` (apps/studio/src/views.ts) now emits
 * `/preview/<uuid>?g=<grant>"`, not just `/preview/<uuid>"`. Every case that hits
 * `/internal/generations/:id/stream` or `/preview/:id` directly (bypassing the browser,
 * which would otherwise carry the grant for you) needs the grant too — a real generation
 * defaults to `visibility: "private"`, and the internal route 404s a private app with no
 * valid grant for its exact id (see internal.ts and view-grant.ts).
 */
export interface ExtractedPreview {
  id: string;
  /** Already `decodeURIComponent`'d — append as `?g=${grant}` (re-encode) or, more simply,
   *  reuse `queryString()` below. */
  grant: string;
}

export function extractPreview(html: string): ExtractedPreview {
  const match = /\/preview\/([0-9a-f-]{36})\?g=([^"]+)"/.exec(html);
  if (!match) {
    throw new Error(`expected an iframe src containing /preview/<uuid>?g=... in: ${html.slice(0, 500)}`);
  }
  return { id: match[1]!, grant: decodeURIComponent(match[2]!) };
}

/** `?g=<grant>`, ready to append to a URL. */
export function grantQuery(grant: string): string {
  return `?g=${encodeURIComponent(grant)}`;
}
