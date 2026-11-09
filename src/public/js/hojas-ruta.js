/**
 * Hojas de ruta: el nombre a mano del conductor o la peoneta ("Otra
 * persona"), el último km del vehículo elegido y los botones «Ahora» de las
 * horas de cada parada. Sin JS todo funciona igual: el servidor valida.
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

  // «Ahora» llena la hora con la del teléfono o el computador.
  document.addEventListener("click", function (event) {
    const boton = event.target.closest("[data-ahora]");
    if (!boton) return;
    const input = document.getElementById(boton.dataset.ahora);
    if (!input) return;
    const ahora = new Date();
    const dos = function (n) { return String(n).padStart(2, "0"); };
    input.value = dos(ahora.getHours()) + ":" + dos(ahora.getMinutes());
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
})();
