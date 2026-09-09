/* Buscador global de Procesos y Documentos.
   La etiqueta de cada resultado la arma el servidor (routes/procesos.js):
   aquí ya no se parte el `type` por el guion bajo para adivinar el área. */
(function () {
  "use strict";

  var input = document.getElementById("buscadorGlobal");
  var resultados = document.getElementById("buscadorResultados");
  var spinner = document.getElementById("buscadorSpinner");
  if (!input || !resultados || !spinner) return;

  var DEBOUNCE_MS = 300;
  var MIN_CHARS = 2;
  var timer = null;
  // Descarta respuestas de peticiones que quedaron atrás: sin esto, una
  // búsqueda lenta puede pisar el resultado de una tecleada posterior.
  var peticion = 0;

  var ICONO =
    '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" ' +
    'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>' +
    '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>' +
    '<line x1="16" y1="17" x2="8" y2="17"/></svg>';

  function ocultar() {
    resultados.hidden = true;
  }

  function mostrar() {
    resultados.hidden = false;
  }

  function vaciar() {
    while (resultados.firstChild) resultados.removeChild(resultados.firstChild);
  }

  function pintarVacio() {
    vaciar();
    var aviso = document.createElement("div");
    aviso.className = "buscador-global__vacio";
    aviso.textContent = "No se encontraron documentos.";
    resultados.appendChild(aviso);
  }

  function pintar(items) {
    vaciar();
    items.forEach(function (doc) {
      var item = document.createElement("a");
      item.href = doc.url;
      item.target = "_blank";
      item.rel = "noopener";
      item.className = "buscador-global__item";

      var icono = document.createElement("div");
      icono.className = "buscador-global__item-icono";
      icono.innerHTML = ICONO;

      var cuerpo = document.createElement("div");

      var titulo = document.createElement("div");
      titulo.className = "buscador-global__item-titulo";
      // textContent y no innerHTML: el nombre del documento lo escribe un
      // usuario y puede traer cualquier cosa.
      titulo.textContent = doc.name || "Documento";

      var tipo = document.createElement("div");
      tipo.className = "buscador-global__item-tipo";
      tipo.textContent = doc.etiqueta || "Documento";

      cuerpo.appendChild(titulo);
      cuerpo.appendChild(tipo);
      item.appendChild(icono);
      item.appendChild(cuerpo);
      resultados.appendChild(item);
    });
  }

  input.addEventListener("input", function (e) {
    clearTimeout(timer);
    var query = e.target.value.trim();

    if (query.length < MIN_CHARS) {
      ocultar();
      spinner.style.display = "none";
      return;
    }

    spinner.style.display = "block";

    timer = setTimeout(function () {
      var propia = ++peticion;
      fetch("/procesos/api/buscar?q=" + encodeURIComponent(query), {
        credentials: "same-origin",
      })
        .then(function (res) {
          return res.ok ? res.json() : [];
        })
        .then(function (data) {
          if (propia !== peticion) return;
          if (!Array.isArray(data) || !data.length) pintarVacio();
          else pintar(data);
          mostrar();
        })
        .catch(function (err) {
          if (propia !== peticion) return;
          console.error("Error buscando:", err);
        })
        .finally(function () {
          if (propia === peticion) spinner.style.display = "none";
        });
    }, DEBOUNCE_MS);
  });

  document.addEventListener("click", function (e) {
    if (!input.contains(e.target) && !resultados.contains(e.target)) ocultar();
  });

  input.addEventListener("focus", function () {
    if (input.value.trim().length >= MIN_CHARS && resultados.childNodes.length) {
      mostrar();
    }
  });

  input.addEventListener("keydown", function (e) {
    if (e.key === "Escape") ocultar();
  });
})();
