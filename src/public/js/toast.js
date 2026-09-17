/* ==========================================================================
   Avisos flotantes de la intranet
   IntranetToast.show("Portada actualizada")
   IntranetToast.show("No se pudo guardar", { tone: "error", duration: 6000 })
   Tonos: ok (por defecto), error, info. Se apilan abajo al centro y se cierran
   solos; pasar el mouse por encima pausa la cuenta regresiva.
   ========================================================================== */
(function (global) {
  "use strict";

  var MAX_VISIBLES = 3;
  var ICONOS = {
    ok: '<polyline points="20 6 9 17 4 12"/>',
    error: '<line x1="12" y1="8" x2="12" y2="13"/><line x1="12" y1="16.5" x2="12.01" y2="16.5"/>',
    info: '<line x1="12" y1="16" x2="12" y2="11"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  };

  var pila = null;

  function contenedor() {
    if (pila && document.body.contains(pila)) return pila;
    pila = document.getElementById("toast-stack");
    if (!pila) {
      pila = document.createElement("div");
      pila.id = "toast-stack";
      pila.className = "toast-stack";
      document.body.appendChild(pila);
    }
    pila.setAttribute("aria-live", "polite");
    pila.setAttribute("aria-atomic", "false");
    return pila;
  }

  function cerrar(toast) {
    if (!toast || toast.classList.contains("is-saliendo")) return;
    clearTimeout(toast._timer);
    toast.classList.add("is-saliendo");
    var quitar = function () { toast.remove(); };
    toast.addEventListener("animationend", quitar, { once: true });
    setTimeout(quitar, 400);
  }

  function show(mensaje, opciones) {
    if (!mensaje) return null;
    var opts = opciones || {};
    var tono = ICONOS[opts.tone] ? opts.tone : "ok";
    var duracion = Number(opts.duration) || (tono === "error" ? 6500 : 4200);

    var toast = document.createElement("div");
    toast.className = "toast toast--" + tono;
    toast.setAttribute("role", tono === "error" ? "alert" : "status");
    toast.style.setProperty("--toast-duracion", duracion + "ms");
    toast.innerHTML =
      '<span class="toast__icono" aria-hidden="true">' +
        '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">' +
        ICONOS[tono] + "</svg></span>" +
      '<p class="toast__mensaje"></p>' +
      '<button type="button" class="toast__cerrar" aria-label="Cerrar aviso">' +
        '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
      "</button>" +
      '<span class="toast__progreso" aria-hidden="true"></span>';
    toast.querySelector(".toast__mensaje").textContent = mensaje;
    toast.querySelector(".toast__cerrar").addEventListener("click", function () { cerrar(toast); });

    var restante = duracion;
    var inicio = 0;
    function programar() {
      inicio = Date.now();
      toast._timer = setTimeout(function () { cerrar(toast); }, restante);
    }
    toast.addEventListener("mouseenter", function () {
      clearTimeout(toast._timer);
      restante -= Date.now() - inicio;
      toast.classList.add("is-pausado");
    });
    toast.addEventListener("mouseleave", function () {
      toast.classList.remove("is-pausado");
      programar();
    });

    var destino = contenedor();
    destino.appendChild(toast);
    var visibles = destino.querySelectorAll(".toast:not(.is-saliendo)");
    if (visibles.length > MAX_VISIBLES) cerrar(visibles[0]);
    programar();
    return toast;
  }

  global.IntranetToast = { show: show };
})(window);
