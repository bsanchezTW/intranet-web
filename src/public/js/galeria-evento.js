/* ==========================================================================
   Galería — detalle de un evento
   1. Slider de portada con fotos aleatorias
   2. Mosaico con carga diferida y entrada animada
   3. Visor a pantalla completa (fotos y videos) con acciones
   4. Subida de archivos: arrastrar o elegir
   Depende de /js/galeria.js (window.Galeria).
   ========================================================================== */
(function (global) {
  "use strict";

  var nodoDatos = document.getElementById("galeriaDatos");
  if (!nodoDatos) return;

  var datos;
  try { datos = JSON.parse(nodoDatos.textContent); } catch (e) { return; }

  var G = global.Galeria;
  var items = datos.items || [];
  var reducirMovimiento =
    global.matchMedia && global.matchMedia("(prefers-reduced-motion: reduce)").matches;

  function barajar(lista) {
    var copia = lista.slice();
    for (var i = copia.length - 1; i > 0; i -= 1) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = copia[i]; copia[i] = copia[j]; copia[j] = t;
    }
    return copia;
  }

  function plural(n, uno, varios) {
    return n + " " + (n === 1 ? uno : varios);
  }

  /* ======================================================================
     1. Slider
     ====================================================================== */

  var Hero = (function () {
    var MAX_SLIDES = 12;
    var INTERVALO = 5500;

    var raiz = document.getElementById("galeriaHero");
    var viewport = document.getElementById("galeriaHeroViewport");
    var controles = document.getElementById("galeriaHeroControles");
    var dotsNodo = document.getElementById("galeriaHeroDots");
    var slides = [];
    var actual = 0;
    var timer = null;
    var pausado = false;

    function construir() {
      if (!raiz || !viewport) return;

      var fotos = items.filter(function (i) { return i.tipo === "image"; }).map(function (i) { return i.url; });
      if (!fotos.length) return;

      // La primera diapositiva ya la pintó el servidor (portada o primera
      // foto): se conserva para que no haya parpadeo y se barajan las demás.
      var inicial = viewport.querySelector(".galeria-hero__slide img");
      var primera = inicial ? inicial.getAttribute("src") : null;
      var resto = barajar(fotos.filter(function (u) { return u !== primera; }));
      var urls = (primera ? [primera] : []).concat(resto).slice(0, MAX_SLIDES);

      viewport.innerHTML = "";
      slides = urls.map(function (url, i) {
        var slide = document.createElement("div");
        slide.className = "galeria-hero__slide" + (i === 0 ? " is-active" : "");
        slide.setAttribute("data-url", url);
        var img = document.createElement("img");
        img.alt = "";
        img.decoding = "async";
        if (i === 0) img.src = url;
        else img.setAttribute("data-src", url);
        slide.appendChild(img);
        viewport.appendChild(slide);
        return slide;
      });

      pintarDots();
      if (slides.length > 1) {
        controles.hidden = false;
        precargar(1);
        programar();
      }

      raiz.addEventListener("mouseenter", function () { pausado = true; detener(); });
      raiz.addEventListener("mouseleave", function () { pausado = false; programar(); });
      raiz.addEventListener("focusin", function () { pausado = true; detener(); });
      raiz.addEventListener("focusout", function () { pausado = false; programar(); });
      document.addEventListener("visibilitychange", function () {
        if (document.hidden) detener(); else programar();
      });

      controles.addEventListener("click", function (evento) {
        var mover = evento.target.closest("[data-hero-mover]");
        if (mover) { ir(actual + Number(mover.getAttribute("data-hero-mover"))); return; }
        var dot = evento.target.closest("[data-hero-ir]");
        if (dot) ir(Number(dot.getAttribute("data-hero-ir")));
      });

      raiz.addEventListener("keydown", function (evento) {
        if (evento.key === "ArrowLeft") ir(actual - 1);
        if (evento.key === "ArrowRight") ir(actual + 1);
      });

      var inicioX = null;
      raiz.addEventListener("pointerdown", function (e) {
        if (e.pointerType !== "mouse") inicioX = e.clientX;
      });
      raiz.addEventListener("pointerup", function (e) {
        if (inicioX === null) return;
        var delta = e.clientX - inicioX;
        inicioX = null;
        if (Math.abs(delta) > 45) ir(actual + (delta < 0 ? 1 : -1));
      });
    }

    function pintarDots() {
      dotsNodo.innerHTML = "";
      if (slides.length < 2) {
        if (controles) controles.hidden = true;
        return;
      }
      slides.forEach(function (_, i) {
        var dot = document.createElement("button");
        dot.type = "button";
        dot.className = "galeria-hero__dot" + (i === actual ? " is-active" : "");
        dot.setAttribute("role", "tab");
        dot.setAttribute("aria-selected", i === actual ? "true" : "false");
        dot.setAttribute("aria-label", "Foto " + (i + 1) + " de " + slides.length);
        dot.setAttribute("data-hero-ir", String(i));
        dotsNodo.appendChild(dot);
      });
    }

    function precargar(indice) {
      var slide = slides[(indice + slides.length) % slides.length];
      if (!slide) return Promise.resolve();
      var img = slide.querySelector("img");
      var src = img.getAttribute("data-src");
      if (src) {
        img.src = src;
        img.removeAttribute("data-src");
      }
      if (img.complete) return Promise.resolve();
      return img.decode ? img.decode().catch(function () {}) : Promise.resolve();
    }

    function ir(indice) {
      if (slides.length < 2) return;
      var destino = (indice + slides.length) % slides.length;
      if (destino === actual) return;
      detener();
      precargar(destino).then(function () {
        slides[actual].classList.remove("is-active");
        actual = destino;
        slides[actual].classList.add("is-active");
        Array.prototype.forEach.call(dotsNodo.children, function (dot, i) {
          dot.classList.toggle("is-active", i === actual);
          dot.setAttribute("aria-selected", i === actual ? "true" : "false");
        });
        precargar(actual + 1);
        programar();
      });
    }

    function programar() {
      detener();
      if (pausado || reducirMovimiento || document.hidden || slides.length < 2) return;
      timer = setTimeout(function () { ir(actual + 1); }, INTERVALO);
    }

    function detener() {
      clearTimeout(timer);
      timer = null;
    }

    function quitar(url) {
      var i = -1;
      slides.forEach(function (s, idx) { if (s.getAttribute("data-url") === url) i = idx; });
      if (i === -1 || slides.length < 2) return;
      var eraActual = i === actual;
      slides[i].remove();
      slides.splice(i, 1);
      if (i < actual || actual >= slides.length) actual = Math.max(0, actual - 1);
      if (eraActual) {
        precargar(actual);
        slides[actual].classList.add("is-active");
      }
      pintarDots();
      programar();
    }

    return { construir: construir, quitar: quitar };
  })();

  /* ======================================================================
     2. Mosaico
     ====================================================================== */

  var mosaico = document.getElementById("galeriaMosaico");

  function tiles() {
    return mosaico ? Array.prototype.slice.call(mosaico.querySelectorAll(".galeria-tile")) : [];
  }

  function cargarTile(tile, retraso) {
    var media = tile.querySelector("img[data-src], video[data-src]");
    if (!media) return;
    tile.style.setProperty("--galeria-retraso", retraso + "ms");

    function listo() {
      tile.classList.remove("is-cargando");
      tile.classList.add("is-lista");
    }
    function fallo() {
      tile.classList.remove("is-cargando");
      tile.classList.add("is-error");
    }

    var src = media.getAttribute("data-src");
    media.removeAttribute("data-src");
    if (media.tagName === "VIDEO") {
      media.addEventListener("loadeddata", listo, { once: true });
      media.addEventListener("error", fallo, { once: true });
      media.preload = "metadata";
      media.src = src;
    } else {
      media.addEventListener("load", listo, { once: true });
      media.addEventListener("error", fallo, { once: true });
      media.src = src;
      if (media.complete && media.naturalWidth) listo();
    }
  }

  function iniciarMosaico() {
    if (!mosaico) return;

    if (!("IntersectionObserver" in global)) {
      tiles().forEach(function (t, i) { cargarTile(t, Math.min(i, 12) * 35); });
    } else {
      var observador = new IntersectionObserver(
        function (entradas) {
          var visibles = entradas.filter(function (e) { return e.isIntersecting; });
          visibles.forEach(function (entrada, orden) {
            observador.unobserve(entrada.target);
            // Escalonado dentro de cada tanda que entra en pantalla.
            cargarTile(entrada.target, Math.min(orden, 12) * 45);
          });
        },
        { rootMargin: "400px 0px" }
      );
      tiles().forEach(function (t) { observador.observe(t); });
    }

    mosaico.addEventListener("click", function (evento) {
      var tile = evento.target.closest(".galeria-tile");
      if (!tile) return;
      Visor.abrir(tiles().indexOf(tile));
    });
  }

  function actualizarContadores() {
    var fotos = items.filter(function (i) { return i.tipo === "image"; }).length;
    var videos = items.length - fotos;

    var total = document.getElementById("galeriaTotal");
    if (total) total.textContent = plural(items.length, "archivo", "archivos");

    var chipFotos = document.querySelector('[data-contador="image"] span');
    if (chipFotos) chipFotos.textContent = plural(fotos, "foto", "fotos");
    var chipVideos = document.querySelector('[data-contador="video"]');
    if (chipVideos) {
      chipVideos.hidden = videos === 0;
      chipVideos.querySelector("span").textContent = plural(videos, "video", "videos");
    }

    tiles().forEach(function (tile, i) {
      tile.setAttribute("data-index", String(i));
      var tipo = items[i] && items[i].tipo === "video" ? "Ver video" : "Ver foto";
      tile.setAttribute("aria-label", tipo + " " + (i + 1) + " de " + items.length);
    });

    var vacio = document.getElementById("galeriaVacio");
    if (vacio) vacio.hidden = items.length > 0;
    if (mosaico) mosaico.hidden = items.length === 0;
  }

  function marcarPortada(url) {
    datos.portada = url;
    tiles().forEach(function (tile, i) {
      var badge = tile.querySelector(".galeria-tile__portada");
      if (badge) badge.hidden = !(items[i] && items[i].url === url);
    });
  }

  /* ======================================================================
     3. Visor
     ====================================================================== */

  var Visor = (function () {
    var overlay, escenario, contador, descargar, btnPortada, btnEliminar, prev, next;
    var indice = 0;
    var ultimoFoco = null;
    var abierto = false;
    var ocupado = false;

    var ICONOS = {
      cerrar: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
      prev: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="15 18 9 12 15 6"/></svg>',
      next: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 18 15 12 9 6"/></svg>',
      descargar: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
      portada: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>',
      eliminar: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
    };

    function construir() {
      if (overlay) return;
      overlay = document.createElement("div");
      overlay.className = "galeria-visor";
      overlay.setAttribute("role", "dialog");
      overlay.setAttribute("aria-modal", "true");
      overlay.setAttribute("aria-label", "Visor de fotos y videos");
      overlay.innerHTML =
        '<div class="galeria-visor__barra">' +
          '<p class="galeria-visor__contador" aria-live="polite"></p>' +
          '<div class="galeria-visor__acciones">' +
            '<a class="galeria-visor__accion" data-accion="descargar" download>' + ICONOS.descargar + '<span>Descargar</span></a>' +
            (datos.puedeEditar
              ? '<button type="button" class="galeria-visor__accion" data-accion="portada">' + ICONOS.portada + '<span>Usar como portada</span></button>' +
                '<button type="button" class="galeria-visor__accion galeria-visor__accion--peligro" data-accion="eliminar">' + ICONOS.eliminar + '<span>Eliminar</span></button>'
              : "") +
            '<button type="button" class="galeria-visor__accion galeria-visor__accion--cerrar" data-accion="cerrar" aria-label="Cerrar visor">' + ICONOS.cerrar + "</button>" +
          "</div>" +
        "</div>" +
        '<button type="button" class="galeria-visor__nav galeria-visor__nav--prev" aria-label="Anterior">' + ICONOS.prev + "</button>" +
        '<div class="galeria-visor__escenario"></div>' +
        '<button type="button" class="galeria-visor__nav galeria-visor__nav--next" aria-label="Siguiente">' + ICONOS.next + "</button>";
      document.body.appendChild(overlay);

      escenario = overlay.querySelector(".galeria-visor__escenario");
      contador = overlay.querySelector(".galeria-visor__contador");
      descargar = overlay.querySelector('[data-accion="descargar"]');
      btnPortada = overlay.querySelector('[data-accion="portada"]');
      btnEliminar = overlay.querySelector('[data-accion="eliminar"]');
      prev = overlay.querySelector(".galeria-visor__nav--prev");
      next = overlay.querySelector(".galeria-visor__nav--next");

      prev.addEventListener("click", function () { mover(-1); });
      next.addEventListener("click", function () { mover(1); });
      overlay.querySelector('[data-accion="cerrar"]').addEventListener("click", cerrar);
      if (btnPortada) btnPortada.addEventListener("click", usarComoPortada);
      if (btnEliminar) btnEliminar.addEventListener("click", eliminarActual);

      overlay.addEventListener("click", function (evento) {
        if (evento.target !== overlay && evento.target !== escenario) return;
        var modal = global.IntranetModal;
        if (modal && modal.gestoCompletoSobre && !modal.gestoCompletoSobre(evento.target)) return;
        cerrar();
      });

      var inicioX = null;
      escenario.addEventListener("pointerdown", function (e) {
        if (e.pointerType !== "mouse") inicioX = e.clientX;
      });
      escenario.addEventListener("pointerup", function (e) {
        if (inicioX === null) return;
        var delta = e.clientX - inicioX;
        inicioX = null;
        if (Math.abs(delta) > 50) mover(delta < 0 ? 1 : -1);
      });
    }

    function nombreArchivo(url) {
      var partes = decodeURIComponent(url.split("?")[0]).split("/");
      return partes[partes.length - 1] || "archivo";
    }

    function pintar() {
      var item = items[indice];
      if (!item) return;

      escenario.innerHTML = "";
      var media;
      if (item.tipo === "video") {
        media = document.createElement("video");
        media.controls = true;
        media.autoplay = true;
        media.playsInline = true;
        media.src = item.url;
      } else {
        media = document.createElement("img");
        media.alt = "";
        media.src = item.url;
      }
      media.className = "galeria-visor__media";
      escenario.appendChild(media);

      contador.textContent = indice + 1 + " / " + items.length;
      descargar.href = item.url;
      descargar.setAttribute("download", nombreArchivo(item.url));

      var varias = items.length > 1;
      prev.hidden = !varias;
      next.hidden = !varias;

      if (btnPortada) {
        var esPortada = item.url === datos.portada;
        btnPortada.hidden = item.tipo !== "image";
        btnPortada.disabled = esPortada;
        btnPortada.querySelector("span").textContent = esPortada ? "Es la portada" : "Usar como portada";
      }
    }

    function mover(delta) {
      if (items.length < 2 || ocupado) return;
      indice = (indice + delta + items.length) % items.length;
      pintar();
    }

    function alTeclado(evento) {
      // Un diálogo de confirmación abierto encima atiende sus propias teclas.
      if (evento.defaultPrevented || (global.IntranetModal && global.IntranetModal.top && global.IntranetModal.top())) return;
      if (evento.key === "Escape") { cerrar(); return; }
      if (evento.key === "ArrowLeft") { mover(-1); return; }
      if (evento.key === "ArrowRight") { mover(1); return; }
      if (evento.key === "Tab") {
        var focusables = Array.prototype.filter.call(
          overlay.querySelectorAll("button, a[href], video"),
          function (el) { return !el.hidden && !el.disabled && el.offsetParent !== null; }
        );
        if (!focusables.length) return;
        var primero = focusables[0];
        var ultimo = focusables[focusables.length - 1];
        if (evento.shiftKey && document.activeElement === primero) {
          evento.preventDefault();
          ultimo.focus();
        } else if (!evento.shiftKey && document.activeElement === ultimo) {
          evento.preventDefault();
          primero.focus();
        }
      }
    }

    function abrir(i) {
      if (!items.length) return;
      construir();
      indice = Math.max(0, Math.min(i, items.length - 1));
      ultimoFoco = document.activeElement;
      pintar();
      overlay.classList.add("is-open");
      document.body.classList.add("galeria-visor-abierto");
      if (!abierto && global.IntranetModal && global.IntranetModal.lockScroll) global.IntranetModal.lockScroll();
      abierto = true;
      document.addEventListener("keydown", alTeclado);
      overlay.querySelector('[data-accion="cerrar"]').focus({ preventScroll: true });
    }

    function cerrar() {
      if (!overlay || !abierto) return;
      abierto = false;
      overlay.classList.remove("is-open");
      document.body.classList.remove("galeria-visor-abierto");
      document.removeEventListener("keydown", alTeclado);
      escenario.innerHTML = "";
      if (global.IntranetModal && global.IntranetModal.unlockScroll) global.IntranetModal.unlockScroll();
      if (ultimoFoco && ultimoFoco.focus) ultimoFoco.focus({ preventScroll: true });
    }

    async function usarComoPortada() {
      var item = items[indice];
      if (!item || ocupado) return;
      ocupado = true;
      btnPortada.disabled = true;
      try {
        await G.enviar(G.rutaEvento(datos.slug) + "/portada", { url_imagen: item.url });
        marcarPortada(item.url);
        G.aviso("Portada actualizada");
      } catch (error) {
        G.alertar("No se pudo cambiar la portada", error.message);
      } finally {
        ocupado = false;
        pintar();
      }
    }

    async function eliminarActual() {
      var item = items[indice];
      if (!item || ocupado || !global.IntranetDialog) return;
      var esVideo = item.tipo === "video";
      var confirmado = await global.IntranetDialog.confirm({
        title: esVideo ? "¿Eliminar el video?" : "¿Eliminar la foto?",
        message: "Se borrará de la galería del evento. Esta acción no se puede deshacer.",
        acceptLabel: "Eliminar",
        tone: "peligro",
      });
      if (!confirmado) return;

      ocupado = true;
      btnEliminar.disabled = true;
      try {
        await G.enviar(G.rutaEvento(datos.slug) + "/fotos/eliminar", {
          public_id: item.public_id,
          resource_type: item.tipo,
        });
      } catch (error) {
        ocupado = false;
        btnEliminar.disabled = false;
        G.alertar("No se pudo eliminar", error.message);
        return;
      }

      var tile = tiles()[indice];
      if (tile) tile.remove();
      items.splice(indice, 1);
      if (datos.portada === item.url) marcarPortada("");
      Hero.quitar(item.url);
      actualizarContadores();
      G.aviso(esVideo ? "Video eliminado" : "Foto eliminada");

      ocupado = false;
      btnEliminar.disabled = false;
      if (!items.length) { cerrar(); return; }
      indice = Math.min(indice, items.length - 1);
      pintar();
    }

    return { abrir: abrir };
  })();

  /* ======================================================================
     4. Subida
     ====================================================================== */

  function iniciarSubida() {
    var zona = document.getElementById("galeriaDropzone");
    var input = document.getElementById("galeriaArchivos");
    if (!zona || !input) return;

    var MAX_ARCHIVOS = 150;
    var CONCURRENCIA = 3;
    var MB = 1024 * 1024;
    var LIMITE_IMAGEN = 10 * MB;
    var LIMITE_VIDEO = 100 * MB;

    var cola = document.getElementById("galeriaCola");
    var lista = document.getElementById("galeriaColaLista");
    var estadoTxt = document.getElementById("galeriaColaEstado");
    var porcentajeTxt = document.getElementById("galeriaColaPorcentaje");
    var barra = document.getElementById("galeriaProgreso");
    var btnSubir = document.getElementById("galeriaColaSubir");
    var btnLimpiar = document.getElementById("galeriaColaLimpiar");

    var pendientes = [];
    var subiendo = false;

    function formatearPeso(bytes) {
      if (bytes >= MB) return (bytes / MB).toFixed(1).replace(".", ",") + " MB";
      return Math.max(1, Math.round(bytes / 1024)) + " KB";
    }

    function pintarResumen() {
      cola.hidden = pendientes.length === 0;
      if (subiendo) return;
      var validos = pendientes.filter(function (p) { return !p.error; }).length;
      estadoTxt.textContent =
        plural(validos, "archivo listo", "archivos listos") + " para subir" +
        (validos < pendientes.length ? " · " + (pendientes.length - validos) + " con problemas" : "");
      porcentajeTxt.textContent = "";
      barra.style.width = "0%";
      btnSubir.disabled = validos === 0;
      btnSubir.textContent = validos ? "Subir " + plural(validos, "archivo", "archivos") : "Subir archivos";
    }

    function crearFila(p) {
      var li = document.createElement("li");
      li.className = "galeria-cola__item" + (p.error ? " is-error" : "");

      var miniatura = document.createElement("span");
      miniatura.className = "galeria-cola__mini";
      if (p.esVideo) {
        miniatura.innerHTML = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2"/></svg>';
      } else if (!p.error) {
        p.preview = URL.createObjectURL(p.archivo);
        var img = document.createElement("img");
        img.alt = "";
        img.src = p.preview;
        miniatura.appendChild(img);
      }

      var info = document.createElement("span");
      info.className = "galeria-cola__info";
      var nombre = document.createElement("span");
      nombre.className = "galeria-cola__nombre";
      nombre.textContent = p.archivo.name;
      var detalle = document.createElement("span");
      detalle.className = "galeria-cola__detalle";
      detalle.textContent = p.error || formatearPeso(p.archivo.size);
      if (p.error) detalle.title = p.error;
      info.appendChild(nombre);
      info.appendChild(detalle);

      var progreso = document.createElement("span");
      progreso.className = "galeria-cola__barra";
      progreso.innerHTML = "<span></span>";

      var quitar = document.createElement("button");
      quitar.type = "button";
      quitar.className = "galeria-cola__quitar";
      quitar.setAttribute("aria-label", "Quitar " + p.archivo.name);
      quitar.innerHTML = "&times;";
      quitar.addEventListener("click", function () {
        if (subiendo) return;
        pendientes.splice(pendientes.indexOf(p), 1);
        if (p.preview) URL.revokeObjectURL(p.preview);
        li.remove();
        pintarResumen();
      });

      li.appendChild(miniatura);
      li.appendChild(info);
      li.appendChild(progreso);
      li.appendChild(quitar);
      p.fila = li;
      p.detalle = detalle;
      p.barra = progreso.firstChild;
      return li;
    }

    function agregar(archivos) {
      if (subiendo) return;
      var nuevos = Array.prototype.slice.call(archivos || []);
      if (!nuevos.length) return;

      var espacio = MAX_ARCHIVOS - pendientes.length;
      if (nuevos.length > espacio) {
        G.alertar(
          "Demasiados archivos",
          "Puedes subir hasta " + MAX_ARCHIVOS + " archivos a la vez. Se agregaron los primeros " + Math.max(espacio, 0) + "."
        );
        nuevos = nuevos.slice(0, Math.max(espacio, 0));
      }

      nuevos.forEach(function (archivo) {
        var tipo = archivo.type || "";
        var esVideo = tipo.indexOf("video/") === 0;
        var esImagen = tipo.indexOf("image/") === 0;
        var p = { archivo: archivo, esVideo: esVideo, error: "" };
        if (!esVideo && !esImagen) p.error = "Solo se admiten imágenes o videos";
        else if (archivo.size > (esVideo ? LIMITE_VIDEO : LIMITE_IMAGEN)) {
          p.error = "Supera el máximo de " + (esVideo ? "100" : "10") + " MB";
        }
        pendientes.push(p);
        lista.appendChild(crearFila(p));
      });

      pintarResumen();
      cola.scrollIntoView({ behavior: reducirMovimiento ? "auto" : "smooth", block: "nearest" });
    }

    /* ---- Zona de arrastre ---- */
    zona.addEventListener("click", function () { if (!subiendo) input.click(); });
    zona.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        if (!subiendo) input.click();
      }
    });
    input.addEventListener("change", function () {
      agregar(input.files);
      input.value = "";
    });

    zona.addEventListener("dragenter", function (e) {
      e.preventDefault();
      zona.classList.add("is-over");
    });
    zona.addEventListener("dragover", function (e) {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = subiendo ? "none" : "copy";
      zona.classList.add("is-over");
    });
    zona.addEventListener("dragleave", function (e) {
      // Pasar sobre un hijo también dispara dragleave: sólo cuenta si se sale de la zona.
      if (e.relatedTarget && zona.contains(e.relatedTarget)) return;
      zona.classList.remove("is-over");
    });
    zona.addEventListener("drop", function (e) {
      e.preventDefault();
      zona.classList.remove("is-over");
      if (e.dataTransfer) agregar(e.dataTransfer.files);
    });

    btnLimpiar.addEventListener("click", function () {
      if (subiendo) return;
      pendientes.forEach(function (p) { if (p.preview) URL.revokeObjectURL(p.preview); });
      pendientes = [];
      lista.innerHTML = "";
      pintarResumen();
    });

    /* ---- Envío ---- */
    function subirUno(p, alProgreso) {
      return new Promise(function (resolver, rechazar) {
        var xhr = new XMLHttpRequest();
        xhr.open("POST", G.rutaEvento(datos.slug) + "/fotos/upload");
        xhr.setRequestHeader("Accept", "application/json");
        xhr.setRequestHeader("X-Requested-With", "XMLHttpRequest");
        xhr.upload.addEventListener("progress", function (e) {
          if (e.lengthComputable) alProgreso(e.loaded / e.total);
        });
        xhr.addEventListener("load", function () {
          var json = null;
          try { json = JSON.parse(xhr.responseText); } catch (err) { json = null; }
          if (xhr.status >= 200 && xhr.status < 300 && json) resolver(json);
          else rechazar(new Error((json && json.error) || "Error al subir (" + xhr.status + ")"));
        });
        xhr.addEventListener("error", function () { rechazar(new Error("Sin conexión con el servidor")); });
        var fd = new FormData();
        fd.append("archivo", p.archivo, p.archivo.name);
        xhr.send(fd);
      });
    }

    function avisarSalida(e) {
      e.preventDefault();
      e.returnValue = "";
    }

    btnSubir.addEventListener("click", async function () {
      var aSubir = pendientes.filter(function (p) { return !p.error && !p.subido; });
      if (!aSubir.length || subiendo) return;

      subiendo = true;
      global.addEventListener("beforeunload", avisarSalida);
      zona.classList.add("is-bloqueada");
      btnSubir.disabled = true;
      btnLimpiar.disabled = true;
      cola.classList.add("is-subiendo");

      var totalBytes = aSubir.reduce(function (s, p) { return s + p.archivo.size; }, 0) || 1;
      var terminados = 0;
      var subidos = [];
      var fallidos = 0;

      function pintarTotal() {
        var cargado = aSubir.reduce(function (s, p) { return s + p.archivo.size * (p.avance || 0); }, 0);
        var pct = Math.round((cargado / totalBytes) * 100);
        barra.style.width = pct + "%";
        porcentajeTxt.textContent = pct + "%";
        estadoTxt.textContent = "Subiendo " + terminados + " de " + aSubir.length + "…";
      }

      pintarTotal();
      var siguiente = 0;
      async function trabajador() {
        while (siguiente < aSubir.length) {
          var p = aSubir[siguiente];
          siguiente += 1;
          p.fila.classList.add("is-subiendo");
          try {
            var resultado = await subirUno(p, function (fraccion) {
              p.avance = fraccion;
              p.barra.style.width = Math.round(fraccion * 100) + "%";
              pintarTotal();
            });
            p.subido = true;
            p.avance = 1;
            subidos.push(resultado);
            p.fila.classList.remove("is-subiendo");
            p.fila.classList.add("is-lista");
            p.detalle.textContent = "Subido";
          } catch (error) {
            fallidos += 1;
            p.avance = 1;
            p.error = error.message;
            p.fila.classList.remove("is-subiendo");
            p.fila.classList.add("is-error");
            p.detalle.textContent = error.message;
            p.detalle.title = error.message;
          }
          terminados += 1;
          pintarTotal();
        }
      }

      var trabajadores = [];
      for (var i = 0; i < Math.min(CONCURRENCIA, aSubir.length); i += 1) trabajadores.push(trabajador());
      await Promise.all(trabajadores);

      if (subidos.length) {
        estadoTxt.textContent = "Guardando…";
        try {
          await fetch(G.rutaEvento(datos.slug) + "/fotos", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ images: subidos }),
            credentials: "same-origin",
          });
        } catch (error) {
          // Los archivos ya están en el storage; sólo falló el registro de actividad.
        }
      }

      global.removeEventListener("beforeunload", avisarSalida);
      subiendo = false;
      zona.classList.remove("is-bloqueada");
      btnLimpiar.disabled = false;
      cola.classList.remove("is-subiendo");

      if (subidos.length && !fallidos) {
        estadoTxt.textContent = "¡Listo! Actualizando la galería…";
        global.location.href =
          global.location.pathname + "?ok=" + encodeURIComponent(plural(subidos.length, "archivo subido", "archivos subidos"));
        return;
      }

      if (subidos.length) {
        await G.alertar(
          "Algunos archivos no se subieron",
          plural(subidos.length, "archivo se subió", "archivos se subieron") + " y " +
            plural(fallidos, "falló", "fallaron") + ". La galería se actualizará para mostrar lo subido."
        );
        global.location.reload();
        return;
      }

      pintarResumen();
      estadoTxt.textContent = "No se pudo subir ningún archivo. Revisa los errores e intenta de nuevo.";
    });
  }

  /* ====================================================================== */

  function iniciar() {
    Hero.construir();
    iniciarMosaico();
    iniciarSubida();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})(window);
