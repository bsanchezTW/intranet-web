/**
 * Selector de centros de costo de la ficha de un colaborador.
 *
 * El tope por persona lo revalida el servidor; esto sólo evita que alguien
 * marque cuatro casillas y descubra el límite al guardar. Se engancha por
 * delegación porque el modal de edición llega por fetch después de cargar la
 * página.
 */
(function () {
  "use strict";

  function todos(selector, raiz) {
    return Array.prototype.slice.call(
      (raiz || document).querySelectorAll(selector),
    );
  }

  function sincronizar(picker) {
    var max = Number(picker.dataset.max || 0);
    if (!max) return;

    var casillas = todos(".centros-picker__check", picker);
    var marcadas = casillas.filter(function (c) {
      return c.checked;
    });
    var tope = marcadas.length >= max;

    casillas.forEach(function (casilla) {
      // Deshabilitar sólo las que no están marcadas: si no, no habría forma de
      // soltar una para elegir otra.
      casilla.disabled = tope && !casilla.checked;
      casilla.closest(".centros-picker__item").classList.toggle(
        "is-bloqueada",
        casilla.disabled,
      );
    });

    var aviso = picker.parentElement
      ? picker.parentElement.querySelector("[data-centros-tope]")
      : null;
    if (aviso) aviso.hidden = !tope;
  }

  function init() {
    document.addEventListener("change", function (evento) {
      var casilla = evento.target;
      if (!casilla || !casilla.classList) return;
      if (!casilla.classList.contains("centros-picker__check")) return;
      var picker = casilla.closest("[data-centros-picker]");
      if (picker) sincronizar(picker);
    });

    // El modal de edición llega ya con casillas marcadas desde el servidor, y
    // hay que reflejar el tope antes de que el usuario toque nada. Sólo se
    // recalcula cuando el nodo insertado trae un selector dentro.
    var observador = new MutationObserver(function (mutaciones) {
      var hay = mutaciones.some(function (m) {
        return Array.prototype.some.call(m.addedNodes, function (nodo) {
          if (nodo.nodeType !== 1) return false;
          return (
            nodo.matches("[data-centros-picker]") ||
            !!nodo.querySelector("[data-centros-picker]")
          );
        });
      });
      if (hay) todos("[data-centros-picker]").forEach(sincronizar);
    });
    observador.observe(document.body, { childList: true, subtree: true });

    todos("[data-centros-picker]").forEach(sincronizar);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
