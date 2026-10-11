/**
 * How the views escape. Interpolating into `html` escapes plain strings, numbers and array items. Markup that is
 * already safe is an `Html`, which only `html` and `raw` produce; a plain string is never accepted as one (the `#`
 * field makes the class nominal), so a fragment is never escaped twice and user text is never embedded raw.
 * This covers element text and quoted attributes only: never put data in `<script>`, `<style>`, unquoted
 * attributes or URLs.
 */
export class Html {
  readonly #markup: string;

  /** @internal Use `html` or `raw`; `new Html` skips both. */
  constructor(markup: string) {
    this.#markup = markup;
  }

  toString(): string {
    return this.#markup;
  }

  /** Markup is not data: without this, `res.send(html)` would silently send `{}`. Use `sendHtml`. */
  toJSON(): never {
    throw new Error("Html is markup, not data: send it with sendHtml");
  }
}

/** Marks a string as safe markup. Static literals and JSON data blocks only, never text from users, models or the database. */
export function raw(markup: string): Html {
  return new Html(markup);
}

function escapeText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/** What may be interpolated. Booleans, null and undefined render as nothing, so `${cond && x}` works. */
export type HtmlValue = string | number | boolean | null | undefined | Html | readonly HtmlValue[];

function stringify(value: HtmlValue): string {
  if (Array.isArray(value)) return value.map(stringify).join("");
  if (value === null || value === undefined || typeof value === "boolean") return "";
  if (value instanceof Html) return value.toString();
  return escapeText(String(value));
}

export function html(strings: TemplateStringsArray, ...values: HtmlValue[]): Html {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += stringify(values[i]!) + (strings[i + 1] ?? "");
  }
  return new Html(out);
}

/** Concatenates fragments, e.g. several out-of-band swaps in one response. */
export function join(...parts: Html[]): Html {
  return new Html(parts.join(""));
}
