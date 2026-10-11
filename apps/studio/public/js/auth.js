// @ts-check
/** Sign-in / sign-up dialog and the footer account menu. A page may have neither, so both are looked up and guarded. */
(function () {
  "use strict";

  const dialog = /** @type {HTMLDialogElement | null} */ (document.getElementById("auth-dialog"));

  /** @param {string} mode "signin" or "signup" */
  function openDialog(mode) {
    if (!dialog) return;
    dialog.setAttribute("data-mode", mode);
    for (const result of dialog.querySelectorAll(".auth-result")) result.innerHTML = "";
    if (!dialog.open) dialog.showModal();
    const firstInput = /** @type {HTMLInputElement | null} */ (dialog.querySelector(`[data-pane="${mode}"] input`));
    firstInput?.focus();
  }

  /** @param {Node | null} except Menus containing this node stay open. */
  function closeMenus(except) {
    for (const menu of document.querySelectorAll("details.account-menu[open]")) {
      if (!except || !menu.contains(except)) menu.removeAttribute("open");
    }
  }

  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target : null;
    closeMenus(target);
    const trigger = target?.closest("[data-auth-open], [data-auth-close]");
    if (!trigger || !dialog) return;
    if (trigger.hasAttribute("data-auth-close")) dialog.close();
    else openDialog(trigger.getAttribute("data-auth-open") ?? "signin");
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenus(null);
  });

  // A click on the backdrop (the dialog itself) closes.
  dialog?.addEventListener("click", (event) => {
    if (event.target === dialog) dialog.close();
  });
})();
