// @ts-check
/** The studio home page: live sidebar, conversation panel, composer, delete confirmation and the edit round trip. */
(function () {
  "use strict";

  /**
   * What htmx puts in `event.detail`, as far as this page reads it.
   * @typedef {object} HtmxDetail
   * @property {{ requestPath?: string }} [pathInfo]
   * @property {{ verb?: string }} [requestConfig]
   * @property {XMLHttpRequest} [xhr]
   * @property {boolean} [successful]
   * @property {string} [question] htmx:confirm only
   * @property {Element} [elt] htmx:confirm only
   * @property {(skipConfirm?: boolean) => void} [issueRequest] htmx:confirm only
   */

  /**
   * The edit response's data block (editApplied). `type` is "css", "slot-content" or "reload"; the other fields
   * are forwarded to the preview frame as is.
   * @typedef {object} EditPayload
   * @property {string} generationId
   * @property {string} type
   * @property {string} appOrigin
   */

  // ---- Helpers ----

  /** @param {string} id @return {HTMLElement} */
  function byId(id) {
    const el = document.getElementById(id);
    if (!el) throw new Error("home.js: missing #" + id);
    return el;
  }

  /**
   * Listens on the body for an htmx event, with `event.detail` typed.
   * @param {string} name
   * @param {(event: CustomEvent<HtmxDetail>) => void} handler
   */
  function onHtmx(name, handler) {
    document.body.addEventListener(name, (event) => handler(/** @type {CustomEvent<HtmxDetail>} */ (event)));
  }

  /** @param {Event} event @return {Element | null} */
  function targetOf(event) {
    return event.target instanceof Element ? event.target : null;
  }

  /** @param {CustomEvent<HtmxDetail>} event @return {string} */
  function verbOf(event) {
    return String(event.detail?.requestConfig?.verb ?? "").toLowerCase();
  }

  /** @param {CustomEvent<HtmxDetail>} event @return {string} */
  function pathOf(event) {
    return event.detail?.pathInfo?.requestPath ?? "";
  }

  /** @return {HTMLIFrameElement | null} */
  function stageFrame() {
    return /** @type {HTMLIFrameElement | null} */ (document.querySelector("#stage iframe"));
  }

  /**
   * The stage's iframe, only if it still shows generationId: a slow edit can land after the user opened
   * another app, and slot ids repeat across apps.
   * @param {string} generationId
   * @return {HTMLIFrameElement | null}
   */
  function frameFor(generationId) {
    const frame = stageFrame();
    if (!frame || !generationId || !frame.src.includes(generationId)) return null;
    return frame;
  }

  /**
   * Fetches an HTML fragment fresh; null when the server answered with an error.
   * @param {string} url
   * @return {Promise<string | null>}
   */
  async function fetchFragment(url) {
    const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
    return res.ok ? res.text() : null;
  }

  const body = document.body;
  const list = byId("generation-list");
  const confirmDialog = /** @type {HTMLDialogElement} */ (byId("confirm-dialog"));
  const createForm = /** @type {HTMLFormElement} */ (byId("create-form"));
  const prompt = /** @type {HTMLTextAreaElement} */ (createForm.elements.namedItem("prompt"));

  /** @param {boolean} on */
  function setStreaming(on) {
    body.classList.toggle("streaming", on);
  }

  // ---- Preview bridge: edits and the planning overlay ----

  // Posts an applied edit (the JSON block from editApplied) into the preview, pinned to the app's exact origin.
  function applyEdit() {
    const block = document.getElementById("edit-payload");
    if (!block?.textContent) return;
    const payload = /** @type {EditPayload} */ (JSON.parse(block.textContent));
    const frame = frameFor(payload.generationId);
    if (!frame?.contentWindow) return;
    if (payload.type === "reload") {
      // A shell edit cannot be patched in place: reload the frame (location.reload is blocked cross-origin).
      frame.src = frame.src;
      return;
    }
    frame.contentWindow.postMessage(payload, payload.appOrigin);
  }

  // The edit response carries its payload as data. Swapping it into #edit-result applies it; an
  // editProblem response has no payload block, so this does nothing for it.
  onHtmx("htmx:afterSwap", (event) => {
    if (targetOf(event)?.id === "edit-result") applyEdit();
  });

  // Freezes the target region as soon as an explicit slot edit is submitted. An auto-routed edit has no target yet.
  /** @param {HTMLFormElement} form */
  function freezeEditTarget(form) {
    const target = /** @type {HTMLSelectElement | null} */ (form.elements.namedItem("target"))?.value;
    if (!target || target === "css" || target === "@shell") return;
    const generationId = /\/generations\/([^/]+)\/edits/.exec(form.getAttribute("hx-post") ?? "")?.[1];
    const frame = generationId ? frameFor(generationId) : null;
    if (!frame?.contentWindow) return;
    // No JSON block yet: read appOrigin off the frame's own src.
    frame.contentWindow.postMessage({ channel: "anyapp", type: "slot-pending", id: target }, new URL(frame.src).origin);
  }

  // Drops a frame's planning overlay at its first content, or at its load when the document carries no signal.
  /** @param {Element} frame */
  function hideWait(frame) {
    const wait = /** @type {HTMLElement | null | undefined} */ (frame.parentNode?.querySelector(".preview-wait"));
    if (wait) wait.hidden = true;
  }
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (!data || data.channel !== "anyapp" || data.type !== "first-content") return;
    for (const frame of /** @type {NodeListOf<HTMLIFrameElement>} */ (document.querySelectorAll("iframe.preview"))) {
      if (frame.contentWindow === event.source && new URL(frame.src).origin === event.origin) hideWait(frame);
    }
  });
  // load does not bubble, but a capturing listener still sees every iframe's.
  document.addEventListener("load", (event) => {
    const frame = targetOf(event);
    if (frame?.tagName === "IFRAME") hideWait(frame);
  }, true);

  // ---- Live sidebar ----

  // Polls GET /generations: fast while a row is pending/streaming/updating and slow otherwise, backing off
  // when nothing changes and paused while the tab is hidden.
  const FAST_MS = 2000;
  const SLOW_MS = 15000;
  /** @type {string | null} */
  let lastListHtml = null;
  let refreshing = false;
  let rerun = false;
  let unchanged = 0;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  // Bumped by local changes; a poll that started earlier is stale and dropped.
  let listEpoch = 0;

  // The highlight follows the stage, so it survives re-renders.
  function currentStageId() {
    const frame = stageFrame();
    return frame ? new URL(frame.src).pathname.split("/")[2] ?? "" : "";
  }
  function markActive() {
    const id = currentStageId();
    for (const row of list.querySelectorAll("li")) {
      row.classList.toggle("active", !!id && row.getAttribute("data-id") === id);
    }
  }
  function hasLiveRows() {
    return !!list.querySelector(".status-pending, .status-streaming, .status-updating");
  }

  async function refreshList() {
    // Not while a delete dialog is open: replacing the list would detach the control it holds.
    if (document.hidden || confirmDialog.open) return;
    // A refresh requested mid-flight may predate the change; run once more when this one lands.
    if (refreshing) {
      rerun = true;
      return;
    }
    refreshing = true;
    const epoch = listEpoch;
    try {
      const html = await fetchFragment("/generations");
      if (html !== null && epoch === listEpoch) {
        if (html === lastListHtml) {
          unchanged++;
        } else {
          unchanged = 0;
          lastListHtml = html;
          list.innerHTML = html;
          htmx.process(list);
          markActive();
        }
      }
    } catch {
      // Offline or interrupted: the next tick retries.
    }
    refreshing = false;
    if (rerun) {
      rerun = false;
      await refreshList();
    }
  }

  // ---- Conversation panel ----

  // #chat-log is replaced out-of-band, so look it up each time; an empty data-app hides the panel.
  const CHAT_KEY = "anyapp.chat.open";
  const chatToggle = byId("chat-toggle");
  const chatDot = byId("chat-dot");
  let chatBusy = false;

  function chatEl() {
    return document.getElementById("chat-log");
  }
  /** @param {HTMLElement} el */
  function nearBottom(el) {
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }
  function scrollChat() {
    const el = chatEl();
    if (el) el.scrollTop = el.scrollHeight;
  }
  /** @param {boolean} on */
  function setChatOpen(on) {
    body.classList.toggle("chat-open", on);
    chatToggle.setAttribute("aria-expanded", on ? "true" : "false");
    if (on) {
      chatDot.hidden = true;
      scrollChat();
    }
    try {
      localStorage.setItem(CHAT_KEY, on ? "1" : "0");
    } catch {
      // Private mode etc.: not persisted.
    }
  }
  chatToggle.addEventListener("click", () => setChatOpen(!body.classList.contains("chat-open")));
  try {
    if (localStorage.getItem(CHAT_KEY) === "1") {
      body.classList.add("chat-open");
      chatToggle.setAttribute("aria-expanded", "true");
    }
  } catch {
    // Storage unavailable: start collapsed.
  }

  /** @param {HTMLElement} log */
  function lastSeq(log) {
    const rows = log.querySelectorAll("li[data-seq]");
    return Number(rows[rows.length - 1]?.getAttribute("data-seq") ?? 0);
  }

  // Fetches messages newer than the log's last data-seq and swaps the transient "working" row.
  async function refreshChat() {
    const log = chatEl();
    const appId = log?.getAttribute("data-app");
    if (!log || !appId || document.hidden || chatBusy) return;
    chatBusy = true;
    try {
      const html = await fetchFragment("/generations/" + encodeURIComponent(appId) + "/messages?after=" + lastSeq(log));
      const current = chatEl();
      // The stage may have changed app while this was in flight.
      if (html === null || !current || current.getAttribute("data-app") !== appId) return;
      const stick = nearBottom(current);
      current.querySelector("[data-pending]")?.remove();
      const template = document.createElement("template");
      template.innerHTML = html;
      const added = template.content.querySelectorAll("li[data-seq]").length;
      current.appendChild(template.content);
      if (added && !body.classList.contains("chat-open")) chatDot.hidden = false;
      if (stick || added) scrollChat();
    } catch {
      // Offline or interrupted: the next tick retries.
    } finally {
      chatBusy = false;
    }
  }

  // ---- Polling loop ----

  async function tick() {
    await refreshList();
    await refreshChat();
  }
  function schedule() {
    clearTimeout(timer);
    const delay = hasLiveRows() ? Math.min(SLOW_MS, FAST_MS * (1 + unchanged)) : SLOW_MS;
    timer = setTimeout(() => tick().then(schedule), delay);
  }
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
      unchanged = 0;
      tick().then(schedule);
    }
  });
  schedule();

  // ---- Composer and stage ----

  byId("newapp-btn").addEventListener("click", () => {
    body.classList.add("creating");
    prompt.focus();
  });

  // Enter sends, Shift+Enter is a newline; requestSubmit keeps htmx and required validation.
  prompt.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      createForm.requestSubmit();
    }
  });

  onHtmx("htmx:afterSwap", (event) => {
    if (targetOf(event)?.id !== "stage") return;
    const path = pathOf(event);
    const verb = verbOf(event);

    if (verb === "get" && path.endsWith("/frame")) {
      // Picking an app switches the composer to edit mode.
      body.classList.remove("creating");
      setStreaming(false);
      markActive();
      chatDot.hidden = true;
      setTimeout(scrollChat, 0);
    } else if (verb === "post" && path === "/generations") {
      // The create response is the streaming iframe; its load event means the document arrived.
      const frame = stageFrame();
      setStreaming(!!frame);
      frame?.addEventListener("load", () => {
        setStreaming(false);
        refreshList();
        refreshChat();
      });
    }
  });

  // ---- Delete confirmation ----

  // A custom dialog instead of window.confirm: cancel htmx:confirm, then issueRequest on Delete.
  onHtmx("htmx:confirm", (event) => {
    const { question, elt, issueRequest } = event.detail;
    if (!question || !elt || !issueRequest || !confirmDialog.showModal) return;
    event.preventDefault();
    const opener = elt.closest("li")?.querySelector(".app-row-open");
    byId("confirm-title").textContent = question;
    byId("confirm-name").textContent = opener?.textContent ?? "";
    confirmDialog.returnValue = "cancel";
    confirmDialog.addEventListener("close", function onClose() {
      confirmDialog.removeEventListener("close", onClose);
      if (confirmDialog.returnValue === "delete") issueRequest(true);
    });
    confirmDialog.showModal();
  });
  // A click on the backdrop (the dialog itself) cancels.
  confirmDialog.addEventListener("click", (event) => {
    if (event.target === confirmDialog) confirmDialog.close("cancel");
  });

  // Deleted (200) or already gone (404): drop the row, and reset the stage if that app was open.
  // Anything else (409) keeps the row; the toast already shows the message.
  onHtmx("htmx:afterRequest", (event) => {
    const status = event.detail?.xhr?.status ?? 0;
    if (verbOf(event) !== "delete" || (status !== 200 && status !== 404)) return;
    const deletedId = pathOf(event).split("/").pop() ?? "";
    listEpoch++;
    for (const row of list.querySelectorAll("li")) {
      if (row.getAttribute("data-id") === deletedId) row.remove();
    }
    if (frameFor(deletedId)) {
      byId("stage").innerHTML = '<p class="placeholder">Your app will appear here.</p>';
      byId("edit-slot").innerHTML = "";
      byId("owner-slot").innerHTML = "";
      const log = chatEl();
      if (log) {
        log.setAttribute("data-app", "");
        log.innerHTML = "";
      }
      body.classList.add("creating");
      setStreaming(false);
    }
    if (!list.querySelector("li")) list.innerHTML = '<p class="empty">No apps yet. Describe one above.</p>';
    markActive();
    refreshList().then(schedule);
  });

  // ---- Edit and create forms ----

  // An edit leaves the app complete, so the "updating" badge comes from the server's in-memory edit flag: pull
  // the list just after the request starts and again when it finishes.
  onHtmx("htmx:beforeRequest", (event) => {
    const form = targetOf(event);
    if (!(form instanceof HTMLFormElement) || form.id !== "edit-form") return;
    freezeEditTarget(form);
    setTimeout(() => {
      unchanged = 0;
      tick().then(schedule);
    }, 400);
  });
  onHtmx("htmx:afterRequest", (event) => {
    if (targetOf(event)?.id !== "edit-form") return;
    listEpoch++;
    tick().then(schedule);
  });

  // Prompt boxes clear on submit (htmx has already read the value); a failed request puts the text back
  // unless the user typed something new.
  /** @type {Record<string, string>} */
  const submitted = {};
  /** @param {HTMLFormElement} form @return {HTMLInputElement | HTMLTextAreaElement | null} */
  function promptField(form) {
    return /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (
      form.elements.namedItem(form.id === "create-form" ? "prompt" : "instruction")
    );
  }
  /** @param {Event} event @return {HTMLFormElement | null} */
  function composerForm(event) {
    const form = targetOf(event);
    return form instanceof HTMLFormElement && (form.id === "create-form" || form.id === "edit-form") ? form : null;
  }
  onHtmx("htmx:beforeRequest", (event) => {
    const form = composerForm(event);
    const field = form && promptField(form);
    if (!form || !field) return;
    submitted[form.id] = field.value;
    field.value = "";
  });
  onHtmx("htmx:afterRequest", (event) => {
    const form = composerForm(event);
    if (!form) return;
    const field = promptField(form);
    const ok = !!event.detail?.successful;
    if (field && !ok && !field.value) field.value = submitted[form.id] ?? "";
    // hx-disabled-elt took the focus with it: restore it unless the user moved elsewhere.
    if (field && ok && document.activeElement === body) field.focus();
    if (form === createForm && ok) {
      // The new row exists server-side already, so the list shows it as pending without a reload.
      listEpoch++;
      refreshList().then(schedule);
    }
  });
})();
