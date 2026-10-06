(function () {
  const section = document.getElementById("homeQuick");
  if (!section || section.dataset.quickBound === "true") return;
  section.dataset.quickBound = "true";

  const visibleEl = document.getElementById("homeQuickVisible");
  const hiddenEl = document.getElementById("homeQuickHidden");
  const hiddenWrap = document.getElementById("homeQuickHiddenWrap");
  const emptyVisible = document.getElementById("homeQuickVisibleEmpty");
  const emptyHidden = document.getElementById("homeQuickHiddenEmpty");
  const statusEl = document.getElementById("homeQuickStatus");
  const editBtn = document.getElementById("homeQuickEdit");
  const actionsEl = document.getElementById("homeQuickActions");
  const restoreBtn = section.querySelector('[data-quick-action="restore"]');
  const cancelBtn = section.querySelector('[data-quick-action="cancel"]');
  const saveBtn = section.querySelector('[data-quick-action="save"]');
  if (!visibleEl || !hiddenEl || !editBtn) return;

  const visibleLimit = Number(section.dataset.visibleLimit) || 6;
  let editing = false;
  let snapshot = null;
  let dragging = null;
  let defaults = [];
  try {
    defaults = JSON.parse(section.dataset.defaultOrder || "[]");
  } catch (_) {
    defaults = [];
  }

  const idsOf = (list) =>
    Array.from(list.querySelectorAll("[data-quick-id]")).map((el) => el.dataset.quickId);

  const setStatus = (text, kind) => {
    if (!statusEl) return;
    statusEl.textContent = text || "";
    statusEl.classList.toggle("is-ok", kind === "ok");
    statusEl.classList.toggle("is-error", kind === "error");
  };

  const syncEmpty = () => {
    if (emptyVisible) emptyVisible.hidden = idsOf(visibleEl).length > 0;
    if (emptyHidden) emptyHidden.hidden = idsOf(hiddenEl).length > 0;
  };

  const setSlot = (item, hidden) => {
    const hideBtn = item.querySelector("[data-quick-hide]");
    const showBtn = item.querySelector("[data-quick-show]");
    if (hideBtn) {
      hideBtn.hidden = hidden;
      hideBtn.tabIndex = editing && !hidden ? 0 : -1;
    }
    if (showBtn) {
      showBtn.hidden = !hidden;
      showBtn.tabIndex = editing && hidden ? 0 : -1;
    }
    item.querySelectorAll("[data-quick-move]").forEach((btn) => {
      btn.hidden = hidden;
      btn.tabIndex = editing && !hidden ? 0 : -1;
    });
    item.draggable = Boolean(editing && !hidden);
  };

  const capture = () => ({
    visible: idsOf(visibleEl),
    hidden: idsOf(hiddenEl),
  });

  const apply = (state) => {
    const map = new Map();
    section.querySelectorAll("[data-quick-id]").forEach((el) => {
      map.set(el.dataset.quickId, el);
    });
    state.visible.forEach((id) => {
      const el = map.get(id);
      if (!el) return;
      setSlot(el, false);
      visibleEl.appendChild(el);
    });
    state.hidden.forEach((id) => {
      const el = map.get(id);
      if (!el) return;
      setSlot(el, true);
      hiddenEl.appendChild(el);
    });
    syncEmpty();
  };

  const setEditing = (value) => {
    editing = value;
    section.classList.toggle("is-editing", value);
    editBtn.hidden = value;
    editBtn.setAttribute("aria-pressed", String(value));
    if (actionsEl) actionsEl.hidden = !value;
    if (hiddenWrap) hiddenWrap.hidden = !value;
    section.querySelectorAll("[data-quick-id]").forEach((item) => {
      setSlot(item, item.parentElement === hiddenEl);
    });
    section.querySelectorAll(".home-quick__link").forEach((link) => {
      link.tabIndex = value ? -1 : 0;
    });
    if (value) {
      snapshot = capture();
      setStatus("");
    }
    syncEmpty();
  };

  const moveItem = (item, step) => {
    const list = Array.from(visibleEl.querySelectorAll("[data-quick-id]"));
    const from = list.indexOf(item);
    const to = from + step;
    if (from < 0 || to < 0 || to >= list.length) return;
    if (step < 0) visibleEl.insertBefore(item, list[to]);
    else visibleEl.insertBefore(list[to], item);
  };

  editBtn.addEventListener("click", () => setEditing(true));

  cancelBtn?.addEventListener("click", () => {
    if (snapshot) apply(snapshot);
    setEditing(false);
    setStatus("");
  });

  section.addEventListener("click", (event) => {
    if (!editing) return;
    if (event.target.closest(".home-quick__link")) event.preventDefault();

    const moveBtn = event.target.closest("[data-quick-move]");
    if (moveBtn) {
      event.preventDefault();
      const item = moveBtn.closest("[data-quick-id]");
      if (item && item.parentElement === visibleEl) {
        moveItem(item, Number(moveBtn.dataset.quickMove));
      }
      return;
    }

    const hideBtn = event.target.closest("[data-quick-hide]");
    if (hideBtn) {
      event.preventDefault();
      const item = hideBtn.closest("[data-quick-id]");
      if (!item) return;
      setSlot(item, true);
      hiddenEl.appendChild(item);
      setStatus("");
      syncEmpty();
      return;
    }

    const showBtn = event.target.closest("[data-quick-show]");
    if (showBtn) {
      event.preventDefault();
      const item = showBtn.closest("[data-quick-id]");
      if (!item) return;
      if (idsOf(visibleEl).length >= visibleLimit) {
        setStatus("Puedes dejar hasta " + visibleLimit + " accesos en la barra.", "error");
        return;
      }
      setSlot(item, false);
      visibleEl.appendChild(item);
      setStatus("");
      syncEmpty();
    }
  });

  visibleEl.addEventListener("dragstart", (event) => {
    const item = event.target.closest("[data-quick-id]");
    if (!editing || !item || item.parentElement !== visibleEl || event.target.closest("button")) {
      event.preventDefault();
      return;
    }
    dragging = item;
    item.classList.add("is-dragging");
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", item.dataset.quickId);
  });

  visibleEl.addEventListener("dragend", () => {
    if (dragging) dragging.classList.remove("is-dragging");
    dragging = null;
  });

  visibleEl.addEventListener("dragover", (event) => {
    if (!editing || !dragging) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    const target = event.target.closest("[data-quick-id]");
    if (!target || target === dragging || target.parentElement !== visibleEl) return;
    const box = target.getBoundingClientRect();
    if (event.clientX > box.left + box.width / 2) target.after(dragging);
    else target.before(dragging);
  });

  visibleEl.addEventListener("drop", (event) => {
    if (editing) event.preventDefault();
  });

  async function postPreference(body) {
    const res = await fetch("/home/accesos", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Requested-With": "fetch",
      },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      throw new Error(data.error || "No se pudo guardar.");
    }
    return data;
  }

  function setBusy(busy) {
    [saveBtn, cancelBtn, restoreBtn, editBtn].forEach((btn) => {
      if (btn) btn.disabled = busy;
    });
  }

  saveBtn?.addEventListener("click", async () => {
    setBusy(true);
    setStatus("Guardando…");
    try {
      const data = await postPreference({
        order: idsOf(visibleEl),
        hidden: idsOf(hiddenEl),
      });
      if (!data.persisted) {
        if (snapshot) apply(snapshot);
        setEditing(false);
        setStatus("Esta cuenta no guarda la personalización.", "error");
        return;
      }
      snapshot = capture();
      setEditing(false);
      setStatus("Guardado", "ok");
    } catch (err) {
      setStatus(err.message || "No se pudo guardar.", "error");
    } finally {
      setBusy(false);
    }
  });

  restoreBtn?.addEventListener("click", async () => {
    setBusy(true);
    setStatus("Restaurando…");
    try {
      const data = await postPreference({ reset: true });
      if (!data.persisted) {
        if (snapshot) apply(snapshot);
        setEditing(false);
        setStatus("Esta cuenta no guarda la personalización.", "error");
        return;
      }
      if (!defaults.length) {
        window.location.reload();
        return;
      }
      apply({
        visible: defaults.slice(0, visibleLimit),
        hidden: defaults.slice(visibleLimit),
      });
      snapshot = capture();
      setEditing(false);
      setStatus("Orden del país restaurado", "ok");
    } catch (err) {
      setStatus(err.message || "No se pudo guardar.", "error");
    } finally {
      setBusy(false);
    }
  });

  requestAnimationFrame(() => section.classList.add("is-settled"));
})();
