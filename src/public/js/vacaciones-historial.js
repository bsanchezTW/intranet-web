/* ==========================================================================
   Historial de vacaciones previas a la intranet.

   Un solo modal para registrar y para editar: cambia la acción del formulario
   y los valores. El resto (abrir, cerrar, apilar, Escape) lo hace modal.js.
   ========================================================================== */
(function () {
  "use strict";

  const form = document.getElementById("formHistorial");
  if (!form) return;

  const modalId = "modalHistorial";
  const titulo = document.getElementById("modalHistorialTitulo");
  const subtitulo = document.getElementById("modalHistorialSubtitulo");
  const submit = document.getElementById("historialSubmit");
  const detailMode = document.getElementById("detail_mode");
  const fechas = document.getElementById("historialFechas");
  const inicio = document.getElementById("hist_start_date");
  const fin = document.getElementById("hist_end_date");
  const dias = document.getElementById("days_used");
  const anio = document.getElementById("period_year");
  const mes = document.getElementById("period_month");
  const observacion = document.getElementById("observation");
  const hintDias = document.getElementById("historialDiasHint");

  const accionCrear = form.getAttribute("action");
  const textoSubtitulo = subtitulo ? subtitulo.textContent.trim() : "";

  /** Días calendario entre dos fechas, ambas incluidas. */
  function contarDiasCalendario(desde, hasta) {
    const a = new Date(desde + "T12:00:00Z");
    const b = new Date(hasta + "T12:00:00Z");
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
    return Math.round((b - a) / 86400000) + 1;
  }

  /**
   * En modo detallado los días salen de las fechas y el campo queda de solo
   * lectura: si se pudieran editar por separado, el registro quedaría
   * contradictorio y el backend lo rechazaría.
   */
  function sincronizarModo() {
    const detallado = detailMode.value === "DETAILED";
    fechas.hidden = !detallado;
    inicio.required = detallado;
    fin.required = detallado;
    dias.readOnly = detallado;
    if (hintDias) {
      hintDias.textContent = detallado
        ? "Se calcula a partir de las fechas. Días calendario."
        : "Días calendario, como los cuenta la ley peruana.";
    }
    if (detallado) calcularDias();
  }

  function calcularDias() {
    if (detailMode.value !== "DETAILED") return;
    if (!inicio.value || !fin.value) return;
    const n = contarDiasCalendario(inicio.value, fin.value);
    if (n < 1) return;
    dias.value = String(n);
    // El año y el mes se toman del inicio del período: son el mismo dato.
    const [y, m] = inicio.value.split("-");
    if (y) anio.value = y;
    if (m) mes.value = String(Number(m));
  }

  function abrirNuevo() {
    form.setAttribute("action", accionCrear);
    form.reset();
    detailMode.value = "SUMMARY";
    if (titulo) titulo.textContent = "Registrar vacaciones históricas";
    if (subtitulo) subtitulo.textContent = textoSubtitulo;
    if (submit) submit.textContent = "Guardar período";
    sincronizarModo();
    window.IntranetModal.open(modalId);
    window.setTimeout(() => anio.focus(), 60);
  }

  function abrirEdicion(boton) {
    const d = boton.dataset;
    form.setAttribute("action", `${accionCrear}/${d.id}/editar`);
    detailMode.value = d.start ? "DETAILED" : "SUMMARY";
    anio.value = d.year || "";
    mes.value = d.month || "";
    inicio.value = d.start || "";
    fin.value = d.end || "";
    dias.value = d.days || "";
    observacion.value = d.observation || "";
    if (titulo) titulo.textContent = "Editar vacaciones históricas";
    if (subtitulo) subtitulo.textContent = `Período ${d.period || ""}`;
    if (submit) submit.textContent = "Guardar cambios";
    sincronizarModo();
    window.IntranetModal.open(modalId);
    window.setTimeout(() => dias.focus(), 60);
  }

  const btnNuevo = document.getElementById("btnNuevoHistorial");
  if (btnNuevo) btnNuevo.addEventListener("click", abrirNuevo);

  document.querySelectorAll(".js-editar-historial").forEach((boton) => {
    boton.addEventListener("click", () => abrirEdicion(boton));
  });

  detailMode.addEventListener("change", sincronizarModo);
  inicio.addEventListener("change", calcularDias);
  fin.addEventListener("change", calcularDias);

  sincronizarModo();
})();
