/* ==========================================================================
   Ficha de vacaciones de un colaborador (RR.HH.).

   - Carga por lotes del historial previo a la intranet: filas editables,
     vista previa del servidor mientras se escribe y guardado todo-o-nada.
   - Modal para editar una salida ya guardada.
   - Modal para corregir fecha de ingreso y documento.
   - Formulario de récord vacacional.

   Abrir, cerrar, apilar y Escape de los modales los hace modal.js.
   ========================================================================== */
(function () {
  "use strict";

  /** Días calendario entre dos fechas 'YYYY-MM-DD', ambas incluidas. */
  function contarDiasCalendario(desde, hasta) {
    const a = new Date(desde + "T12:00:00Z");
    const b = new Date(hasta + "T12:00:00Z");
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return 0;
    return Math.round((b - a) / 86400000) + 1;
  }

  /**
   * Con las dos fechas, los días y el mes salen de ellas y el campo de días
   * queda de solo lectura: editarlos por separado dejaría el registro
   * contradictorio y el servidor lo rechazaría.
   */
  function sincronizarFechas({ inicio, fin, dias, mes }) {
    const conFechas = Boolean(inicio.value && fin.value);
    dias.readOnly = conFechas;
    if (!conFechas) return;
    const n = contarDiasCalendario(inicio.value, fin.value);
    if (n >= 1) dias.value = String(n);
    mes.value = inicio.value.slice(0, 7);
  }

  function crear(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  // ========================================================================
  // Carga por lotes
  // ========================================================================
  const lote = document.getElementById("cargaLote");
  const btnCargar = document.getElementById("btnCargarSalidas");

  if (lote && btnCargar) {
    const cuerpo = document.getElementById("cargaLoteFilas");
    const plantilla = document.getElementById("cargaLoteFila");
    const resumen = document.getElementById("cargaLoteResumen");
    const btnAgregar = document.getElementById("cargaLoteAgregar");
    const btnGuardar = document.getElementById("cargaLoteGuardar");
    const btnCancelar = document.getElementById("cargaLoteCancelar");
    const { previewUrl, saveUrl, maxMonth, minMonth } = lote.dataset;

    let temporizador = null;
    let secuencia = 0;
    let guardando = false;

    const filas = () => Array.from(cuerpo.querySelectorAll("tr.vac-lote__fila"));

    function leerFila(tr) {
      const valor = (name) => tr.querySelector(`[name="${name}"]`).value.trim();
      return {
        month: valor("month"),
        days: valor("days"),
        start: valor("start"),
        end: valor("end"),
        observation: valor("observation"),
      };
    }

    const filaVacia = (f) => Object.values(f).every((v) => v === "");
    const hayDatos = () => filas().some((tr) => !filaVacia(leerFila(tr)));

    function agregarFila() {
      const fragmento = plantilla.content.cloneNode(true);
      const tr = fragmento.querySelector("tr");
      const mes = tr.querySelector('[name="month"]');
      if (maxMonth) mes.max = maxMonth;
      if (minMonth) mes.min = minMonth;
      cuerpo.appendChild(fragmento);
      actualizarQuitar();
      mes.focus();
      return tr;
    }

    function actualizarQuitar() {
      const lista = filas();
      lista.forEach((tr) => {
        tr.querySelector(".js-quitar-fila").disabled = lista.length === 1;
      });
    }

    function abrir() {
      lote.hidden = false;
      btnCargar.setAttribute("aria-expanded", "true");
      if (filas().length === 0) agregarFila();
      else filas()[0].querySelector('[name="month"]').focus();
      lote.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    function cerrar() {
      lote.hidden = true;
      btnCargar.setAttribute("aria-expanded", "false");
      cuerpo.replaceChildren();
      resumen.replaceChildren();
      btnGuardar.disabled = true;
      btnCargar.focus();
    }

    async function cancelar() {
      if (hayDatos()) {
        const ok = await window.IntranetDialog.confirm({
          title: "¿Descartar la carga?",
          message: "Las filas que escribiste no se guardaron.",
          acceptLabel: "Descartar",
          tone: "peligro",
        });
        if (!ok) return;
      }
      cerrar();
    }

    function programarVistaPrevia() {
      secuencia += 1; // invalida cualquier respuesta en vuelo
      btnGuardar.disabled = true;
      window.clearTimeout(temporizador);
      temporizador = window.setTimeout(vistaPrevia, 350);
    }

    async function pedir(url, rows) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ rows }),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data };
    }

    async function vistaPrevia() {
      const actual = ++secuencia;
      const rows = filas().map(leerFila);
      if (rows.every(filaVacia)) {
        pintar(null);
        return;
      }
      try {
        const { ok, data } = await pedir(previewUrl, rows);
        if (actual !== secuencia) return; // llegó una respuesta más nueva
        if (!ok) {
          pintarErrorGeneral((data.errors || []).join(" ") || "No se pudo revisar la carga.");
          return;
        }
        pintar(data);
      } catch {
        if (actual === secuencia) pintarErrorGeneral("No se pudo revisar la carga. Revisa tu conexión.");
      }
    }

    function pintarErrorGeneral(mensaje) {
      resumen.replaceChildren(crear("div", "vac-preview vac-preview-error", mensaje));
      btnGuardar.disabled = true;
    }

    /** Estado de cada fila y resumen del saldo antes → después. */
    function pintar(preview) {
      const lista = filas();
      lista.forEach((tr, i) => {
        const celda = tr.querySelector(".vac-lote__estado");
        const info = preview ? preview.rows[i] : null;
        celda.replaceChildren();
        tr.classList.remove("is-error", "is-aviso");
        if (!info || info.blank) return;

        if (info.errors.length) {
          tr.classList.add("is-error");
          info.errors.forEach((e) => celda.appendChild(crear("span", "vac-lote__msg vac-lote__msg--error", e)));
          return;
        }
        const chips = crear("span", "vac-chips");
        info.allocations.forEach((a) => chips.appendChild(crear("span", "vac-chip", `${a.label} · ${a.days} d`)));
        if (info.unallocated > 0) {
          chips.appendChild(crear("span", "vac-chip vac-chip--alerta", `${info.unallocated} d sin período`));
        }
        celda.appendChild(chips);
        if (info.warnings.length) {
          tr.classList.add("is-aviso");
          info.warnings.forEach((w) => celda.appendChild(crear("span", "vac-lote__msg vac-lote__msg--aviso", w)));
        }
      });

      resumen.replaceChildren();
      if (!preview) {
        btnGuardar.disabled = true;
        btnGuardar.textContent = "Guardar salidas";
        return;
      }

      const stats = crear("div", "vac-preview-stats");
      const stat = (label, value, tono) => {
        const caja = crear("div", "vac-preview-stat" + (tono ? ` vac-preview-stat--${tono}` : ""));
        caja.append(crear("div", "vac-preview-stat__label", label), crear("div", "vac-preview-stat__value", value));
        stats.appendChild(caja);
      };
      stat("Salidas", String(preview.entries));
      stat("Días a cargar", String(preview.addedDays));
      stat(
        "Saldo disponible",
        `${preview.before.availableDays} → ${preview.after.availableDays}`,
        preview.after.availableDays < 0 ? "error" : "ok",
      );
      if (preview.after.unimputedDays > 0) {
        stat("Sin período", `${preview.after.unimputedDays} d`, "warn");
      }
      if (preview.errorCount > 0) stat("Filas con error", String(preview.errorCount), "error");
      resumen.appendChild(stats);

      if (preview.after.unimputedDays > 0) {
        resumen.appendChild(
          crear(
            "p",
            "vac-hint vac-lote__nota",
            "Hay más días cargados que días generados. Puede ser un adelanto, " +
              "una salida repetida o una fecha de ingreso mal puesta: revísalo antes de guardar.",
          ),
        );
      }

      btnGuardar.disabled = !preview.valid;
      btnGuardar.textContent = preview.entries
        ? `Guardar ${preview.entries} salida${preview.entries === 1 ? "" : "s"}`
        : "Guardar salidas";
    }

    async function guardar() {
      if (guardando) return;
      guardando = true;
      btnGuardar.disabled = true;
      const texto = btnGuardar.textContent;
      btnGuardar.textContent = "Guardando…";
      try {
        const { ok, data } = await pedir(saveUrl, filas().map(leerFila));
        if (ok && data.redirect) {
          window.removeEventListener("beforeunload", avisarSalida);
          window.location.href = data.redirect;
          return;
        }
        if (data.preview) pintar(data.preview);
        resumen.prepend(
          crear("div", "vac-preview vac-preview-error", (data.errors || []).join(" ") || "No se pudo guardar."),
        );
      } catch {
        pintarErrorGeneral("No se pudo guardar. Revisa tu conexión e inténtalo de nuevo.");
      } finally {
        guardando = false;
        if (btnGuardar.textContent === "Guardando…") btnGuardar.textContent = texto;
      }
    }

    function avisarSalida(evento) {
      if (!lote.hidden && hayDatos()) {
        evento.preventDefault();
        evento.returnValue = "";
      }
    }

    // --- eventos -----------------------------------------------------------
    btnCargar.addEventListener("click", () => (lote.hidden ? abrir() : cancelar()));
    btnCancelar.addEventListener("click", cancelar);
    btnAgregar.addEventListener("click", agregarFila);
    btnGuardar.addEventListener("click", guardar);
    window.addEventListener("beforeunload", avisarSalida);

    cuerpo.addEventListener("input", (evento) => {
      const tr = evento.target.closest("tr");
      if (!tr) return;
      const campo = evento.target.name;
      if (campo === "start" || campo === "end") {
        sincronizarFechas({
          inicio: tr.querySelector('[name="start"]'),
          fin: tr.querySelector('[name="end"]'),
          dias: tr.querySelector('[name="days"]'),
          mes: tr.querySelector('[name="month"]'),
        });
      }
      programarVistaPrevia();
    });

    cuerpo.addEventListener("click", (evento) => {
      const boton = evento.target.closest(".js-quitar-fila");
      if (!boton) return;
      const tr = boton.closest("tr");
      const siguiente = tr.nextElementSibling || tr.previousElementSibling;
      tr.remove();
      actualizarQuitar();
      if (siguiente) siguiente.querySelector('[name="month"]').focus();
      programarVistaPrevia();
    });

    // Enter avanza como en una planilla: en la última fila agrega otra.
    cuerpo.addEventListener("keydown", (evento) => {
      if (evento.key !== "Enter" || evento.target.tagName !== "INPUT") return;
      evento.preventDefault();
      const tr = evento.target.closest("tr");
      const siguiente = tr.nextElementSibling;
      if (siguiente) siguiente.querySelector('[name="month"]').focus();
      else agregarFila();
    });
  }

  // ========================================================================
  // Editar una salida guardada
  // ========================================================================
  const formHistorial = document.getElementById("formHistorial");
  if (formHistorial) {
    const base = formHistorial.getAttribute("action");
    const subtitulo = document.getElementById("modalHistorialSubtitulo");
    const campos = {
      mes: document.getElementById("hist_month"),
      inicio: document.getElementById("hist_start_date"),
      fin: document.getElementById("hist_end_date"),
      dias: document.getElementById("days_used"),
    };
    const observacion = document.getElementById("observation");

    document.querySelectorAll(".js-editar-historial").forEach((boton) => {
      boton.addEventListener("click", () => {
        const d = boton.dataset;
        formHistorial.setAttribute("action", `${base}/${d.id}/editar`);
        campos.mes.value = d.month || "";
        campos.inicio.value = d.start || "";
        campos.fin.value = d.end || "";
        campos.dias.value = d.days || "";
        observacion.value = d.observation || "";
        if (subtitulo) subtitulo.textContent = `Salida de ${d.period || ""}`;
        sincronizarFechas(campos);
        window.IntranetModal.open("modalHistorial");
        window.setTimeout(() => campos.dias.focus(), 60);
      });
    });

    campos.inicio.addEventListener("change", () => sincronizarFechas(campos));
    campos.fin.addEventListener("change", () => sincronizarFechas(campos));
  }

  // ========================================================================
  // Corregir fecha de ingreso y documento
  // ========================================================================
  const btnDatos = document.getElementById("btnEditarDatos");
  if (btnDatos) {
    btnDatos.addEventListener("click", () => {
      window.IntranetModal.open("modalDatos");
      window.setTimeout(() => document.getElementById("datos_hire_date").focus(), 60);
    });
  }

  // ========================================================================
  // Récord vacacional: la acción depende del período elegido
  // ========================================================================
  const recordForm = document.getElementById("recordForm");
  if (recordForm) {
    const periodo = document.getElementById("record_period_id");
    const cumplido = document.getElementById("record_met_check");
    const motivo = document.getElementById("record_notes");
    const accion = recordForm.getAttribute("action").replace(/\/periodo\/[^/]+\/record$/, "");
    periodo.addEventListener("change", () => {
      recordForm.setAttribute("action", `${accion}/periodo/${encodeURIComponent(periodo.value)}/record`);
    });
    cumplido.addEventListener("change", () => {
      motivo.required = !cumplido.checked;
    });
  }
})();
