/*
 * Asistente de ayuda: botón flotante + chat pequeño en la esquina inferior derecha.
 *
 * Hay una sola conversación y vive en la sesión del servidor. Al cambiar de
 * página (la intranet recarga el documento) el panel se reabre si estaba
 * abierto y vuelve a pedir la conversación.
 *
 * Tickets: sólo se adjunta en la casilla de la tarjeta del borrador. Los
 * archivos se guardan en el navegador (IndexedDB) y se
 * suben recién cuando el usuario pulsa «Crear ticket» en la tarjeta del
 * borrador. Al modelo sólo le llegan sus nombres.
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
  const fileInput = document.getElementById("claudeFileInput");
  const maxAttachmentMb = Number(panel.dataset.maxAttachmentMb) || 40;

  let historyLoaded = false;
  let streaming = false;
  let closeTimer = null;
  let sessionKey = null;
  let pendingAttachments = [];

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

  // El chat sigue el final mientras crece (texto que llega, tarjetas, botones),
  // salvo que el usuario haya subido para leer algo anterior.
  let stickToBottom = true;

  function scrollToBottom() {
    stickToBottom = true;
    scroll.scrollTop = scroll.scrollHeight;
  }

  scroll.addEventListener("scroll", () => {
    stickToBottom = scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 48;
  });

  new MutationObserver(() => {
    if (stickToBottom) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }).observe(thread, { childList: true, subtree: true, characterData: true });

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
    const message = { el: node, textEl, statusEl: node.querySelector(".claude-msg__status") };
    if (text) addCopyButton(message);
    return message;
  }

  /** Botón «Copiar» bajo una respuesta: útil para correos y textos redactados. */
  function addCopyButton(message) {
    if (!navigator.clipboard || message.el.querySelector(".claude-msg__copy")) return;
    const button = el("button", "claude-msg__copy", "Copiar");
    button.type = "button";
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(message.textEl.innerText.trim());
        button.textContent = "Copiado";
      } catch (_) {
        button.textContent = "No se pudo copiar";
      }
      setTimeout(() => { button.textContent = "Copiar"; }, 1600);
    });
    message.textEl.after(button);
  }

  function updateSendState() {
    // border-box: scrollHeight no incluye el borde (1px arriba y abajo).
    input.style.height = "auto";
    const needed = input.scrollHeight + 2;
    input.style.height = Math.min(needed, 120) + "px";
    input.style.overflowY = needed > 120 ? "auto" : "hidden";
    sendBtn.disabled = streaming || !input.value.trim();
  }

  async function requestJson(url, options = {}) {
    const res = await fetch(url, { headers: { Accept: "application/json" }, ...options });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "No se pudo completar la acción.");
    return data;
  }

  // ── Adjuntos guardados en el navegador ─────────────────────────────────
  // Viven en IndexedDB para sobrevivir al cambio de página y se suben recién
  // al crear el ticket. Cada registro guarda la sesión del servidor en que se
  // adjuntó: los de una sesión anterior se descartan.
  const fileStore = (() => {
    const DB_NAME = "intranet-asistente";
    const STORE = "adjuntos";
    let dbPromise = null;

    function open() {
      if (!("indexedDB" in window)) return Promise.reject(new Error("IndexedDB no disponible"));
      if (!dbPromise) {
        dbPromise = new Promise((resolve, reject) => {
          const request = indexedDB.open(DB_NAME, 1);
          request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: "id" });
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }
      return dbPromise;
    }

    async function run(mode, action) {
      const db = await open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, mode);
        const request = action(tx.objectStore(STORE));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error);
      });
    }

    return {
      all: () => run("readonly", (store) => store.getAll()),
      put: (record) => run("readwrite", (store) => store.put(record)),
      remove: (id) => run("readwrite", (store) => store.delete(id)),
      clear: () => run("readwrite", (store) => store.clear()),
    };
  })();

  const ignore = () => {
    /* sin IndexedDB los adjuntos viven sólo mientras la página siga abierta */
  };

  function newId() {
    return window.crypto && crypto.randomUUID
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function attachmentKind(file) {
    if (file.type.startsWith("video/")) return "video";
    if (file.type.startsWith("image/")) return "image";
    if (file.type === "application/pdf" || /\.pdf$/i.test(file.name)) return "pdf";
    return "doc";
  }

  function isAllowedFile(file) {
    return file.type.startsWith("image/") || file.type.startsWith("video/") || /\.(pdf|docx?)$/i.test(file.name);
  }

  /** Refresca las casillas de las tarjetas de borrador, con un aviso si lo hay. */
  function renderAttachments(message) {
    draftFileLists.forEach((refresh) => refresh(message));
  }

  /** Listas de archivos de las tarjetas de borrador abiertas. */
  const draftFileLists = new Set();

  function addFiles(files) {
    let problem = "";
    for (const file of files) {
      if (pendingAttachments.length >= MAX_ATTACHMENTS) {
        problem = `Puedes adjuntar hasta ${MAX_ATTACHMENTS} archivos por ticket.`;
        break;
      }
      if (!isAllowedFile(file)) {
        problem = `«${file.name}» no es un tipo permitido. Usa imágenes, videos, PDF o Word.`;
        continue;
      }
      if (file.size > maxAttachmentMb * 1024 * 1024) {
        problem = `«${file.name}» supera los ${maxAttachmentMb} MB.`;
        continue;
      }
      const record = { id: newId(), sessionKey, nombre: file.name, tipo: attachmentKind(file), file };
      pendingAttachments.push(record);
      fileStore.put(record).catch(ignore);
    }
    renderAttachments(problem);
  }

  function removeAttachment(id) {
    pendingAttachments = pendingAttachments.filter((attachment) => attachment.id !== id);
    fileStore.remove(id).catch(ignore);
    renderAttachments();
  }

  function clearAttachments() {
    pendingAttachments = [];
    fileStore.clear().catch(ignore);
    renderAttachments();
  }

  /** Recupera los adjuntos de esta sesión y descarta los de sesiones anteriores. */
  async function restoreAttachments() {
    if (!fileInput) return;
    // Lo adjuntado antes de conocer la sesión queda asociado a ella.
    pendingAttachments.forEach((attachment) => {
      if (!attachment.sessionKey) {
        attachment.sessionKey = sessionKey;
        fileStore.put(attachment).catch(ignore);
      }
    });
    try {
      const stored = await fileStore.all();
      const inMemory = new Set(pendingAttachments.map((attachment) => attachment.id));
      stored.forEach((record) => {
        if (record.sessionKey !== sessionKey) {
          fileStore.remove(record.id).catch(ignore);
        } else if (!inMemory.has(record.id) && pendingAttachments.length < MAX_ATTACHMENTS) {
          pendingAttachments.push(record);
        }
      });
    } catch (_) {
      ignore();
    }
    renderAttachments();
  }

  function asFile(attachment) {
    return attachment.file instanceof File
      ? attachment.file
      : new File([attachment.file], attachment.nombre, { type: attachment.file.type || "" });
  }

  // ── Tickets ─────────────────────────────────────────────────────────────
  /** El alta de tickets es sólo en modal: se abre sobre la página actual. */
  function openTicketForm(prefill) {
    if (window.TicketCreateModal && window.TicketCreateModal.open(prefill)) closePanel();
  }

  /**
   * Casilla para agregar fotos del problema a un borrador: clic o arrastrar y
   * soltar. Los archivos quedan en el navegador hasta crear el ticket.
   */
  function renderDropzone(card) {
    const drop = el("div", "claude-dropzone");
    drop.tabIndex = 0;
    drop.setAttribute("role", "button");
    drop.appendChild(el("p", "claude-dropzone__title", "¿Quieres agregar fotos de tu problema?"));
    drop.appendChild(el("p", "claude-dropzone__hint", "Arrastra y suelta los archivos aquí o haz clic para elegirlos."));

    const list = el("ul", "claude-ticket__files");
    const refresh = (message) => {
      list.innerHTML = "";
      pendingAttachments.forEach((attachment) => {
        const item = el("li", "");
        item.appendChild(el("span", "claude-file__name", attachment.nombre));
        const remove = el("button", "claude-file__remove", "×");
        remove.type = "button";
        remove.setAttribute("aria-label", `Quitar ${attachment.nombre}`);
        remove.addEventListener("click", () => removeAttachment(attachment.id));
        item.appendChild(remove);
        list.appendChild(item);
      });
      if (message) list.appendChild(el("li", "claude-attachments__error", message));
      list.hidden = !pendingAttachments.length && !message;
    };

    const choose = () => fileInput && fileInput.click();
    drop.addEventListener("click", choose);
    drop.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        choose();
      }
    });
    drop.addEventListener("dragover", (e) => {
      e.preventDefault();
      drop.classList.add("is-dragging");
    });
    drop.addEventListener("dragleave", () => drop.classList.remove("is-dragging"));
    drop.addEventListener("drop", (e) => {
      e.preventDefault();
      drop.classList.remove("is-dragging");
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (files.length) addFiles(files);
    });

    card.append(drop, list);
    draftFileLists.add(refresh);
    renderAttachments();

    return () => {
      draftFileLists.delete(refresh);
      drop.remove();
      list.remove();
      renderAttachments();
    };
  }

  function renderTicketOffer(message, offer) {
    const actions = el("div", "claude-actions");
    const openForm = el("button", "claude-action", "Abrir formulario");
    openForm.type = "button";
    openForm.addEventListener("click", () =>
      openTicketForm({
        title: offer.summary,
        category: offer.category || undefined,
        files: pendingAttachments.map(asFile),
      }),
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
    const closeDropzone = renderDropzone(card);

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
      const files = pendingAttachments.slice();
      setBusy(true);
      setStatus(files.length ? `Creando ticket y subiendo ${files.length} archivo(s)…` : "Creando ticket…");
      try {
        const body = new FormData();
        files.forEach((attachment) => body.append("adjuntos", asFile(attachment), attachment.nombre));
        const data = await requestJson(`/claude/api/ticket-draft/${encodeURIComponent(draft.id)}/confirm`, {
          method: "POST",
          body,
        });
        closeDropzone();
        clearAttachments();
        actions.remove();
        setStatus(`Ticket #${data.id} creado. `);
        const link = el("a", "", "Ver ticket");
        link.href = data.url;
        status.appendChild(link);
        if (data.failedAttachments && data.failedAttachments.length) {
          status.appendChild(
            el("span", "claude-msg__error", ` No se pudieron subir: ${data.failedAttachments.join(", ")}.`),
          );
        }
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
        files: pendingAttachments.map(asFile),
      }),
    );

    discard.addEventListener("click", async () => {
      setBusy(true);
      try {
        await requestJson(`/claude/api/ticket-draft/${encodeURIComponent(draft.id)}`, { method: "DELETE" });
        closeDropzone();
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
      sessionKey = data.sessionKey || null;
      await restoreAttachments();
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
    clearAttachments();
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
    if (!question || streaming) return;

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
          attachments: pendingAttachments.map(({ nombre, tipo }) => ({ nombre, tipo })),
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
      else addCopyButton(message);

      if (done && done.ticketDraft) {
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

  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const files = Array.from(fileInput.files || []);
      fileInput.value = "";
      if (files.length) addFiles(files);
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
