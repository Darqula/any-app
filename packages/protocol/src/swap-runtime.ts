/**
 * Inlined into every generated document. Must stay dependency-free and parse cleanly in an
 * old parser — it is a string, not a module, and nothing bundles it.
 *
 * Three jobs:
 *
 *  - A <script> moved out of a <template> by DOM insertion never executes. Slot content is
 *    allowed to carry its own script, so each one is re-created as a fresh element.
 *  - Slot content lands long after the shell script ran, so the shell cannot bind to it
 *    directly. Every fill fires a `slot:ready` event the shell can listen for.
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
    document.dispatchEvent(
      new CustomEvent("slot:ready", { detail: { id: slot.id.slice(5) } })
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
