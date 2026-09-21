/**
 * Inlined into documents that have at least one collection; a dependency-free string like swap-runtime.
 * The one place fetch("/data/...") may appear: generated scripts use window.anyapp.data.
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
 * Stored in generations.document instead of a live token: one stored row serves viewers with
 * different modes. withAppToken substitutes the real token at send time.
 */
export const APP_TOKEN_PLACEHOLDER = "{{ANYAPP_TOKEN}}";

/** split/join, not String.replace: a token containing $& would be read as a replacement pattern. */
export function withAppToken(document: string, token: string): string {
  return document.split(APP_TOKEN_PLACEHOLDER).join(token);
}
