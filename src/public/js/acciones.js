/**
 * Acciones declarativas en el HTML, en vez de onclick="…" y onerror="…".
 *
 * Los atributos on* son JavaScript inline: una CSP estricta los bloquea, y
 * cuando llevan datos del servidor dentro de un string JS (onclick="f('<%= x %>')")
 * EJS no los protege: el navegador decodifica &#39; antes de ejecutar y una
 * comilla en el dato cierra el string. Aquí los datos viajan como JSON en un
 * atributo data-*, que nunca se ejecuta.
 *
 *   data-accion="IntranetModal.open" data-args='["modalSubir"]'
 *       llama a window.IntranetModal.open("modalSubir"). En los argumentos,
 *       {"$el":true} es el elemento (el `this` de antes) y
 *       {"$global":"Nombre"} es window.Nombre.
 *   data-ir="/cursos"          navega (location.href)
 *   data-abrir="https://…"     abre en otra pestaña
 *
 *   <img data-fallback-src="/img/x.png">     si falla, usa esa imagen
 *   <img data-full="…">                       (con fallback) antes prueba la original
 *   <img data-si-falla="quitar">              si falla, se quita
 *   <img data-si-falla="quitar:.selector">    si falla, quita el ancestro
 *
 * Se carga en el <head>: el evento error de una imagen no burbujea y puede
 * ocurrir antes de que corra un script al final de la página.
 */
(function () {
  "use strict";

  function resolver(ruta) {
    var partes = String(ruta || "").split(".");
    var contexto = window;
    var valor = window;
    for (var i = 0; i < partes.length; i += 1) {
      if (!/^[A-Za-z_$][\w$]*$/.test(partes[i])) return null;
      contexto = valor;
      valor = valor == null ? undefined : valor[partes[i]];
    }
    return typeof valor === "function" ? { fn: valor, ctx: partes.length > 1 ? contexto : window } : null;
  }

  function valorGlobal(ruta) {
    var valor = window;
    var partes = String(ruta).split(".");
    for (var i = 0; i < partes.length; i += 1) {
      if (valor == null || !/^[A-Za-z_$][\w$]*$/.test(partes[i])) return undefined;
      valor = valor[partes[i]];
    }
    return valor;
  }

  function argumentos(el) {
    var crudo = el.getAttribute("data-args");
    if (!crudo) return [];
    var lista;
    try {
      lista = JSON.parse(crudo);
    } catch (e) {
      return [];
    }
    if (!Array.isArray(lista)) lista = [lista];
    return lista.map(function (a) {
      if (a && typeof a === "object" && a.$el === true) return el;
      if (a && typeof a === "object" && typeof a.$global === "string") return valorGlobal(a.$global);
      return a;
    });
  }

  document.addEventListener("click", function (event) {
    var el = event.target.closest && event.target.closest("[data-accion],[data-ir],[data-abrir]");
    if (!el) return;

    if (el.hasAttribute("data-ir")) {
      event.preventDefault();
      window.location.href = el.getAttribute("data-ir");
      return;
    }
    if (el.hasAttribute("data-abrir")) {
      event.preventDefault();
      window.open(el.getAttribute("data-abrir"), "_blank", "noopener");
      return;
    }

    var destino = resolver(el.getAttribute("data-accion"));
    if (!destino) {
      if (window.console) console.warn("[acciones] no existe la función", el.getAttribute("data-accion"));
      return;
    }
    // Sólo la acción más cercana: un botón dentro de una tarjeta con su
    // propia acción ya no dispara la de la tarjeta (era el stopPropagation).
    if (el.tagName === "A" || el.hasAttribute("data-prevenir")) event.preventDefault();
    destino.fn.apply(destino.ctx, argumentos(el));
  });

  function alFallar(img) {
    var d = img.dataset;
    if (d.fallbackSrc) {
      if (d.full && !d.fullTried && d.full !== img.getAttribute("src")) {
        d.fullTried = "1";
        img.src = d.full;
        return;
      }
      if (!d.fallbackTried && img.getAttribute("src") !== d.fallbackSrc) {
        d.fallbackTried = "1";
        img.src = d.fallbackSrc;
      }
      return;
    }
    var accion = d.siFalla || "";
    if (accion === "quitar") {
      img.remove();
    } else if (accion.indexOf("quitar:") === 0) {
      var ancestro = img.closest(accion.slice(7));
      if (ancestro) ancestro.remove();
    }
  }

  function manejada(img) {
    return img instanceof HTMLImageElement && (img.hasAttribute("data-fallback-src") || img.hasAttribute("data-si-falla"));
  }

  document.addEventListener(
    "error",
    function (event) {
      if (manejada(event.target)) alFallar(event.target);
    },
    true,
  );

  // Las que fallaron antes de que este script corriera.
  function revisar() {
    var imgs = document.querySelectorAll("img[data-fallback-src],img[data-si-falla]");
    for (var i = 0; i < imgs.length; i += 1) {
      var img = imgs[i];
      if (img.complete && img.naturalWidth === 0 && img.getAttribute("src")) alFallar(img);
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", revisar);
  } else {
    revisar();
  }

  window.IntranetAcciones = { revisarImagenes: revisar };
})();
