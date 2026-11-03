/**
 * Formulario del checklist de vehículos: resultado en vivo, detalle de las
 * fallas, "marcar todo bien" por categoría, avisos del vehículo elegido y el
 * conductor escrito a mano. Sin JS el formulario funciona igual: el servidor
 * valida y calcula el resultado.
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

  function actualizarNota(item) {
    const nota = item.querySelector("[data-nota]");
    if (!nota) return;
    const input = nota.querySelector("input");
    const falla = respuesta(item) === "falla";
    nota.hidden = !falla && !input.value.trim();
    input.required = falla;
  }

  function actualizarResultado() {
    if (!resultado) return;
    let faltan = 0;
    let fallas = 0;
    let criticas = 0;
    for (const item of items) {
      const r = respuesta(item);
      if (!r) faltan += 1;
      if (r === "falla") {
        fallas += 1;
        if (item.dataset.critico === "1") criticas += 1;
      }
    }
    const clave = criticas ? "no_apto" : fallas ? "observado" : "apto";
    const info = RESULTADOS[clave];
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
    if (item && event.target.type === "radio") {
      item.classList.remove("is-invalid");
      actualizarNota(item);
      if (respuesta(item) === "falla") {
        const input = item.querySelector("[data-nota] input");
        if (input) input.focus();
      }
      actualizarResultado();
    }
  });

  form.querySelectorAll("[data-todo-ok]").forEach((boton) => {
    boton.addEventListener("click", () => {
      const grupo = boton.closest("[data-grupo]");
      grupo.querySelectorAll("[data-item]").forEach((item) => {
        if (respuesta(item)) return;
        const ok = item.querySelector('input[value="ok"]');
        if (ok) ok.checked = true;
        item.classList.remove("is-invalid");
        actualizarNota(item);
      });
      actualizarResultado();
    });
  });

  // Vehículo: kilometraje de referencia y documentos vencidos.
  const vehiculo = document.getElementById("vehicle_id");
  const kmAyuda = document.getElementById("kmAyuda");
  const avisos = document.getElementById("vehiculoAvisos");
  if (vehiculo) {
    vehiculo.addEventListener("change", () => {
      const opcion = vehiculo.selectedOptions[0];
      if (kmAyuda) {
        kmAyuda.textContent = opcion && opcion.dataset.km
          ? `Último registrado: ${opcion.dataset.kmTexto}`
          : "En kilómetros, sin decimales.";
      }
      if (avisos) {
        avisos.innerHTML = "";
        let alertas = [];
        try { alertas = JSON.parse((opcion && opcion.dataset.alertas) || "[]"); } catch (_) { alertas = []; }
        for (const a of alertas) {
          const chip = document.createElement("span");
          chip.className = `logistica-alerta logistica-alerta--${a.estado}`;
          chip.textContent = a.texto;
          avisos.appendChild(chip);
        }
      }
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

  // Doble clic en "Registrar": un solo envío.
  form.addEventListener("submit", () => {
    const boton = form.querySelector('button[type="submit"]');
    if (boton) boton.disabled = true;
  });

  items.forEach(actualizarNota);
  actualizarResultado();
})();
