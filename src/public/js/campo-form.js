/**
 * Estado de error de un campo `.campo-form`.
 *
 * Un solo lugar decide cómo se ve un campo mal rellenado: borde rojo y una
 * línea corta debajo ("RUT incorrecto"). Antes cada formulario resolvía esto
 * por su cuenta —unos con setCustomValidity, otros con un <span> propio— y el
 * mismo error se veía distinto según la pantalla.
 */
(function (global) {
  "use strict";

  function contenedor(control) {
    if (!control) return null;
    return control.closest ? control.closest(".campo-form") : null;
  }

  /** El <span> del mensaje; se crea si la vista no lo puso. */
  function nodoError(campo) {
    if (!campo) return null;
    var nodo = campo.querySelector(".campo-form__error");
    if (!nodo) {
      nodo = document.createElement("span");
      nodo.className = "campo-form__error";
      nodo.setAttribute("role", "alert");
      campo.appendChild(nodo);
    }
    return nodo;
  }

  /**
   * @param {Element} control input, select o el propio .campo-form
   * @param {string}  mensaje vacío para limpiar el error
   */
  function marcar(control, mensaje) {
    var campo = contenedor(control);
    if (!campo) return;

    var texto = String(mensaje || "");
    campo.classList.toggle("is-invalid", Boolean(texto));

    var nodo = nodoError(campo);
    if (nodo) nodo.textContent = texto;

    // El mensaje ya se ve en la página: la burbuja nativa sólo repetiría lo
    // mismo tapando el campo. Se deja vacía para que el submit no se bloquee
    // por un customValidity que el usuario no puede ver.
    if (control && typeof control.setCustomValidity === "function") {
      control.setCustomValidity("");
    }
  }

  function limpiar(control) {
    marcar(control, "");
  }

  /** true si el campo quedó marcado como inválido. */
  function esInvalido(control) {
    var campo = contenedor(control);
    return Boolean(campo && campo.classList.contains("is-invalid"));
  }

  /** Lleva el foco al primer campo con error del formulario. */
  function enfocarPrimerError(form) {
    if (!form) return;
    var campo = form.querySelector(".campo-form.is-invalid");
    if (!campo) return;
    var control = campo.querySelector("input, select, textarea");
    if (control) control.focus();
    campo.scrollIntoView({ block: "center", behavior: "smooth" });
  }

  global.CampoForm = {
    marcar: marcar,
    limpiar: limpiar,
    esInvalido: esInvalido,
    enfocarPrimerError: enfocarPrimerError,
  };
})(window);
