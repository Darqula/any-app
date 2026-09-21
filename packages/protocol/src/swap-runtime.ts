/**
 * Inlined into every generated document, so it must stay dependency-free: it is a string, not a module.
 * Fills slots (running slot scripts exactly once: swap() and the postMessage path differ), fires
 * slot:ready with { id, element }, and applies edits from the studio via postMessage, checked
 * against studioOrigin.
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

  function fill(slot, fragment, needsRerun) {
    slot.replaceChildren(fragment);
    slot.classList.remove("anyapp-skeleton");
    slot.style.minHeight = "";
    // A <template> fragment (swap) runs its scripts on insertion; an innerHTML fragment (postMessage path)
    // marks them already started, so only that one needs them recreated. Rerunning both runs scripts twice.
    if (needsRerun) rerunScripts(slot);
    // element looks redundant next to id, but generated shell scripts read e.detail.element directly.
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
    fill(slot, fragment, false);
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
      fill(slot, holder.content, true);
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
