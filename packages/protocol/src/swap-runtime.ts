/**
 * Inlined into every generated document. Must stay dependency-free and parse cleanly in
 * an old parser — it is a string, not a module, and nothing bundles it.
 *
 * Two non-obvious jobs:
 *
 *  - A <script> moved out of a <template> by DOM insertion never executes. Slot content is
 *    allowed to carry its own script, so each one is re-created as a fresh element.
 *  - Slot content lands long after the shell script ran, so the shell cannot bind to it
 *    directly. Every swap fires a `slot:ready` event the shell can listen for.
 */
export const SWAP_RUNTIME = `
(function () {
  function swap(id) {
    var tpl = document.getElementById("c-" + id);
    var slot = document.getElementById("slot-" + id);
    if (!tpl || !slot) return;
    slot.replaceChildren(tpl.content);
    slot.classList.remove("anyapp-skeleton");
    slot.style.minHeight = "";
    tpl.remove();
    var scripts = slot.querySelectorAll("script");
    for (var i = 0; i < scripts.length; i++) {
      var old = scripts[i];
      var fresh = document.createElement("script");
      for (var a = 0; a < old.attributes.length; a++) {
        fresh.setAttribute(old.attributes[a].name, old.attributes[a].value);
      }
      fresh.textContent = old.textContent;
      old.parentNode.replaceChild(fresh, old);
    }
    document.dispatchEvent(new CustomEvent("slot:ready", { detail: { id: id } }));
  }
  window.swap = swap;
})();
`.trim();
