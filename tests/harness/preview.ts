/**
 * Extracts the generation id and the view grant from an iframe src. Cases that call the internal or preview routes
 * directly need the grant, since a real generation is private.
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

export function grantQuery(grant: string): string {
  return `?g=${encodeURIComponent(grant)}`;
}
