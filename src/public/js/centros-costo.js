/**
 * RR.HH. · Centros de costo — modal crear/editar y confirmaciones.
 *
 * Reusa un solo formulario para crear y editar cambiando `action`, igual que
 * areas.js. La diferencia: al crear no se ofrece el interruptor de activo (un
 * centro nace activo), y al editar sí.
 */
(function () {
  "use strict";

  function leerConfig() {
    var nodo = document.getElementById("centros-config");
    if (!nodo) return {};
    try {
      return JSON.parse(nodo.textContent) || {};
    } catch (error) {
      console.error("[Centros de costo] Configuración inicial inválida:", error);
      return {};
    }
  }

  /** Confirmación genérica: el texto viaja en data-confirmar. */
  function initConfirmaciones() {
    document.addEventListener("submit", function (evento) {
      var form = evento.target;
      if (!form || form.tagName !== "FORM") return;
      var boton = form.querySelector("[data-confirmar]");
      if (!boton || boton.disabled) return;
      window.IntranetDialog.confirmarEnvio(evento, {
        title: boton.dataset.confirmarTitulo || "¿Confirmas el cambio?",
        message: boton.dataset.confirmar,
        acceptLabel: boton.dataset.confirmarAceptar || "Confirmar",
        tone: boton.dataset.confirmarTono || "normal",
      });
    });
  }

  function initModal() {
    var overlay = document.getElementById("modalCentro");
    var form = document.getElementById("formCentro");
    if (!overlay || !form) return;

    var titulo = document.getElementById("modalCentroTitle");
    var submit = document.getElementById("modalCentroSubmit");
    var code = document.getElementById("centro_code");
    var name = document.getElementById("centro_name");
    var campoActivo = document.getElementById("campoActivo");
    var activo = document.getElementById("centro_active");

    function abrirCrear() {
      form.action = "/RRHH/centros-costo";
      titulo.textContent = "Agregar centro de costo";
      submit.textContent = "Crear centro";
      code.value = "";
      name.value = "";
      // Un centro nuevo siempre nace activo: preguntarlo sólo añade un paso.
      campoActivo.hidden = true;
      activo.checked = true;
      if (window.IntranetModal) window.IntranetModal.open(overlay);
      code.focus();
    }

    function abrirEditar(datos) {
      form.action = "/RRHH/centros-costo/" + encodeURIComponent(datos.id);
      titulo.textContent = "Editar centro de costo";
      submit.textContent = "Guardar cambios";
      code.value = datos.code || "";
      name.value = datos.name || "";
      campoActivo.hidden = false;
      activo.checked = datos.active !== "false";
      if (window.IntranetModal) window.IntranetModal.open(overlay);
      code.focus();
    }

    var disparador = document.querySelector("[data-abrir-crear-centro]");
    if (disparador) {
      disparador.addEventListener("click", function () {
        abrirCrear();
      });
    }

    document.addEventListener("click", function (evento) {
      var btn =
        evento.target && evento.target.closest
          ? evento.target.closest("[data-editar-centro]")
          : null;
      if (!btn) return;
      abrirEditar(btn.dataset);
    });

    // El código se guarda en mayúsculas; mostrarlo así mientras se escribe
    // evita la sorpresa de que cambie al recargar.
    code.addEventListener("input", function () {
      var pos = code.selectionStart;
      code.value = code.value.toUpperCase();
      code.setSelectionRange(pos, pos);
    });
  }

  function init() {
    var config = leerConfig();
    initConfirmaciones();
    if (config.puedeEditar) initModal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
