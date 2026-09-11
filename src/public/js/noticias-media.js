/* ==========================================================================
   Noticias — medios embebidos
   Visor de imágenes a pantalla completa, visor de PDF (PDF.js) y despliegue
   de documentos Word. Objetivo del módulo: nadie descarga nada para leer.
   ========================================================================== */
(function () {
  "use strict";

  var PDFJS_VERSION = "4.10.38";
  var PDFJS_BASE = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/" + PDFJS_VERSION;
  var pdfjsPromise = null;

  function prefersReducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  /* ======================================================================
     1. Visor de imágenes a pantalla completa
     ====================================================================== */

  var Lightbox = (function () {
    var overlay = null;
    var imgEl = null;
    var pieEl = null;
    var contadorEl = null;
    var prevEl = null;
    var nextEl = null;
    var grupo = [];
    var indice = 0;
    var ultimoFoco = null;

    function construir() {
      if (overlay) return;

      overlay = document.createElement("div");
      overlay.className = "lightbox";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "Visor de imágenes");
      overlay.innerHTML =
        '<button type="button" class="lightbox__btn lightbox__btn--cerrar" aria-label="Cerrar visor">&times;</button>' +
        '<button type="button" class="lightbox__btn lightbox__btn--prev" aria-label="Imagen anterior">&#8249;</button>' +
        '<button type="button" class="lightbox__btn lightbox__btn--next" aria-label="Imagen siguiente">&#8250;</button>' +
        '<figure class="lightbox__figura">' +
        '<img class="lightbox__img" src="" alt="">' +
        '<figcaption class="lightbox__pie"></figcaption>' +
        "</figure>" +
        '<p class="lightbox__contador" aria-live="polite"></p>';

      document.body.appendChild(overlay);

      imgEl = overlay.querySelector(".lightbox__img");
      pieEl = overlay.querySelector(".lightbox__pie");
      contadorEl = overlay.querySelector(".lightbox__contador");
      prevEl = overlay.querySelector(".lightbox__btn--prev");
      nextEl = overlay.querySelector(".lightbox__btn--next");

      overlay.querySelector(".lightbox__btn--cerrar").addEventListener("click", cerrar);
      prevEl.addEventListener("click", function () { mover(-1); });
      nextEl.addEventListener("click", function () { mover(1); });

      // Solo cierra al pulsar el fondo, no la imagen, y sólo si el gesto
      // entero ocurrió sobre el fondo: al soltar fuera un arrastre iniciado
      // dentro (seleccionar el pie de foto) el `click` se reporta aquí.
      overlay.addEventListener("click", function (event) {
        if (event.target !== overlay) return;
        var modal = window.IntranetModal;
        if (modal && !modal.gestoCompletoSobre(overlay)) return;
        cerrar();
      });
    }

    function pintar() {
      var item = grupo[indice];
      if (!item) return;

      imgEl.src = item.src;
      imgEl.alt = item.alt || "";
      pieEl.textContent = item.caption || "";
      pieEl.style.display = item.caption ? "" : "none";

      var hayVarias = grupo.length > 1;
      contadorEl.textContent = hayVarias ? indice + 1 + " / " + grupo.length : "";
      prevEl.style.display = hayVarias ? "" : "none";
      nextEl.style.display = hayVarias ? "" : "none";
    }

    function mover(delta) {
      if (grupo.length < 2) return;
      indice = (indice + delta + grupo.length) % grupo.length;
      pintar();
    }

    function alTeclado(event) {
      if (event.key === "Escape") { cerrar(); return; }
      if (event.key === "ArrowLeft") { mover(-1); return; }
      if (event.key === "ArrowRight") { mover(1); return; }

      // Atrapa el foco dentro del visor mientras está abierto.
      if (event.key === "Tab") {
        var focusables = overlay.querySelectorAll("button:not([style*='display: none'])");
        if (!focusables.length) return;
        var primero = focusables[0];
        var ultimo = focusables[focusables.length - 1];
        if (event.shiftKey && document.activeElement === primero) {
          event.preventDefault();
          ultimo.focus();
        } else if (!event.shiftKey && document.activeElement === ultimo) {
          event.preventDefault();
          primero.focus();
        }
      }
    }

    function abrir(items, inicial) {
      construir();
      grupo = items;
      indice = inicial || 0;
      ultimoFoco = document.activeElement;

      pintar();
      overlay.classList.add("is-open");
      document.body.style.overflow = "hidden";
      document.addEventListener("keydown", alTeclado);
      overlay.querySelector(".lightbox__btn--cerrar").focus();
    }

    function cerrar() {
      if (!overlay) return;
      overlay.classList.remove("is-open");
      document.body.style.overflow = "";
      document.removeEventListener("keydown", alTeclado);
      imgEl.src = "";
      if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus();
    }

    return { abrir: abrir, cerrar: cerrar };
  })();

  function iniciarGalerias(raiz) {
    var galerias = raiz.querySelectorAll("[data-galeria]");

    Array.prototype.forEach.call(galerias, function (galeria) {
      var botones = galeria.querySelectorAll(".galeria__item");

      var items = Array.prototype.map.call(botones, function (boton) {
        return {
          src: boton.getAttribute("data-full") || "",
          alt: boton.getAttribute("data-alt") || "",
          caption: boton.getAttribute("data-caption") || "",
        };
      });

      Array.prototype.forEach.call(botones, function (boton, posicion) {
        boton.addEventListener("click", function () {
          Lightbox.abrir(items, posicion);
        });
      });
    });
  }

  /* ======================================================================
     2. Visor de PDF
     ====================================================================== */

  function cargarPdfjs() {
    if (!pdfjsPromise) {
      pdfjsPromise = import(PDFJS_BASE + "/pdf.min.mjs").then(function (pdfjs) {
        pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_BASE + "/pdf.worker.min.mjs";
        return pdfjs;
      });
    }
    return pdfjsPromise;
  }

  function mostrarRespaldo(visor, url, portadaHtml) {
    // Si PDF.js no está disponible (sin red, CDN bloqueado) se conserva la
    // portada que ya renderizó el servidor y se ofrece abrir el documento.
    visor.innerHTML =
      (portadaHtml || "") +
      '<div class="pdf-visor__aviso">' +
      "<p>No se pudo cargar el visor integrado.</p>" +
      '<p><a class="doc__accion" href="' +
      url +
      '" target="_blank" rel="noopener noreferrer">Abrir el documento en una pestaña nueva</a></p>' +
      "</div>";
  }

  function anchoDisponible(visor) {
    var estilo = window.getComputedStyle(visor);
    var ancho =
      visor.clientWidth - parseFloat(estilo.paddingLeft) - parseFloat(estilo.paddingRight);
    return Math.max(280, Math.min(ancho, 860));
  }

  async function renderizarPagina(doc, numero, contenedor, escala) {
    if (contenedor.dataset.renderizada === "1") return;
    contenedor.dataset.renderizada = "1";

    try {
      var pagina = await doc.getPage(numero);
      var viewport = pagina.getViewport({ scale: escala });

      // Se dibuja al doble de densidad para que no se vea borroso en retina.
      var densidad = Math.min(window.devicePixelRatio || 1, 2);
      var canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width * densidad);
      canvas.height = Math.floor(viewport.height * densidad);
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", "Página " + numero);

      var contexto = canvas.getContext("2d");
      contexto.scale(densidad, densidad);

      await pagina.render({ canvasContext: contexto, viewport: viewport }).promise;

      contenedor.innerHTML = "";
      contenedor.appendChild(canvas);
      contenedor.style.aspectRatio = viewport.width + " / " + viewport.height;
      pagina.cleanup();
    } catch (error) {
      contenedor.dataset.renderizada = "";
      console.warn("[Noticias] No se pudo renderizar la página", numero, error);
    }
  }

  async function iniciarVisorPdf(visor) {
    if (visor.dataset.iniciado === "1") return;
    visor.dataset.iniciado = "1";

    var url = visor.getAttribute("data-pdf-url");
    if (!url) return;

    // La portada la renderizó el servidor: se conserva por si el visor falla.
    var portadaHtml = visor.innerHTML;

    var pdfjs;
    var doc;
    try {
      pdfjs = await cargarPdfjs();
      doc = await pdfjs.getDocument({ url: url, withCredentials: true }).promise;
    } catch (error) {
      console.warn("[Noticias] PDF.js no disponible:", error);
      mostrarRespaldo(visor, url, portadaHtml);
      return;
    }

    try {
      var ancho = anchoDisponible(visor);
      var primera = await doc.getPage(1);
      var base = primera.getViewport({ scale: 1 });
      var escala = ancho / base.width;
      var proporcion = base.width + " / " + base.height;
      primera.cleanup();

      visor.innerHTML = "";

      var contenedores = [];
      for (var numero = 1; numero <= doc.numPages; numero += 1) {
        var pagina = document.createElement("div");
        pagina.className = "pdf-pagina";
        // Se reserva el alto estimado para que el scroll no dé saltos.
        pagina.style.aspectRatio = proporcion;
        pagina.innerHTML =
          '<div class="pdf-pagina__hueco" style="height:100%">Página ' + numero + "</div>";
        visor.appendChild(pagina);
        contenedores.push(pagina);
      }

      // La primera página se dibuja de inmediato: debe verse sin interactuar.
      await renderizarPagina(doc, 1, contenedores[0], escala);

      if (doc.numPages > 1) {
        var observador = new IntersectionObserver(
          function (entradas) {
            entradas.forEach(function (entrada) {
              if (!entrada.isIntersecting) return;
              var indice = contenedores.indexOf(entrada.target);
              if (indice === -1) return;
              observador.unobserve(entrada.target);
              renderizarPagina(doc, indice + 1, entrada.target, escala);
            });
          },
          { root: visor, rootMargin: "600px 0px" },
        );

        contenedores.slice(1).forEach(function (contenedor) {
          observador.observe(contenedor);
        });
      }
    } catch (error) {
      console.warn("[Noticias] Error preparando el visor de PDF:", error);
      mostrarRespaldo(visor, url, portadaHtml);
    }
  }

  function iniciarPdfs(raiz) {
    var visores = raiz.querySelectorAll("[data-pdf-url]");
    if (!visores.length) return;

    if (!("IntersectionObserver" in window)) {
      Array.prototype.forEach.call(visores, iniciarVisorPdf);
      return;
    }

    // No se descarga el PDF hasta que el usuario se acerca al bloque.
    var observador = new IntersectionObserver(
      function (entradas) {
        entradas.forEach(function (entrada) {
          if (!entrada.isIntersecting) return;
          observador.unobserve(entrada.target);
          iniciarVisorPdf(entrada.target);
        });
      },
      { rootMargin: "300px 0px" },
    );

    Array.prototype.forEach.call(visores, function (visor) {
      observador.observe(visor);
    });
  }

  /* ======================================================================
     3. Documentos Word: colapsar solo si realmente se desbordan
     ====================================================================== */

  function iniciarWord(raiz) {
    var documentos = raiz.querySelectorAll("[data-word]");

    Array.prototype.forEach.call(documentos, function (bloque) {
      var cuerpo = bloque.querySelector(".doc-word");
      var boton = bloque.querySelector(".doc__desplegar");
      if (!cuerpo || !boton) return;

      var limite = 520;
      if (cuerpo.scrollHeight <= limite + 60) {
        // Cabe entero: no tiene sentido el degradado ni el botón.
        cuerpo.classList.remove("doc-word--colapsado");
        boton.remove();
        return;
      }

      boton.addEventListener("click", function () {
        var colapsado = cuerpo.classList.toggle("doc-word--colapsado");
        boton.textContent = colapsado ? "Leer documento completo" : "Mostrar menos";
        boton.setAttribute("aria-expanded", colapsado ? "false" : "true");

        if (colapsado) {
          bloque.scrollIntoView({
            behavior: prefersReducedMotion() ? "auto" : "smooth",
            block: "start",
          });
        }
      });
    });
  }

  /* ====================================================================== */

  function iniciar(raiz) {
    var contexto = raiz || document;
    iniciarGalerias(contexto);
    iniciarPdfs(contexto);
    iniciarWord(contexto);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () { iniciar(document); });
  } else {
    iniciar(document);
  }

  window.NoticiasMedia = { iniciar: iniciar, abrirVisor: Lightbox.abrir };
})();
