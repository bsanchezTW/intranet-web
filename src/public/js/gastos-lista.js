/* Filtro cliente de las listas del centro de gastos.
   Trabaja sobre los data-* que ya trae cada <li>, igual que tickets-list.js.
   Soporta varias listas en la misma página (la gestión tiene dos). */
(function () {
  "use strict";

  // Un borrador también está "en curso": es trabajo que el colaborador dejó a medias.
  var ACTIVOS = ["draft", "pending", "approved_manager"];

  document.querySelectorAll("[data-gastos-lista]").forEach(function (lista) {
    // El panel es el ancestro común de la barra de filtros y de la lista.
    var panel = lista.closest(".gastos-panel") || document;
    var buscador = panel.querySelector("[data-gastos-buscar]");
    var chips = panel.querySelectorAll("[data-filtro-estado]");
    var vacio = panel.querySelector("[data-gastos-vacio]");
    var items = lista.querySelectorAll(".gasto-item");
    if (!items.length) return;

    var estado = "activos";
    var busqueda = "";

    function coincideEstado(item) {
      if (estado === "todos") return true;
      if (estado === "activos") return ACTIVOS.indexOf(item.dataset.estado) !== -1;
      return item.dataset.estado === estado;
    }

    function aplicar() {
      var visibles = 0;
      items.forEach(function (item) {
        var ok =
          coincideEstado(item) &&
          (!busqueda || (item.dataset.buscar || "").indexOf(busqueda) !== -1);
        item.hidden = !ok;
        if (ok) visibles += 1;
      });
      if (vacio) vacio.hidden = visibles > 0;
    }

    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        chips.forEach(function (c) {
          c.classList.toggle("is-active", c === chip);
        });
        estado = chip.dataset.filtroEstado;
        aplicar();
      });
    });

    if (buscador) {
      buscador.addEventListener("input", function () {
        busqueda = buscador.value.trim().toLowerCase();
        aplicar();
      });
    }

    // Si el chip activo del HTML no es el de por defecto, respetarlo.
    var activo = panel.querySelector("[data-filtro-estado].is-active");
    if (activo) estado = activo.dataset.filtroEstado;

    aplicar();
  });
})();
