/**
 * Inlined into every generated document that has at least one collection (see
 * `shell.ts`'s `renderShellHead` — a static app carries no token and no data runtime at
 * all). Dependency-free, same constraints as `swap-runtime.ts`: it is a string, not a
 * module, and nothing bundles it.
 *
 * The model must not write its own HTTP wrapper — see impl-phase-5.md step 7. This is the
 * one place `fetch("/data/...")` is allowed to appear; a generated app's own script talks to
 * `window.anyapp.data` instead.
 *
 * The token is a plain string in the document. That is not a leak to plug — see
 * impl-phase-5.md's "be blunt about what this phase does not do". Do not add obfuscation
 * that suggests otherwise. From Phase 6, what actually lands here at render time is either a
 * live token (rw for the owner, ro for a shared viewer) or, in the row `generations.document`
 * persists, `APP_TOKEN_PLACEHOLDER` — see `withAppToken` below.
 */
export function dataRuntime(token: string): string {
  return `
(function () {
  var TOKEN = ${JSON.stringify(token)};

  function call(method, path, body) {
    return fetch("/data" + path, {
      method: method,
      headers: body
        ? { "authorization": "Bearer " + TOKEN, "content-type": "application/json" }
        : { "authorization": "Bearer " + TOKEN },
      body: body ? JSON.stringify(body) : undefined
    }).then(function (res) {
      if (res.status === 204) return null;
      return res.json().then(function (payload) {
        if (!res.ok) throw new Error(payload && payload.error || ("HTTP " + res.status));
        return payload;
      });
    });
  }

  function query(where, limit) {
    var parts = [];
    for (var k in where || {}) {
      parts.push("where[" + encodeURIComponent(k) + "]=" + encodeURIComponent(where[k]));
    }
    if (limit) parts.push("limit=" + limit);
    return parts.length ? "?" + parts.join("&") : "";
  }

  window.anyapp = window.anyapp || {};
  window.anyapp.data = {
    create: function (c, data) { return call("POST", "/" + c, data); },
    list:   function (c, where, limit) { return call("GET", "/" + c + query(where, limit)); },
    get:    function (c, id) { return call("GET", "/" + c + "/" + id); },
    update: function (c, id, patch) { return call("PATCH", "/" + c + "/" + id, patch); },
    remove: function (c, id) { return call("DELETE", "/" + c + "/" + id); }
  };
})();
`;
}

/**
 * What is stored in `generations.document` in place of a live token. `renderShellHead`
 * always emits `dataRuntime(APP_TOKEN_PLACEHOLDER)` — a stored document must never carry a
 * live token, because the SAME stored row is served to every viewer, and viewers get
 * different modes (owner: rw, shared visitor: ro). `withAppToken` below substitutes the
 * real, per-viewer token at send time. Must not appear in any generated app's own content —
 * the braces and the prefix make that effectively impossible.
 */
export const APP_TOKEN_PLACEHOLDER = "{{ANYAPP_TOKEN}}";

/**
 * Do NOT use `String.replace(placeholder, token)`. This project has already shipped a `$&`
 * corruption bug where a replacement string containing `$&` spliced an entire matched block
 * into a JS string literal (see impl-phase-3.md). `split`/`join` has no such interpretation.
 */
export function withAppToken(document: string, token: string): string {
  return document.split(APP_TOKEN_PLACEHOLDER).join(token);
}
