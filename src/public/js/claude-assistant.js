/*
 * Asistente de ayuda: botón flotante + chat pequeño en la esquina inferior derecha.
 *
 * Hay una sola conversación y vive en la sesión del servidor. Al cambiar de
 * página (la intranet recarga el documento) el panel se reabre si estaba
 * abierto y vuelve a pedir la conversación.
 *
 * Tickets: los archivos adjuntos quedan pendientes en la sesión y se suman al
 * borrador que arma el asistente. El ticket sólo se crea cuando el usuario
 * pulsa «Crear ticket» en la tarjeta.
 */
(function () {
  "use strict";

  const OPEN_KEY = "claude-assistant-open";
  const NAVIGATE_DELAY_MS = 900;
  const MAX_ATTACHMENTS = 5;

  const fab = document.getElementById("claudeFab");
  const panel = document.getElementById("claudePanel");
  if (!fab || !panel) return;

  const scroll = document.getElementById("claudeScroll");
  const welcome = document.getElementById("claudeWelcome");
  const thread = document.getElementById("claudeThread");
  const form = document.getElementById("claudeForm");
  const input = document.getElementById("claudeInput");
  const sendBtn = document.getElementById("claudeSend");
  const attachBtn = document.getElementById("claudeAttach");
  const fileInput = document.getElementById("claudeFileInput");
  const attachmentsEl = document.getElementById("claudeAttachments");

  let historyLoaded = false;
  let streaming = false;
  let closeTimer = null;
  let pendingAttachments = [];
  let uploading = 0;

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

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function scrollToBottom() {
    scroll.scrollTop = scroll.scrollHeight;
  }

  function syncWelcome() {
    welcome.hidden = thread.children.length > 0;
  }

  function addUserMessage(text) {
    thread.appendChild(el("div", "claude-msg claude-msg--user", text));
    syncWelcome();
    scrollToBottom();
  }

  function addAssistantMessage(text) {
    const node = el("div", "claude-msg claude-msg--assistant");
    node.innerHTML =
      '<div class="claude-msg__text"></div>' +
      '<p class="claude-msg__status" role="status" hidden></p>';
    const textEl = node.querySelector(".claude-msg__text");
    if (text) renderMarkdown(textEl, text);
    thread.appendChild(node);
    syncWelcome();
    scrollToBottom();
    return { el: node, textEl, statusEl: node.querySelector(".claude-msg__status") };
  }

  function updateSendState() {
    // border-box: scrollHeight no incluye el borde (1px arriba y abajo).
    input.style.height = "auto";
    const needed = input.scrollHeight + 2;
    input.style.height = Math.min(needed, 120) + "px";
    input.style.overflowY = needed > 120 ? "auto" : "hidden";
    sendBtn.disabled = streaming || uploading > 0 || !input.value.trim();
  }

  async function requestJson(url, options = {}) {
    const res = await fetch(url, { headers: { Accept: "application/json" }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "No se pudo completar la acción.");
    return data;
  }

  // ── Adjuntos ────────────────────────────────────────────────────────────
  function renderAttachments(message) {
    if (!attachmentsEl) return;
    attachmentsEl.innerHTML = "";

    pendingAttachments.forEach((attachment) => {
      const chip = el("span", "claude-file");
      chip.appendChild(el("span", "claude-file__name", attachment.nombre));
      const remove = el("button", "claude-file__remove", "×");
      remove.type = "button";
      remove.setAttribute("aria-label", `Quitar ${attachment.nombre}`);
      remove.addEventListener("click", () => removeAttachment(attachment.id));
      chip.appendChild(remove);
      attachmentsEl.appendChild(chip);
    });
    if (uploading > 0) {
      attachmentsEl.appendChild(el("span", "claude-file claude-file--loading", `Subiendo ${uploading}…`));
    }
    if (message) attachmentsEl.appendChild(el("p", "claude-attachments__error", message));

    attachmentsEl.hidden = !pendingAttachments.length && uploading === 0 && !message;
  }

  async function uploadFiles(files) {
    for (const file of files) {
      if (pendingAttachments.length + uploading >= MAX_ATTACHMENTS) {
        renderAttachments(`Puedes adjuntar hasta ${MAX_ATTACHMENTS} archivos por ticket.`);
        break;
      }
      uploading += 1;
      renderAttachments();
      updateSendState();
      try {
        const body = new FormData();
        body.append("file", file);
        const data = await requestJson("/claude/api/attachments", { method: "POST", body });
        pendingAttachments.push(data.attachment);
        uploading -= 1;
        renderAttachments();
      } catch (err) {
        uploading -= 1;
        renderAttachments(`${file.name}: ${err.message}`);
      }
      updateSendState();
    }
  }

  async function removeAttachment(id) {
    try {
      const data = await requestJson(`/claude/api/attachments/${encodeURIComponent(id)}`, { method: "DELETE" });
      pendingAttachments = data.attachments || [];
      renderAttachments();
    } catch (err) {
      renderAttachments(err.message);
    }
  }

  // ── Tickets ─────────────────────────────────────────────────────────────
  function openTicketForm(prefill) {
    if (window.TicketCreateModal && window.TicketCreateModal.open(prefill)) {
      closePanel();
      return;
    }
    window.location.assign("/sistemas/tickets?nuevo=1");
  }

  function renderTicketOffer(message, offer) {
    const actions = el("div", "claude-actions");
    const openForm = el("button", "claude-action", "Abrir formulario");
    openForm.type = "button";
    openForm.addEventListener("click", () =>
      openTicketForm({ title: offer.summary, category: offer.category || undefined }),
    );
    const createForMe = el("button", "claude-action claude-action--primary", "Créalo por mí");
    createForMe.type = "button";
    createForMe.addEventListener("click", () => {
      actions.remove();
      send("Créalo por mí");
    });
    actions.append(openForm, createForMe);
    message.el.appendChild(actions);
    scrollToBottom();
  }

  function renderTicketDraft(message, draft) {
    const card = el("div", "claude-ticket");
    card.appendChild(el("p", "claude-ticket__eyebrow", "Borrador de ticket"));
    card.appendChild(el("p", "claude-ticket__title", draft.title));

    const meta = el("p", "claude-ticket__meta");
    meta.append(el("span", "", draft.categoryLabel), el("span", "", `Prioridad ${draft.priorityLabel.toLowerCase()}`));
    card.appendChild(meta);
    card.appendChild(el("p", "claude-ticket__desc", draft.description));

    if (draft.attachments.length) {
      const files = el("ul", "claude-ticket__files");
      draft.attachments.forEach((attachment) => files.appendChild(el("li", "", attachment.nombre)));
      card.appendChild(files);
    }

    const actions = el("div", "claude-actions");
    const create = el("button", "claude-action claude-action--primary", "Crear ticket");
    const edit = el("button", "claude-action", "Editar en formulario");
    const discard = el("button", "claude-action claude-action--ghost", "Descartar");
    [create, edit, discard].forEach((button) => { button.type = "button"; });
    actions.append(create, edit, discard);
    card.appendChild(actions);

    const status = el("p", "claude-ticket__status");
    status.setAttribute("role", "status");
    status.hidden = true;
    card.appendChild(status);

    const setStatus = (text, isError) => {
      status.textContent = text;
      status.classList.toggle("claude-msg__error", Boolean(isError));
      status.hidden = !text;
    };
    const setBusy = (busy) => [create, edit, discard].forEach((button) => { button.disabled = busy; });

    create.addEventListener("click", async () => {
      setBusy(true);
      setStatus("Creando ticket…");
      try {
        const data = await requestJson(`/claude/api/ticket-draft/${encodeURIComponent(draft.id)}/confirm`, {
          method: "POST",
        });
        actions.remove();
        status.textContent = `Ticket #${data.id} creado. `;
        status.classList.remove("claude-msg__error");
        status.hidden = false;
        const link = el("a", "", "Ver ticket");
        link.href = data.url;
        status.appendChild(link);
        card.classList.add("is-done");
      } catch (err) {
        setBusy(false);
        setStatus(err.message, true);
      }
    });

    edit.addEventListener("click", () =>
      openTicketForm({
        title: draft.title,
        category: draft.category,
        priority: draft.priority,
        description: draft.description,
      }),
    );

    discard.addEventListener("click", async () => {
      setBusy(true);
      try {
        const data = await requestJson(`/claude/api/ticket-draft/${encodeURIComponent(draft.id)}`, {
          method: "DELETE",
        });
        pendingAttachments = data.attachments || [];
        renderAttachments();
        actions.remove();
        setStatus("Borrador descartado.");
        card.classList.add("is-done");
      } catch (err) {
        setBusy(false);
        setStatus(err.message, true);
      }
    });

    message.el.appendChild(card);
    scrollToBottom();
  }

  // ── Conversación ────────────────────────────────────────────────────────
  async function loadHistory() {
    if (historyLoaded) return;
    historyLoaded = true;
    try {
      const data = await requestJson("/claude/api/conversation");
      pendingAttachments = data.attachments || [];
      renderAttachments();
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
    pendingAttachments = [];
    renderAttachments();
    syncWelcome();
    input.focus();
  }

  function navigateAfterTurn(navigation, message) {
    const url = new URL(navigation.href, window.location.origin);
    if (url.origin !== window.location.origin || url.pathname === window.location.pathname) return;

    message.el.appendChild(el("p", "claude-msg__note", `Te llevo a ${navigation.label || url.pathname}…`));
    scrollToBottom();

    rememberOpen(true);
    url.searchParams.set("openClaude", "1");
    setTimeout(() => window.location.assign(url.pathname + url.search), NAVIGATE_DELAY_MS);
  }

  async function send(text) {
    const question = String(text || "").trim();
    if (!question || streaming || uploading > 0) return;

    streaming = true;
    input.value = "";
    updateSendState();
    addUserMessage(question);

    const message = addAssistantMessage("");
    message.textEl.innerHTML = '<span class="claude-typing" aria-label="Escribiendo"><span></span><span></span><span></span></span>';

    let answer = "";
    let done = null;
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
        const { value, done: finished } = await reader.read();
        if (finished) break;
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
            done = payload;
          }
        }
      }
      message.statusEl.hidden = true;
      if (!answer) message.textEl.innerHTML = "";

      if (done && done.ticketDraft) {
        // Los adjuntos pendientes pasaron al borrador.
        pendingAttachments = [];
        renderAttachments();
        renderTicketDraft(message, done.ticketDraft);
      } else if (done && done.ticketOffer) {
        renderTicketOffer(message, done.ticketOffer);
      }
      if (done && done.navigate) navigateAfterTurn(done.navigate, message);
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

  if (attachBtn && fileInput) {
    attachBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = "";
      if (files.length) uploadFiles(files);
    });
  }

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
