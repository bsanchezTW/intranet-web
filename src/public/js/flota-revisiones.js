/**
 * Gestión de flota: el botón «Revisiones» de cada tarjeta despliega ahí
 * mismo las revisiones del vehículo (las pide la primera vez). Sin JS es un
 * enlace a la página de revisiones del vehículo.
 */
(function () {
  document.querySelectorAll("[data-revisiones]").forEach((boton) => {
    const panel = document.getElementById(boton.getAttribute("aria-controls"));
    if (!panel) return;
    let cargado = false;

    boton.addEventListener("click", async (e) => {
      // Ctrl/Cmd-clic o clic del medio: que abra la página como enlace.
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
      e.preventDefault();
      const abrir = boton.getAttribute("aria-expanded") !== "true";
      boton.setAttribute("aria-expanded", String(abrir));
      boton.closest(".flota-card")?.classList.toggle("is-desplegada", abrir);
      panel.hidden = !abrir;
      if (!abrir || cargado) return;

      panel.innerHTML = '<p class="rev-lista__vacia" role="status">Cargando revisiones…</p>';
      try {
        const res = await fetch(boton.dataset.revisiones, {
          credentials: "same-origin",
          headers: { Accept: "text/html", "X-Requested-With": "fetch" },
        });
        if (!res.ok) throw new Error(String(res.status));
        // HTML de la propia intranet (la parcial de revisiones del vehículo).
        panel.innerHTML = await res.text();
        cargado = true;
      } catch (err) {
        console.error("[flota-revisiones]", err);
        window.location.href = boton.href;
      }
    });
  });
})();
