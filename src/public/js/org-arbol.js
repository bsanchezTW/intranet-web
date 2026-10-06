/**
 * Organigrama de áreas — búsqueda y filtros sobre el árbol.
 *
 * En un árbol no se puede ocultar un nodo sin romper las líneas que unen a
 * padres e hijos, así que buscar y filtrar resaltan: los nodos que coinciden
 * se marcan y el resto se atenúa. El primero que coincide se lleva a la vista,
 * porque en un organigrama largo puede quedar fuera de la pantalla.
 */
(function () {
  "use strict";

  var DIACRITICOS = new RegExp("[\\u0300-\\u036f]", "g");

  function todos(selector, raiz) {
    return Array.prototype.slice.call((raiz || document).querySelectorAll(selector));
  }

  function normalizar(texto) {
    var base = String(texto || "").toLowerCase();
    return base.normalize ? base.normalize("NFD").replace(DIACRITICOS, "") : base;
  }

  var PREDICADOS = {
    todas: null,
    "sin-jefe": function (nodo) { return nodo.dataset.sinJefe === "true"; },
    "sin-aprobador": function (nodo) { return nodo.dataset.sinAprobador === "true"; },
    vacias: function (nodo) { return Number(nodo.dataset.miembros || 0) === 0; },
  };

  function init() {
    var nodos = todos("[data-org-node]");
    if (!nodos.length) return;

    var input = document.querySelector("[data-org-buscar]");
    var chips = todos("[data-org-filtro]");
    var aviso = document.querySelector("[data-org-sin-resultados]");
    var conteo = document.querySelector("[data-org-conteo]");
    var estado = { texto: "", filtro: "todas" };

    function aplicar() {
      var q = normalizar(estado.texto).trim();
      var predicado = PREDICADOS[estado.filtro] || null;
      var activo = Boolean(q || predicado);
      var primero = null;
      var coincidencias = 0;

      nodos.forEach(function (nodo) {
        var coincide =
          activo &&
          (!predicado || predicado(nodo)) &&
          (!q || normalizar(nodo.dataset.buscar).indexOf(q) !== -1);
        nodo.classList.toggle("is-match", coincide);
        nodo.classList.toggle("is-dim", activo && !coincide);
        if (coincide) {
          coincidencias += 1;
          if (!primero) primero = nodo;
        }
      });

      if (aviso) aviso.hidden = !activo || coincidencias > 0;
      if (conteo) {
        conteo.hidden = !activo || coincidencias === 0;
        conteo.textContent =
          coincidencias === 1 ? "1 área resaltada" : coincidencias + " áreas resaltadas";
      }
      if (primero && primero.scrollIntoView) {
        primero.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
      }
    }

    if (input) {
      input.addEventListener("input", function () {
        estado.texto = input.value;
        aplicar();
      });
      input.addEventListener("keydown", function (evento) {
        if (evento.key !== "Escape" || !input.value) return;
        evento.stopPropagation();
        input.value = "";
        estado.texto = "";
        aplicar();
      });
    }

    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        chips.forEach(function (otro) {
          otro.classList.toggle("is-active", otro === chip);
        });
        estado.filtro = chip.dataset.orgFiltro || "todas";
        aplicar();
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
