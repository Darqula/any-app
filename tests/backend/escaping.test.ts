/**
 * A7: errorBanner and escapeHtml. escapeHtml is private to views.ts, so it is exercised through previewFrame,
 * which interpolates appOrigin and id into a quoted src attribute: the real attribute context A7.2 pins.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { errorBanner } from "@any-app/protocol";
import { previewFrame } from "../../apps/studio/src/views";

test("A7.1 — errorBanner with <script> in the message: escaped, cannot break out of the <pre>", () => {
  const out = errorBanner("<script>alert(1)</script>");
  assert.equal(out.includes("<script>alert(1)</script>"), false);
  assert.ok(out.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  // Still wrapped in exactly one <pre>...</pre> — the escaped payload cannot close it early.
  assert.equal((out.match(/<pre/g) ?? []).length, 1);
  assert.equal((out.match(/<\/pre>/g) ?? []).length, 1);
});

test('A7.2 — escapeHtml (views.ts, via previewFrame) escapes a " in an attribute context', () => {
  const malicious = 'http://evil"><script>alert(1)</script>';
  const out = previewFrame("abc", malicious, "harmless-grant");

  // The raw quote must never survive into the attribute — that would let the value break
  // out of `src="..."` and inject a sibling attribute or element.
  assert.equal(out.includes(malicious), false);
  assert.ok(out.includes("&quot;"));
  assert.ok(out.includes("&lt;script&gt;"));
  assert.equal(out.includes("<script>alert(1)</script>"), false);

  // The src stays one well-formed attribute: exactly one `src="` and the next `"` is the template's own, not one smuggled in through appOrigin.
  const srcStart = out.indexOf('src="') + 'src="'.length;
  const srcEnd = out.indexOf('"', srcStart);
  const srcValue = out.slice(srcStart, srcEnd);
  assert.ok(srcValue.endsWith("/preview/abc?g=harmless-grant"));
  assert.equal(srcValue.includes('"'), false);
});
