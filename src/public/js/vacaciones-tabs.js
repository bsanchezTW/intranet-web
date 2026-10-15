/**
 * Pestañas de las vistas de vacaciones (Mis vacaciones y ficha del colaborador).
 *
 * El servidor marca la pestaña inicial (aria-selected) y oculta las demás con
 * `hidden`. Si la URL trae "#seccion" —las redirecciones lo usan para volver a
 * donde se hizo el cambio— se abre la pestaña que la contiene. Flechas, Inicio
 * y Fin mueven el foco entre pestañas, como pide el patrón WAI-ARIA.
 */
(function () {
  "use strict";

  function setup(root) {
    const tabs = Array.from(root.querySelectorAll('[role="tab"]'));
    const panels = tabs
      .map((tab) => document.getElementById(tab.getAttribute("aria-controls")))
      .filter(Boolean);
    if (!tabs.length) return;

    function activate(tab, { focus = false, updateHash = false } = {}) {
      tabs.forEach((t) => {
        const selected = t === tab;
        t.setAttribute("aria-selected", selected ? "true" : "false");
        t.tabIndex = selected ? 0 : -1;
        const panel = document.getElementById(t.getAttribute("aria-controls"));
        if (panel) panel.hidden = !selected;
      });
      if (focus) tab.focus();
      if (updateHash && window.history && window.history.replaceState) {
        const id = tab.getAttribute("aria-controls");
        window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#${id}`);
      }
    }

    function tabForHash(hash) {
      const id = decodeURIComponent(String(hash || "").replace(/^#/, ""));
      if (!id) return null;
      const target = document.getElementById(id);
      if (!target) return null;
      const panel = panels.find((p) => p === target || p.contains(target));
      return panel ? tabs.find((t) => t.getAttribute("aria-controls") === panel.id) : null;
    }

    tabs.forEach((tab, i) => {
      tab.addEventListener("click", () => activate(tab, { updateHash: true }));
      tab.addEventListener("keydown", (e) => {
        let next = null;
        if (e.key === "ArrowRight") next = tabs[(i + 1) % tabs.length];
        else if (e.key === "ArrowLeft") next = tabs[(i - 1 + tabs.length) % tabs.length];
        else if (e.key === "Home") next = tabs[0];
        else if (e.key === "End") next = tabs[tabs.length - 1];
        if (!next) return;
        e.preventDefault();
        activate(next, { focus: true, updateHash: true });
      });
    });

    // Enlaces internos ("ver períodos") que apuntan a otra pestaña.
    root.ownerDocument.addEventListener("click", (e) => {
      const link = e.target.closest && e.target.closest('a[href^="#"][data-vac-tab-link]');
      if (!link) return;
      const tab = tabForHash(link.getAttribute("href"));
      if (!tab) return;
      e.preventDefault();
      activate(tab, { focus: true, updateHash: true });
      root.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    const initial =
      tabForHash(window.location.hash) ||
      tabs.find((t) => t.getAttribute("aria-selected") === "true") ||
      tabs[0];
    activate(initial);

    window.addEventListener("hashchange", () => {
      const tab = tabForHash(window.location.hash);
      if (tab) activate(tab);
    });
  }

  document.querySelectorAll("[data-vac-tabs]").forEach(setup);
})();
