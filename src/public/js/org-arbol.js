/**
 * Organigrama de áreas — lienzo con zoom, búsqueda y filtros sobre el árbol.
 *
 * Lienzo: el árbol va dentro de un marco que recorta lo que no cabe. El
 * contenido se mueve con transform (translate + scale) desde la barra de
 * arriba, arrastrando, con Ctrl + rueda o con el desplazamiento horizontal del
 * trackpad. La altura del marco sigue a la del árbol escalado: lo vertical es
 * de la página y sólo lo horizontal se desplaza dentro del lienzo.
 *
 * Búsqueda: en un árbol no se puede ocultar un nodo sin romper las líneas que
 * unen a padres e hijos, así que buscar y filtrar resaltan: los nodos que
 * coinciden se marcan y el resto se atenúa. El primero que coincide se lleva
 * a la vista, porque en un organigrama largo puede quedar fuera de la pantalla.
 */
(function () {
  "use strict";

  var DIACRITICOS = new RegExp("[\\u0300-\\u036f]", "g");
  var ZOOM_MIN = 0.4;
  var ZOOM_MAX = 1.6;
  var PASO_ZOOM = 1.2;
  // Un arrastre más corto que esto es un clic: no debe mover nada.
  var UMBRAL_ARRASTRE = 5;

  function todos(selector, raiz) {
    return Array.prototype.slice.call((raiz || document).querySelectorAll(selector));
  }

  function normalizar(texto) {
    var base = String(texto || "").toLowerCase();
    return base.normalize ? base.normalize("NFD").replace(DIACRITICOS, "") : base;
  }

  function limitar(valor, min, max) {
    return Math.min(max, Math.max(min, valor));
  }

  // ── Lienzo ────────────────────────────────────────────────────────────────

  function crearLienzo(lienzo) {
    var vista = lienzo.querySelector("[data-org-vista]");
    var contenido = lienzo.querySelector("[data-org-contenido]");
    var controles = lienzo.querySelector("[data-org-controles]");
    var pista = lienzo.querySelector("[data-org-pista]");
    var etiqueta = lienzo.querySelector("[data-org-zoom]");
    var arbol = contenido && contenido.querySelector(".org-tree");
    if (!vista || !contenido || !arbol) return null;

    var botones = {};
    todos("[data-org-accion]", lienzo).forEach(function (btn) {
      botones[btn.dataset.orgAccion] = btn;
    });

    // `ajustado`: el usuario no tocó el zoom; al cambiar el ancho se reajusta.
    var estado = { escala: 1, x: 0, ajustado: true };
    var animarHasta = 0;

    lienzo.classList.add("is-interactivo");
    vista.scrollLeft = 0;
    if (controles) controles.hidden = false;
    if (pista) pista.hidden = false;

    function medidas() {
      var estilo = window.getComputedStyle(contenido);
      var relleno = parseFloat(estilo.paddingLeft) + parseFloat(estilo.paddingRight);
      return {
        vista: vista.clientWidth,
        // transform no altera el layout: estas son las medidas al 100 %.
        ancho: Math.max(contenido.clientWidth, arbol.offsetWidth + relleno),
        alto: contenido.offsetHeight,
      };
    }

    function limitarX(x, escala, m) {
      var ancho = m.ancho * escala;
      if (ancho <= m.vista) return (m.vista - ancho) / 2;
      return limitar(x, m.vista - ancho, 0);
    }

    function pintar(animar) {
      var m = medidas();
      estado.x = limitarX(estado.x, estado.escala, m);

      if (animar) {
        lienzo.classList.add("is-animado");
        animarHasta = Date.now() + 300;
        window.setTimeout(function () {
          if (Date.now() >= animarHasta) lienzo.classList.remove("is-animado");
        }, 320);
      } else {
        lienzo.classList.remove("is-animado");
      }

      contenido.style.transform =
        "translate(" + estado.x.toFixed(1) + "px, 0) scale(" + estado.escala.toFixed(4) + ")";
      vista.style.height = Math.ceil(m.alto * estado.escala) + "px";

      var ancho = m.ancho * estado.escala;
      var hayIzq = estado.x < -0.5;
      var hayDer = estado.x + ancho > m.vista + 0.5;
      vista.classList.toggle("hay-izq", hayIzq);
      vista.classList.toggle("hay-der", hayDer);
      vista.classList.toggle("is-arrastrable", hayIzq || hayDer);

      if (botones.izquierda) botones.izquierda.disabled = !hayIzq;
      if (botones.derecha) botones.derecha.disabled = !hayDer;
      if (botones.alejar) botones.alejar.disabled = estado.escala <= ZOOM_MIN + 0.001;
      if (botones.acercar) botones.acercar.disabled = estado.escala >= ZOOM_MAX - 0.001;
      if (etiqueta) etiqueta.textContent = Math.round(estado.escala * 100) + "%";
    }

    /** Todo el ancho a la vista, sin agrandar más allá del 100 %. */
    function ajustar(animar) {
      var m = medidas();
      estado.escala = limitar(m.vista / m.ancho, ZOOM_MIN, 1);
      estado.x = 0;
      estado.ajustado = true;
      pintar(animar);
    }

    /** Cambia la escala dejando quieto el punto `ancla` (px desde el borde izquierdo de la vista). */
    function zoomA(escala, ancla) {
      var nueva = limitar(escala, ZOOM_MIN, ZOOM_MAX);
      var punto = ancla == null ? vista.clientWidth / 2 : ancla;
      var enContenido = (punto - estado.x) / estado.escala;
      estado.escala = nueva;
      estado.x = punto - enContenido * nueva;
      estado.ajustado = false;
      pintar(true);
    }

    function desplazar(sentido) {
      estado.x -= sentido * vista.clientWidth * 0.5;
      pintar(true);
    }

    /** Lleva un nodo al centro horizontal de la vista. */
    function centrar(nodo) {
      var rVista = vista.getBoundingClientRect();
      var rNodo = nodo.getBoundingClientRect();
      estado.x += rVista.width / 2 - (rNodo.left - rVista.left + rNodo.width / 2);
      pintar(true);
    }

    var acciones = {
      izquierda: function () { desplazar(-1); },
      derecha: function () { desplazar(1); },
      alejar: function () { zoomA(estado.escala / PASO_ZOOM); },
      acercar: function () { zoomA(estado.escala * PASO_ZOOM); },
      real: function () { zoomA(1); },
      ajustar: function () { ajustar(true); },
    };
    Object.keys(botones).forEach(function (accion) {
      botones[accion].addEventListener("click", function () {
        if (acciones[accion]) acciones[accion]();
      });
    });

    // Arrastrar con el mouse o el dedo. Se captura el puntero recién al pasar
    // el umbral, para que un clic en un botón del nodo siga siendo un clic.
    var arrastre = null;
    var anularClic = false;

    vista.addEventListener("pointerdown", function (evento) {
      if (evento.button !== 0) return;
      if (evento.target.closest("input, select, textarea")) return;
      arrastre = { id: evento.pointerId, inicio: evento.clientX, x: estado.x, activo: false };
    });

    vista.addEventListener("pointermove", function (evento) {
      if (!arrastre || evento.pointerId !== arrastre.id) return;
      var dx = evento.clientX - arrastre.inicio;
      if (!arrastre.activo) {
        if (Math.abs(dx) < UMBRAL_ARRASTRE || !vista.classList.contains("is-arrastrable")) return;
        arrastre.activo = true;
        vista.classList.add("is-arrastrando");
        if (vista.setPointerCapture) vista.setPointerCapture(evento.pointerId);
      }
      estado.x = arrastre.x + dx;
      pintar(false);
    });

    function terminarArrastre(evento) {
      if (!arrastre || (evento && evento.pointerId !== arrastre.id)) return;
      if (arrastre.activo) {
        anularClic = true;
        window.setTimeout(function () { anularClic = false; }, 0);
      }
      vista.classList.remove("is-arrastrando");
      arrastre = null;
    }
    vista.addEventListener("pointerup", terminarArrastre);
    vista.addEventListener("pointercancel", terminarArrastre);

    // El clic que cierra un arrastre no debe abrir el nodo donde se soltó.
    vista.addEventListener("click", function (evento) {
      if (!anularClic) return;
      evento.preventDefault();
      evento.stopPropagation();
      anularClic = false;
    }, true);

    // Ctrl/⌘ + rueda (y el pellizco del trackpad) acerca o aleja hacia el
    // puntero; el desplazamiento horizontal mueve el árbol. La rueda vertical
    // sola sigue siendo de la página.
    vista.addEventListener("wheel", function (evento) {
      if (evento.ctrlKey || evento.metaKey) {
        evento.preventDefault();
        var ancla = evento.clientX - vista.getBoundingClientRect().left;
        var factor = Math.exp(-evento.deltaY * 0.0025);
        var anterior = estado.escala;
        var nueva = limitar(anterior * factor, ZOOM_MIN, ZOOM_MAX);
        var enContenido = (ancla - estado.x) / anterior;
        estado.escala = nueva;
        estado.x = ancla - enContenido * nueva;
        estado.ajustado = false;
        pintar(false);
        return;
      }
      var horizontal = evento.shiftKey ? evento.deltaY || evento.deltaX : evento.deltaX;
      if (!horizontal || (!evento.shiftKey && Math.abs(evento.deltaX) <= Math.abs(evento.deltaY))) return;
      if (!vista.classList.contains("is-arrastrable")) return;
      evento.preventDefault();
      estado.x -= horizontal;
      pintar(false);
    }, { passive: false });

    // Cambia el ancho de la ventana o el árbol termina de cargar (fuentes,
    // fotos): se reajusta si nadie tocó el zoom, si no sólo se reacomoda.
    var anchoPrevio = vista.clientWidth;
    var altoPrevio = arbol.offsetHeight;
    function alCambiarTamano() {
      var ancho = vista.clientWidth;
      var alto = arbol.offsetHeight;
      if (ancho === anchoPrevio && alto === altoPrevio) return;
      anchoPrevio = ancho;
      altoPrevio = alto;
      if (estado.ajustado) ajustar(false);
      else pintar(false);
    }
    if (window.ResizeObserver) {
      var observador = new ResizeObserver(alCambiarTamano);
      observador.observe(vista);
      observador.observe(arbol);
    } else {
      window.addEventListener("resize", alCambiarTamano);
    }

    ajustar(false);
    return { centrar: centrar };
  }

  /** Deja el nodo dentro de la ventana, debajo de la topbar y la cabecera fija del lienzo. */
  function mostrarEnVertical(nodo, marco) {
    var rect = nodo.getBoundingClientRect();
    var topbar = parseFloat(
      window.getComputedStyle(document.documentElement).getPropertyValue("--shell-height"),
    ) || 64;
    var barra = marco && marco.querySelector(".org-lienzo__barra");
    var margenSuperior = topbar + (barra ? barra.offsetHeight : 0) + 24;
    if (rect.top >= margenSuperior && rect.bottom <= window.innerHeight - 24) return;
    var destino = window.scrollY + rect.top - Math.max(margenSuperior, (window.innerHeight - rect.height) / 2);
    window.scrollTo({ top: Math.max(0, destino), behavior: "smooth" });
  }

  function llevarAVista(nodo, lienzos) {
    var marco = nodo.closest("[data-org-lienzo]");
    var lienzo = marco && lienzos.get(marco);
    if (lienzo) {
      lienzo.centrar(nodo);
      // Se mide cuando termina la animación horizontal.
      window.setTimeout(function () { mostrarEnVertical(nodo, marco); }, 300);
    } else if (nodo.scrollIntoView) {
      nodo.scrollIntoView({ behavior: "smooth", block: "nearest", inline: "center" });
    }
  }

  // ── Búsqueda y filtros ──────────────────────────────────────────────────────

  var PREDICADOS = {
    todas: null,
    "sin-jefe": function (nodo) { return nodo.dataset.sinJefe === "true"; },
    "sin-aprobador": function (nodo) { return nodo.dataset.sinAprobador === "true"; },
    vacias: function (nodo) { return Number(nodo.dataset.miembros || 0) === 0; },
  };

  function init() {
    var lienzos = new Map();
    todos("[data-org-lienzo]").forEach(function (marco) {
      var lienzo = crearLienzo(marco);
      if (lienzo) lienzos.set(marco, lienzo);
    });

    var nodos = todos("[data-org-node]");
    if (!nodos.length) return;

    var input = document.querySelector("[data-org-buscar]");
    var chips = todos("[data-org-filtro]");
    var aviso = document.querySelector("[data-org-sin-resultados]");
    var conteo = document.querySelector("[data-org-conteo]");
    var estado = { texto: "", filtro: "todas" };

    function aplicar() {
      var q = normalizar(estado.texto).trim();
      var predicado = PREDICADOS[estado.filtro] || null;
      var activo = Boolean(q || predicado);
      var primero = null;
      var coincidencias = 0;

      nodos.forEach(function (nodo) {
        var coincide =
          activo &&
          (!predicado || predicado(nodo)) &&
          (!q || normalizar(nodo.dataset.buscar).indexOf(q) !== -1);
        nodo.classList.toggle("is-match", coincide);
        nodo.classList.toggle("is-dim", activo && !coincide);
        if (coincide) {
          coincidencias += 1;
          if (!primero) primero = nodo;
        }
      });

      if (aviso) aviso.hidden = !activo || coincidencias > 0;
      if (conteo) {
        conteo.hidden = !activo || coincidencias === 0;
        conteo.textContent =
          coincidencias === 1 ? "1 área resaltada" : coincidencias + " áreas resaltadas";
      }
      if (primero) llevarAVista(primero, lienzos);
    }

    if (input) {
      input.addEventListener("input", function () {
        estado.texto = input.value;
        aplicar();
      });
      input.addEventListener("keydown", function (evento) {
        if (evento.key !== "Escape" || !input.value) return;
        evento.stopPropagation();
        input.value = "";
        estado.texto = "";
        aplicar();
      });
    }

    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        chips.forEach(function (otro) {
          otro.classList.toggle("is-active", otro === chip);
        });
        estado.filtro = chip.dataset.orgFiltro || "todas";
        aplicar();
      });
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
