/* Formulario del centro de gastos: desglose dinámico + adjuntos.
   El total que se muestra aquí es sólo una conveniencia: el servidor lo
   recalcula a partir de los ítems y nunca confía en lo que llegue del cliente. */
(function () {
  "use strict";

  var form = document.getElementById("formGasto");
  if (!form) return;

  var contenedor = document.getElementById("gastoItems");
  var plantilla = document.getElementById("plantillaFila");
  var btnAgregar = document.getElementById("btnAgregarFila");
  var totalEl = document.getElementById("totalCalculado");
  var adjuntoInput = document.getElementById("adjuntoInput");
  var listaAdjuntos = document.getElementById("listaAdjuntos");
  var errorEl = document.getElementById("formError");
  var btnEnviar = document.getElementById("btnEnviar");
  // Con un solo centro asignado el campo visible es de sólo lectura y el id
  // viaja en un hidden; con dos, el propio select lleva el valor.
  var centroSelect = document.getElementById("centroCosto");
  var centroHidden = document.getElementById("centroCostoValor");

  var KIND = form.dataset.kind;
  var REQUIERE_ADJUNTO = form.dataset.requiereAdjunto === "true";
  var MAX_BYTES = Number(form.dataset.maxMb || 20) * 1024 * 1024;
  var MAX_FILAS = 50;
  var MAX_ADJUNTOS = 10;

  // Comprobantes ya subidos al bucket, pendientes de asociarse a la solicitud.
  var adjuntos = [];

  // ── Total ────────────────────────────────────────────────────────────────

  /* Acepta "45.000" y "45000,50": se descartan los separadores de miles y la
     coma se trata como decimal. Es la misma normalización que hace el servidor
     en expenseRequestService.parseAmount. */
  function parseMonto(valor) {
    var raw = String(valor || "").trim();
    if (!raw) return 0;
    var n = Number(
      raw.replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."),
    );
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function recalcular() {
    var total = 0;
    contenedor.querySelectorAll('[data-campo="amount"]').forEach(function (input) {
      total += parseMonto(input.value);
    });
    totalEl.textContent = formatearMoneda(total);
  }

  /* El símbolo y los decimales de la moneda salen del total que el servidor ya
     pintó en el HTML, así no hay que duplicar la config de país en el cliente. */
  var MOLDE = totalEl.textContent;
  function formatearMoneda(valor) {
    var decimales = /[.,]\d{2}$/.test(MOLDE) ? 2 : 0;
    var partes = MOLDE.match(/^([^\d]*)/);
    var prefijo = partes ? partes[1] : "";
    var numero = valor.toFixed(decimales);
    var enteros = numero.split(".")[0];
    var resto = decimales ? "," + numero.split(".")[1] : "";
    enteros = enteros.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return prefijo + enteros + resto;
  }

  // ── Filas del desglose ───────────────────────────────────────────────────

  function agregarFila(foco) {
    if (contenedor.querySelectorAll(".gasto-item-fila").length >= MAX_FILAS) return;
    var fila = plantilla.content.cloneNode(true);
    contenedor.appendChild(fila);
    actualizarBotonesQuitar();
    if (foco) {
      var filas = contenedor.querySelectorAll(".gasto-item-fila");
      var ultima = filas[filas.length - 1];
      var detalle = ultima.querySelector('[data-campo="detail"]');
      if (detalle) detalle.focus();
    }
  }

  /* Con una sola fila el botón de quitar no tiene sentido: dejaría el desglose
     vacío, que es justo lo que el servidor rechaza. */
  function actualizarBotonesQuitar() {
    var filas = contenedor.querySelectorAll(".gasto-item-fila");
    filas.forEach(function (fila) {
      var btn = fila.querySelector("[data-quitar-fila]");
      if (btn) btn.disabled = filas.length <= 1;
    });
  }

  contenedor.addEventListener("input", function (e) {
    if (e.target.dataset.campo === "amount") recalcular();
  });

  contenedor.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-quitar-fila]");
    if (!btn || btn.disabled) return;
    btn.closest(".gasto-item-fila").remove();
    actualizarBotonesQuitar();
    recalcular();
  });

  btnAgregar.addEventListener("click", function () {
    agregarFila(true);
  });

  function leerItems() {
    var items = [];
    contenedor.querySelectorAll(".gasto-item-fila").forEach(function (fila, index) {
      items.push({
        item_date: (fila.querySelector('[data-campo="item_date"]') || {}).value || "",
        detail: (fila.querySelector('[data-campo="detail"]') || {}).value || "",
        amount: (fila.querySelector('[data-campo="amount"]') || {}).value || "",
        sort_order: index,
      });
    });
    return items;
  }

  // ── Adjuntos ─────────────────────────────────────────────────────────────

  function pintarAdjuntos() {
    while (listaAdjuntos.firstChild) listaAdjuntos.removeChild(listaAdjuntos.firstChild);

    adjuntos.forEach(function (adj, index) {
      var li = document.createElement("li");
      li.className = "gasto-adjunto";

      var nombre = document.createElement("a");
      nombre.className = "gasto-adjunto__nombre";
      nombre.href = adj.url;
      nombre.target = "_blank";
      nombre.rel = "noopener";
      nombre.textContent = adj.name;

      var quitar = document.createElement("button");
      quitar.type = "button";
      quitar.className = "gasto-adjunto__quitar";
      quitar.setAttribute("aria-label", "Quitar " + adj.name);
      quitar.textContent = "×";
      quitar.addEventListener("click", function () {
        adjuntos.splice(index, 1);
        pintarAdjuntos();
      });

      li.appendChild(nombre);
      li.appendChild(quitar);
      listaAdjuntos.appendChild(li);
    });
  }

  function subirArchivo(file) {
    var datos = new FormData();
    datos.append("archivo", file);
    return fetch("/gastos/adjuntos/upload", {
      method: "POST",
      body: datos,
      credentials: "same-origin",
    })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || "No se pudo subir el archivo.");
          return data;
        });
      })
      .then(function (data) {
        adjuntos.push({
          name: file.name,
          url: data.secure_url,
          public_id: data.public_id,
        });
      });
  }

  adjuntoInput.addEventListener("change", async function () {
    var archivos = Array.prototype.slice.call(adjuntoInput.files);
    adjuntoInput.value = "";
    limpiarError();

    for (var i = 0; i < archivos.length; i += 1) {
      var file = archivos[i];
      if (adjuntos.length >= MAX_ADJUNTOS) {
        mostrarError("Máximo " + MAX_ADJUNTOS + " comprobantes por solicitud.");
        break;
      }
      if (file.size > MAX_BYTES) {
        mostrarError('"' + file.name + '" supera el límite de ' + form.dataset.maxMb + " MB.");
        continue;
      }
      try {
        bloquear(true, "Subiendo…");
        await subirArchivo(file);
        pintarAdjuntos();
      } catch (err) {
        mostrarError(err.message);
      } finally {
        bloquear(false);
      }
    }
  });

  // ── Envío ────────────────────────────────────────────────────────────────

  function mostrarError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = "block";
  }

  function limpiarError() {
    errorEl.textContent = "";
    errorEl.style.display = "none";
  }

  function bloquear(activo, texto) {
    btnEnviar.disabled = activo;
    btnEnviar.textContent = activo ? texto || "Enviando…" : "Enviar solicitud";
  }

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    limpiarError();

    var items = leerItems().filter(function (i) {
      return i.detail.trim() || i.amount.trim();
    });

    if (!items.length) {
      return mostrarError("Agrega al menos una línea al desglose.");
    }
    if (REQUIERE_ADJUNTO && !adjuntos.length) {
      return mostrarError("Una rendición necesita al menos un comprobante adjunto.");
    }

    var centro = centroHidden ? centroHidden.value : (centroSelect ? centroSelect.value : "");
    if (!centro) {
      if (centroSelect && centroSelect.focus) centroSelect.focus();
      return mostrarError("Elige el centro de costo al que se imputa este gasto.");
    }

    var cuerpo = {
      kind: KIND,
      title: document.getElementById("titulo").value,
      description: document.getElementById("descripcion").value,
      items: items,
      attachments: adjuntos,
      cost_center_id: centro,
    };
    var neededBy = document.getElementById("neededBy");
    if (neededBy) cuerpo.needed_by = neededBy.value;

    try {
      bloquear(true);
      var res = await fetch("/gastos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(cuerpo),
      });
      var data = await res.json().catch(function () { return {}; });
      if (!res.ok) throw new Error(data.error || "No se pudo enviar la solicitud.");
      window.location.href = "/gastos?ok=1&msg=" + encodeURIComponent("Solicitud enviada.");
    } catch (err) {
      mostrarError(err.message);
      bloquear(false);
    }
  });

  // Arranca con tres líneas: casi ninguna rendición tiene una sola.
  agregarFila(false);
  agregarFila(false);
  agregarFila(false);
  recalcular();
})();
