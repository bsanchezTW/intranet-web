/**
 * Hojas de ruta: el nombre a mano del conductor o la peoneta ("Otra
 * persona"), el último km del vehículo elegido, la comuna de un cliente
 * conocido y los botones «Ahora» y borrar de las horas de cada parada. Sin
 * JS todo funciona igual: el servidor valida.
 */
(function () {
  // Conductor y peoneta: "Otra persona" abre el campo del nombre.
  document.querySelectorAll("[data-persona]").forEach(function (select) {
    const otra = document.querySelector('[data-persona-otra="' + select.dataset.persona + '"]');
    if (!otra) return;
    function actualizar() {
      const visible = select.value === "otro";
      otra.hidden = !visible;
      if (visible && document.activeElement === select) {
        const input = otra.querySelector("input");
        if (input) input.focus();
      }
    }
    select.addEventListener("change", actualizar);
    actualizar();
  });

  // Patente: la ayuda del km inicial muestra el último registrado.
  const vehiculo = document.querySelector("[data-vehiculo]");
  const ayuda = document.querySelector("[data-km-ayuda]");
  if (vehiculo && ayuda) {
    const textoBase = "El que marca el tablero al salir, sin decimales.";
    vehiculo.addEventListener("change", function () {
      const opcion = vehiculo.selectedOptions[0];
      const km = opcion ? opcion.dataset.kmTexto : "";
      ayuda.textContent = km ? "Último registrado: " + km : textoBase;
    });
  }

  // Cliente conocido (de la lista de sugerencias): si la comuna está vacía,
  // se completa con la de su última visita.
  const clientes = document.getElementById("hrClientes");
  if (clientes) {
    const comunaDe = new Map();
    clientes.querySelectorAll("option").forEach(function (o) {
      comunaDe.set(o.value.trim().toLowerCase(), o.dataset.localidad || "");
    });
    document.addEventListener("change", function (event) {
      const input = event.target.closest("[data-cliente]");
      if (!input || !input.form) return;
      const localidad = input.form.querySelector("[data-localidad]");
      const sugerida = comunaDe.get(input.value.trim().toLowerCase());
      if (localidad && sugerida && !localidad.value.trim()) localidad.value = sugerida;
    });
  }

  // Horas de cada parada: dos listas (hora 00–23 y minutos) por campo.
  // «Ahora» las llena con la hora del teléfono o el computador; la ✕ las
  // deja vacías.
  function listasDe(id) {
    return [document.getElementById(id + "_h"), document.getElementById(id + "_m")];
  }
  document.addEventListener("click", function (event) {
    const ahora = event.target.closest("[data-ahora]");
    const borrar = event.target.closest("[data-borrar-hora]");
    if (!ahora && !borrar) return;
    const [hora, minutos] = listasDe((ahora || borrar).dataset[ahora ? "ahora" : "borrarHora"]);
    if (!hora || !minutos) return;
    if (ahora) {
      const d = new Date();
      const dos = function (n) { return String(n).padStart(2, "0"); };
      hora.value = dos(d.getHours());
      minutos.value = dos(d.getMinutes());
    } else {
      hora.value = "";
      minutos.value = "";
    }
    hora.dispatchEvent(new Event("change", { bubbles: true }));
  });

  // Elegir sólo la hora deja los minutos en 00: es lo más común y evita el
  // error «Elige los minutos».
  document.addEventListener("change", function (event) {
    const hora = event.target.closest("select[id$='_h']");
    if (!hora || !hora.closest("[data-hora]")) return;
    const minutos = document.getElementById(hora.id.replace(/_h$/, "_m"));
    if (minutos && hora.value && !minutos.value) minutos.value = "00";
  });
})();
