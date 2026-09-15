/*
 * Asistente de ayuda: botón flotante + chat pequeño en la esquina inferior derecha.
 *
 * Hay una sola conversación y vive en la sesión del servidor. Al cambiar de
 * página (la intranet recarga el documento) el panel se reabre si estaba
 * abierto y vuelve a pedir la conversación.
 */
(function () {
  "use strict";

  const OPEN_KEY = "claude-assistant-open";
  const NAVIGATE_DELAY_MS = 900;

  const fab = document.getElementById("claudeFab");
  const panel = document.getElementById("claudePanel");
  if (!fab || !panel) return;

  const scroll = document.getElementById("claudeScroll");
  const welcome = document.getElementById("claudeWelcome");
  const thread = document.getElementById("claudeThread");
  const form = document.getElementById("claudeForm");
  const input = document.getElementById("claudeInput");
  const sendBtn = document.getElementById("claudeSend");

  let historyLoaded = false;
  let streaming = false;
  let closeTimer = null;

  if (window.marked) marked.setOptions({ breaks: true, gfm: true });

  // ── Estado abierto/cerrado ──────────────────────────────────────────────
  function rememberOpen(open) {
    try {
      if (open) sessionStorage.setItem(OPEN_KEY, "1");
      else sessionStorage.removeItem(OPEN_KEY);
    } catch (_) {
      /* sin sessionStorage el panel simplemente no se reabre solo */
    }
  }

  function wasOpen() {
    try {
      return sessionStorage.getItem(OPEN_KEY) === "1";
    } catch (_) {
      return false;
    }
  }

  function openPanel({ focus = true } = {}) {
    clearTimeout(closeTimer);
    panel.hidden = false;
    requestAnimationFrame(() => panel.classList.add("is-open"));
    fab.classList.add("is-active");
    fab.setAttribute("aria-expanded", "true");
    fab.setAttribute("aria-label", "Cerrar asistente");
    rememberOpen(true);
    loadHistory();
    if (focus) input.focus();
  }

  function closePanel() {
    panel.classList.remove("is-open");
    fab.classList.remove("is-active");
    fab.setAttribute("aria-expanded", "false");
    fab.setAttribute("aria-label", "Abrir asistente de ayuda de la intranet");
    rememberOpen(false);
    closeTimer = setTimeout(() => { panel.hidden = true; }, 220);
  }

  const isOpen = () => panel.classList.contains("is-open");

  // ── Render ──────────────────────────────────────────────────────────────
  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text;
    return div.innerHTML;
  }

  function renderMarkdown(target, text) {
    target.innerHTML =
      window.marked && window.DOMPurify
        ? DOMPurify.sanitize(marked.parse(text))
        : escapeHtml(text).replace(/\n/g, "<br>");
    // Los enlaces externos (portales, documentos) no deben sacar al usuario de la intranet.
    target.querySelectorAll("a[href]").forEach((a) => {
      try {
        if (new URL(a.href, window.location.origin).origin !== window.location.origin) {
          a.target = "_blank";
          a.rel = "noopener noreferrer";
        }
      } catch (_) {
        /* href inválido: se deja como está */
      }
    });
  }

  function scrollToBottom() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  function syncWelcome() {
    welcome.hidden = thread.children.length > 0;
  }

  function addUserMessage(text) {
    const el = document.createElement("div");
    el.className = "claude-msg claude-msg--user";
    el.textContent = text;
    thread.appendChild(el);
    syncWelcome();
    scrollToBottom();
  }

  function addAssistantMessage(text) {
    const el = document.createElement("div");
    el.className = "claude-msg claude-msg--assistant";
    el.innerHTML =
      '<div class="claude-msg__text"></div>' +
      '<p class="claude-msg__status" role="status" hidden></p>';
    const textEl = el.querySelector(".claude-msg__text");
    if (text) renderMarkdown(textEl, text);
    thread.appendChild(el);
    syncWelcome();
    scrollToBottom();
    return { el, textEl, statusEl: el.querySelector(".claude-msg__status") };
  }

  function updateSendState() {
    // border-box: scrollHeight no incluye el borde (1px arriba y abajo).
    input.style.height = "auto";
    const needed = input.scrollHeight + 2;
    input.style.height = Math.min(needed, 120) + "px";
    input.style.overflowY = needed > 120 ? "auto" : "hidden";
    sendBtn.disabled = streaming || !input.value.trim();
  }

  // ── Conversación ────────────────────────────────────────────────────────
  async function loadHistory() {
    if (historyLoaded) return;
    historyLoaded = true;
    try {
      const res = await fetch("/claude/api/conversation", { headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error("No se pudo cargar la conversación");
      const data = await res.json();
      if (streaming || thread.children.length) return;
      (data.messages || []).forEach((m) => {
        if (m.role === "user") addUserMessage(m.content);
        else addAssistantMessage(m.content);
      });
    } catch (err) {
      historyLoaded = false;
      console.error("[Asistente]", err);
    }
  }

  async function resetConversation() {
    if (streaming) return;
    try {
      await fetch("/claude/api/conversation", { method: "DELETE" });
    } catch (err) {
      console.error("[Asistente]", err);
    }
    thread.innerHTML = "";
    syncWelcome();
    input.focus();
  }

  function navigateAfterTurn(navigation, message) {
    const url = new URL(navigation.href, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;

    const note = document.createElement("p");
    note.className = "claude-msg__note";
    note.textContent = `Te llevo a ${navigation.label || url.pathname}…`;
    message.el.appendChild(note);
    scrollToBottom();

    rememberOpen(true);
    url.searchParams.set("openClaude", "1");
    setTimeout(() => window.location.assign(url.pathname + url.search), NAVIGATE_DELAY_MS);
  }

  async function send(text) {
    const question = String(text || "").trim();
    if (!question || streaming) return;

    streaming = true;
    input.value = "";
    updateSendState();
    addUserMessage(question);

    const message = addAssistantMessage("");
    message.textEl.innerHTML = '<span class="claude-typing" aria-label="Escribiendo"><span></span><span></span><span></span></span>';

    let answer = "";
    let navigation = null;
    try {
      const res = await fetch("/claude/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: question,
          page: { path: window.location.pathname, title: document.title },
        }),
      });
      if (!res.ok || !res.body) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || "Error de conexión");
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop();

        for (const block of blocks) {
          const line = block.trim();
          if (!line.startsWith("data:")) continue;
          const payload = JSON.parse(line.slice(5).trim());

          if (payload.type === "text") {
            answer += payload.text;
            message.statusEl.hidden = true;
            renderMarkdown(message.textEl, answer);
            scrollToBottom();
          } else if (payload.type === "status") {
            if (!answer) message.textEl.innerHTML = "";
            message.statusEl.textContent = payload.text;
            message.statusEl.hidden = false;
            scrollToBottom();
          } else if (payload.type === "error") {
            throw new Error(payload.error);
          } else if (payload.type === "done") {
            navigation = payload.navigate || null;
          }
        }
      }
      message.statusEl.hidden = true;
      if (!answer) message.textEl.innerHTML = "";
      if (navigation) navigateAfterTurn(navigation, message);
    } catch (err) {
      message.statusEl.hidden = true;
      message.textEl.innerHTML = `<span class="claude-msg__error">${escapeHtml(err.message)}</span>`;
    } finally {
      streaming = false;
      updateSendState();
      if (isOpen()) input.focus();
    }
  }

  // ── Eventos ─────────────────────────────────────────────────────────────
  fab.addEventListener("click", () => (isOpen() ? closePanel() : openPanel()));
  document.getElementById("claudeClose")?.addEventListener("click", () => {
    closePanel();
    fab.focus();
  });
  document.getElementById("claudeReset")?.addEventListener("click", resetConversation);

  panel.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      closePanel();
      fab.focus();
    }
  });

  welcome.addEventListener("click", (e) => {
    const ask = e.target.closest("[data-send]");
    if (ask) return send(ask.dataset.send);
    const prompt = e.target.closest("[data-prompt]");
    if (prompt) {
      input.value = prompt.dataset.prompt;
      updateSendState();
      input.focus();
    }
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    send(input.value);
  });

  input.addEventListener("input", updateSendState);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send(input.value);
    }
  });

  // Reabre tras una navegación del asistente (?openClaude=1) o si quedó abierto.
  const params = new URLSearchParams(window.location.search);
  if (params.get("openClaude") === "1" || wasOpen()) {
    openPanel({ focus: false });
  }
  if (params.has("openClaude")) {
    params.delete("openClaude");
    const qs = params.toString();
    window.history.replaceState({}, document.title, window.location.pathname + (qs ? `?${qs}` : ""));
  }
})();
