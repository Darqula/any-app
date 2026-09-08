/**
 * Inlined into every generated document. Must stay dependency-free and parse cleanly in an
 * old parser — it is a string, not a module, and nothing bundles it.
 *
 * Three jobs:
 *
 *  - A <script> parsed via the *fragment*-parsing algorithm (`element.innerHTML = ...`,
 *    which the postMessage edit path below uses to turn `msg.html` into a template) has its
 *    "already started" flag set at parse time and will never auto-execute once moved into
 *    the document — that is standard HTML behaviour. (A <script> the *document* parser put
 *    inside a <template> — the initial-fill path's `swap()` — does NOT have that flag set,
 *    and would in fact run on its own the moment its content is moved into the live
 *    document; testing-review.md's S6 has the measurements. `rerunScripts` below runs
 *    unconditionally on both paths regardless, since re-creating an already-working script
 *    element is harmless and keeping one path special-cased is not worth the risk.) Slot
 *    content is allowed to carry its own script, so each one is re-created as a fresh
 *    element, which resets that flag and lets it run.
 *  - Slot content lands long after the shell script ran, so the shell cannot bind to it
 *    directly. Every fill fires a `slot:ready` event the shell can listen for. The detail
 *    carries both `id` and `element`; `element` looks redundant next to an id that already
 *    identifies the slot, but generated shell scripts demonstrably reach for it directly
 *    (`e.detail.element.querySelector(...)`) — two apps in the 2026-09-07 sweep threw
 *    "Cannot read properties of undefined" and lost their whole shell script when it was
 *    missing. Handing over the element the runtime already has is cheaper than making every
 *    shell re-resolve an id itself. Regression guard: testing-review.md S15, D10 in
 *    tests/frontend/swap-runtime.spec.ts.
 *  - The generation response closes when generation ends, so later edits arrive by
 *    postMessage from the studio page instead.
 *
 * `studioOrigin` is baked in and checked on every message. Without that check any page that
 * embeds a preview URL could inject markup into it. That is low-impact today, because the
 * frame runs on an opaque origin — it stops being low-impact the moment locked decision #8
 * gives apps real per-app origins with storage.
 */
export function swapRuntime(studioOrigin: string): string {
  return `
(function () {
  var STUDIO_ORIGIN = ${JSON.stringify(studioOrigin)};

  function rerunScripts(root) {
    var scripts = root.querySelectorAll("script");
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i];
      var fresh = document.createElement("script");
      for (var a = 0; a < old.attributes.length; a++) {
        fresh.setAttribute(old.attributes[a].name, old.attributes[a].value);
      }
      fresh.textContent = old.textContent;
      old.parentNode.replaceChild(fresh, old);
    }
  }

  function fill(slot, fragment) {
    slot.replaceChildren(fragment);
    slot.classList.remove("anyapp-skeleton");
    slot.style.minHeight = "";
    rerunScripts(slot);
    // \`element\` is not redundant with \`id\` — see the doc comment above (S15/D10).
    document.dispatchEvent(
      new CustomEvent("slot:ready", { detail: { id: slot.id.slice(5), element: slot } })
    );
  }

  function swap(id) {
    var tpl = document.getElementById("c-" + id);
    var slot = document.getElementById("slot-" + id);
    if (!tpl || !slot) return;
    var fragment = tpl.content;
    tpl.remove();
    fill(slot, fragment);
  }
  window.swap = swap;

  window.addEventListener("message", function (event) {
    if (event.origin !== STUDIO_ORIGIN) return;
    var msg = event.data;
    if (!msg || msg.channel !== "anyapp") return;

    if (msg.type === "slot-pending") {
      var pending = document.getElementById("slot-" + msg.id);
      if (!pending) return;
      // Freeze the current height before emptying it, so the page does not collapse and
      // jump while the replacement is being generated.
      pending.style.minHeight = pending.offsetHeight + "px";
      pending.replaceChildren();
      pending.classList.add("anyapp-skeleton");
      return;
    }

    if (msg.type === "slot-content") {
      var slot = document.getElementById("slot-" + msg.id);
      if (!slot) return;
      var holder = document.createElement("template");
      holder.innerHTML = msg.html;
      fill(slot, holder.content);
      return;
    }

    if (msg.type === "css") {
      var style = document.getElementById("anyapp-css");
      if (style) style.textContent = msg.css;
      return;
    }
  });
})();
`.trim();
}
