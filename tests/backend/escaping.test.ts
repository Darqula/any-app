/**
 * A7 — Escaping helpers: errorBanner, escapeHtml.
 * Spec: .docs/tests-backend.md section A7.
 *
 * `errorBanner` lives in packages/protocol/src/index.ts and is exported directly — imported
 * by package name below.
 *
 * `escapeHtml` (the spec: "find them; views.ts is one home") exists as TWO separate
 * module-private functions — apps/studio/src/views.ts and apps/studio/src/shell.ts — neither
 * exported. The spec names the views.ts one specifically, which is also the one that
 * escapes `"` (shell.ts's copy does not — it is used only inside a `<title>` text node, not
 * an attribute, so it has no need to). Since it is not exported, it cannot be imported
 * directly without a production-code change; it IS exercised indirectly through
 * `previewFrame` (exported from views.ts), which interpolates `appOrigin` and `id` into a
 * double-quoted `src="..."` attribute via this exact function. That is a real attribute
 * context, which is what A7.2 is actually pinning down.
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
  const out = previewFrame("abc", malicious);

  // The raw quote must never survive into the attribute — that would let the value break
  // out of `src="..."` and inject a sibling attribute or element.
  assert.equal(out.includes(malicious), false);
  assert.ok(out.includes("&quot;"));
  assert.ok(out.includes("&lt;script&gt;"));
  assert.equal(out.includes("<script>alert(1)</script>"), false);

  // The src attribute itself stays syntactically a single, well-formed attribute: exactly
  // one `src="` open, and the very next `"` after it is the one views.ts's own template
  // literal supplies (immediately before `/preview/`), not one smuggled in via appOrigin.
  const srcStart = out.indexOf('src="') + 'src="'.length;
  const srcEnd = out.indexOf('"', srcStart);
  const srcValue = out.slice(srcStart, srcEnd);
  assert.ok(srcValue.endsWith("/preview/abc"));
  assert.equal(srcValue.includes('"'), false);
});
