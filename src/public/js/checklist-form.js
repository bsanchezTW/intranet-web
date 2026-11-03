/**
 * Formulario del checklist de vehículos: resultado en vivo, observación al
 * lado de cada ítem marcado "No", "Todo Sí" por categoría, ficha del
 * vehículo elegido (documentos y mantención) y el conductor escrito a mano.
 * Sin JS el formulario funciona igual: el servidor valida y calcula.
 */
(function () {
  const form = document.getElementById("checklistForm");
  if (!form) return;

  const RESULTADOS = {
    apto: { texto: "Apto", clase: "apto" },
    observado: { texto: "Apto con observaciones", clase: "observado" },
    no_apto: { texto: "No apto: el vehículo no debe salir", clase: "no_apto" },
  };

  const items = Array.from(form.querySelectorAll("[data-item]"));
  const resultado = document.querySelector("[data-resultado-texto]");

  function respuesta(item) {
    const marcada = item.querySelector('input[type="radio"]:checked');
    return marcada ? marcada.value : "";
  }

  // La observación aparece al marcar No y se queda si ya tiene texto.
  function actualizarItem(item) {
    const no = respuesta(item) === "falla";
    item.classList.toggle("is-no", no);
    const nota = item.querySelector("[data-nota]");
    if (!nota) return;
    const input = nota.querySelector("input");
    nota.hidden = !no && !input.value.trim();
  }

  function actualizarResultado() {
    if (!resultado) return;
    let faltan = 0;
    let noes = 0;
    let criticos = 0;
    for (const item of items) {
      const r = respuesta(item);
      if (!r) faltan += 1;
      if (r === "falla") {
        noes += 1;
        if (item.dataset.critico === "1") criticos += 1;
      }
    }
    const info = RESULTADOS[criticos ? "no_apto" : noes ? "observado" : "apto"];
    resultado.innerHTML = "";
    const badge = document.createElement("span");
    badge.className = `logistica-estado logistica-estado--${info.clase}`;
    badge.textContent = info.texto;
    resultado.appendChild(badge);
    if (faltan) {
      const pendiente = document.createElement("span");
      pendiente.textContent = ` · ${faltan === 1 ? "falta 1 ítem" : `faltan ${faltan} ítems`}`;
      resultado.appendChild(pendiente);
    }
  }

  form.addEventListener("change", (event) => {
    const item = event.target.closest("[data-item]");
    if (!item || event.target.type !== "radio") return;
    item.classList.remove("is-invalid");
    actualizarItem(item);
    if (respuesta(item) === "falla") {
      const input = item.querySelector("[data-nota] input");
      if (input) input.focus();
    }
    actualizarResultado();
  });

  form.querySelectorAll("[data-todo-ok]").forEach((boton) => {
    boton.addEventListener("click", () => {
      boton.closest("[data-grupo]").querySelectorAll("[data-item]").forEach((item) => {
        if (respuesta(item)) return;
        const si = item.querySelector('input[value="ok"]');
        if (si) si.checked = true;
        item.classList.remove("is-invalid");
        actualizarItem(item);
      });
      actualizarResultado();
    });
  });

  // Vehículo: kilometraje de referencia y ficha (modelo, documentos, mantención).
  const vehiculo = document.getElementById("vehicle_id");
  const kmAyuda = document.getElementById("kmAyuda");
  const ficha = document.getElementById("vehiculoFicha");
  if (vehiculo) {
    vehiculo.addEventListener("change", () => {
      const opcion = vehiculo.selectedOptions[0];
      if (kmAyuda) {
        kmAyuda.textContent = opcion && opcion.dataset.km
          ? `Último registrado: ${opcion.dataset.kmTexto}`
          : "El que marca el tablero, sin decimales.";
      }
      if (!ficha) return;
      let datos = [];
      try { datos = JSON.parse((opcion && opcion.dataset.ficha) || "[]"); } catch (_) { datos = []; }
      ficha.innerHTML = "";
      for (const d of datos) {
        const caja = document.createElement("div");
        caja.className = `checklist-ficha__dato${d.estado ? ` is-${d.estado}` : ""}`;
        const dt = document.createElement("dt");
        dt.textContent = d.etiqueta;
        const dd = document.createElement("dd");
        dd.textContent = d.valor;
        caja.append(dt, dd);
        ficha.appendChild(caja);
      }
      ficha.hidden = datos.length === 0;
    });
  }

  // Conductor que no está en la lista.
  const conductor = document.getElementById("driver_user_id");
  const otro = document.getElementById("conductorOtro");
  if (conductor && otro) {
    conductor.addEventListener("change", () => {
      otro.hidden = conductor.value !== "otro";
      const input = otro.querySelector("input");
      input.required = !otro.hidden;
      if (!otro.hidden) input.focus();
    });
  }

  // Un solo envío. El botón pulsado (Guardar / Guardar e imprimir) se copia a
  // un campo oculto antes de deshabilitar los botones, que ya no se enviarían.
  form.addEventListener("submit", (event) => {
    const boton = event.submitter;
    if (boton && boton.name) {
      const oculto = document.createElement("input");
      oculto.type = "hidden";
      oculto.name = boton.name;
      oculto.value = boton.value;
      form.appendChild(oculto);
    }
    form.querySelectorAll('button[type="submit"]').forEach((b) => { b.disabled = true; });
  });

  items.forEach(actualizarItem);
  actualizarResultado();
})();
