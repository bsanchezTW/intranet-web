/**
 * Campo de documento de identidad: formatea mientras se escribe y avisa antes
 * de enviar. El servidor revalida siempre (utils/nationalId.js); esto sólo
 * evita el viaje de ida y vuelta.
 *
 * Uso en la vista:
 *   <div class="campo-form"><input data-national-id ...></div>
 * y un <script type="application/json" id="national-id-config"> con lo que
 * devuelve nationalIdClientConfig().
 *
 * Los campos que ya están en la página se enlazan solos. Los que llegan
 * después —el modal de edición se trae por fetch— hay que enlazarlos a mano:
 *   NationalIdField.init(nodoRecienInsertado)
 */
(function (global) {
  "use strict";

  var config = leerConfig();

  function leerConfig() {
    var nodo = document.getElementById("national-id-config");
    if (!nodo) return {};
    try {
      return JSON.parse(nodo.textContent) || {};
    } catch (error) {
      console.error("[Documento] Configuración inicial inválida:", error);
      return {};
    }
  }

  function limpiar(valor) {
    return String(valor || "").replace(/[.\s-]/g, "").toUpperCase();
  }

  // Módulo 11, misma serie 2..7 que utils/nationalId.js.
  function digitoVerificador(cuerpo) {
    var suma = 0;
    var factor = 2;
    for (var i = cuerpo.length - 1; i >= 0; i -= 1) {
      suma += Number(cuerpo[i]) * factor;
      factor = factor === 7 ? 2 : factor + 1;
    }
    var resto = 11 - (suma % 11);
    if (resto === 11) return "0";
    if (resto === 10) return "K";
    return String(resto);
  }

  function agruparMiles(digitos) {
    return String(digitos).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  function esValido(valor) {
    var limpio = limpiar(valor);
    if (!limpio) return true; // vacío: lo decide `required`, no este validador

    if (config.kind === "dni") return /^\d{8}$/.test(limpio);

    if (limpio.length < 8 || limpio.length > 9) return false;
    var cuerpo = limpio.slice(0, -1);
    var dv = limpio.slice(-1);
    if (!/^\d+$/.test(cuerpo) || !/^[\dK]$/.test(dv)) return false;
    if (Number(cuerpo) < 1000000) return false;
    return digitoVerificador(cuerpo) === dv;
  }

  /** Va formateando a medida que se teclea, sin estorbar al que aún escribe. */
  function formatearParcial(valor) {
    var limpio = limpiar(valor);
    if (config.kind === "dni") return limpio.replace(/\D/g, "").slice(0, 8);

    limpio = limpio.replace(/[^\dK]/g, "").slice(0, 9);
    if (limpio.length <= 1) return limpio;
    var cuerpo = limpio.slice(0, -1).replace(/\D/g, "");
    var dv = limpio.slice(-1);
    return agruparMiles(cuerpo) + "-" + dv;
  }

  function marcar(input, mensaje) {
    if (global.CampoForm) return global.CampoForm.marcar(input, mensaje);
    input.setCustomValidity(mensaje || "");
  }

  /** @returns {boolean} true si el valor actual del campo es aceptable. */
  function revisar(input) {
    var valor = input.value.trim();
    if (!valor) {
      marcar(input, input.required ? config.label + " requerido" : "");
      return !input.required;
    }
    var ok = esValido(valor);
    marcar(input, ok ? "" : config.errorMessage);
    return ok;
  }

  function enlazar(input) {
    if (!config.kind) return;
    if (input.dataset.nationalIdListo === "1") return;
    input.dataset.nationalIdListo = "1";

    if (config.maxLength) input.setAttribute("maxlength", String(config.maxLength));
    if (config.example && !input.getAttribute("placeholder")) {
      input.setAttribute("placeholder", config.example);
    }

    input.addEventListener("input", function () {
      // Sólo reescribe cuando el cursor está al final: reformatear en medio de
      // una edición mueve el cursor y hace imposible corregir un dígito.
      var alFinal = input.selectionStart === input.value.length;
      var formateado = formatearParcial(input.value);
      if (alFinal && formateado !== input.value) {
        input.value = formateado;
      }
      marcar(input, "");
    });

    input.addEventListener("blur", function () {
      if (input.value.trim()) input.value = formatearParcial(input.value.trim());
      revisar(input);
    });

    var form = input.closest("form");
    if (!form || form.dataset.nationalIdListo === "1") return;
    form.dataset.nationalIdListo = "1";
    form.addEventListener("submit", function (evento) {
      var invalidos = Array.prototype.filter.call(
        form.querySelectorAll("[data-national-id]"),
        function (campo) {
          return !revisar(campo);
        },
      );
      if (!invalidos.length) return;
      evento.preventDefault();
      if (global.CampoForm) global.CampoForm.enfocarPrimerError(form);
      else invalidos[0].focus();
    });
  }

  /** Enlaza los campos que haya dentro de `raiz` (el documento por defecto). */
  function init(raiz) {
    var ambito = raiz || document;
    ambito.querySelectorAll("[data-national-id]").forEach(enlazar);
  }

  global.NationalIdField = {
    init: init,
    esValido: esValido,
    revisar: revisar,
    CONFIG: config,
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      init();
    });
  } else {
    init();
  }
})(window);
