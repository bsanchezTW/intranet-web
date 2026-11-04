/**
 * Fotos de la revisión física (Gestión de flota).
 *
 *   FlotaFotos.reducir(file)        → Blob JPEG de a lo más 1600 px por lado,
 *                                     con la orientación de la cámara aplicada
 *   FlotaFotos.selector(raiz, opc)  → lista de fotos con miniaturas, botón
 *                                     para quitar y contador «n de 4»
 *
 * Y mejora sola el formulario de reparación ([data-reparar-form]): reduce las
 * fotos antes de subirlas y muestra los errores sin recargar. Sin JS ese
 * formulario se envía igual, con las fotos originales.
 */
(function (global) {
  "use strict";

  var MAX_EDGE = 1600;
  var CALIDAD = 0.82;

  function cargarImagen(file) {
    if (global.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: "from-image" }).catch(function () {
        return createImageBitmap(file);
      });
    }
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("imagen")); };
      img.src = url;
    });
  }

  /** Reduce la foto; si el navegador no puede, devuelve la original (el servidor la valida). */
  function reducir(file, opciones) {
    var max = (opciones && opciones.maxEdge) || MAX_EDGE;
    return cargarImagen(file).then(function (img) {
      var w = img.width;
      var h = img.height;
      var escala = Math.min(1, max / w, max / h);
      var canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(w * escala));
      canvas.height = Math.max(1, Math.round(h * escala));
      var ctx = canvas.getContext("2d");
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      if (img.close) img.close();
      return new Promise(function (resolve) {
        canvas.toBlob(function (blob) { resolve(blob || file); }, "image/jpeg", CALIDAD);
      });
    }).catch(function () { return file; });
  }

  /** Data URL → Blob (las capturas del modelo). */
  function dataUrlABlob(url) {
    var partes = String(url).split(",");
    var tipo = (partes[0].match(/data:([^;]+)/) || [])[1] || "image/jpeg";
    var bin = atob(partes[1] || "");
    var bytes = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return new Blob([bytes], { type: tipo });
  }

  var ICONO_QUITAR = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  /**
   * Selector de fotos dentro de `raiz` ([data-fotos]): inputs [data-fotos-input],
   * lista [data-fotos-lista], contador [data-fotos-conteo] y los botones
   * [data-fotos-botones], que se esconden al llegar al máximo.
   */
  function selector(raiz, opciones) {
    var max = (opciones && opciones.max) || 4;
    var alCambiar = (opciones && opciones.onChange) || function () {};
    var lista = raiz.querySelector("[data-fotos-lista]");
    var conteo = raiz.querySelector("[data-fotos-conteo]");
    var botones = raiz.querySelector("[data-fotos-botones]");
    var inputs = Array.prototype.slice.call(raiz.querySelectorAll("[data-fotos-input]"));
    var fotos = []; // { blob, url, listo: Promise }
    var aviso = null;

    function pintar() {
      lista.innerHTML = "";
      fotos.forEach(function (f, i) {
        var li = document.createElement("li");
        li.className = "fisica-fotos__item";
        var img = document.createElement("img");
        img.src = f.url;
        img.alt = "Foto " + (i + 1);
        var quitar = document.createElement("button");
        quitar.type = "button";
        quitar.className = "fisica-fotos__quitar";
        quitar.setAttribute("aria-label", "Quitar la foto " + (i + 1));
        quitar.innerHTML = ICONO_QUITAR;
        quitar.addEventListener("click", function () {
          URL.revokeObjectURL(f.url);
          fotos.splice(i, 1);
          pintar();
        });
        li.appendChild(img);
        li.appendChild(quitar);
        lista.appendChild(li);
      });
      if (conteo) conteo.textContent = fotos.length + " de " + max;
      if (botones) botones.hidden = fotos.length >= max;
      raiz.classList.toggle("is-completo", fotos.length >= max);
      alCambiar(fotos.length);
    }

    function agregar(files) {
      var nuevas = Array.prototype.slice.call(files || []).filter(function (f) {
        return /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp)$/i.test(f.name || "");
      });
      var libres = max - fotos.length;
      if (nuevas.length > libres) {
        aviso = "Son " + max + " fotos como máximo: se agregaron las primeras " + libres + ".";
        if (global.IntranetToast) global.IntranetToast.show(aviso, { tone: "info" });
      }
      nuevas.slice(0, Math.max(0, libres)).forEach(function (file) {
        var f = { blob: file, url: URL.createObjectURL(file) };
        f.listo = reducir(file).then(function (blob) { f.blob = blob; return blob; });
        fotos.push(f);
      });
      pintar();
    }

    inputs.forEach(function (input) {
      input.addEventListener("change", function () {
        agregar(input.files);
        input.value = "";
      });
    });

    pintar();
    return {
      cantidad: function () { return fotos.length; },
      /** Promesa con los Blob ya reducidos, en orden. */
      blobs: function () {
        return Promise.all(fotos.map(function (f) { return f.listo; }));
      },
      /** Entrega las fotos (y sus URL de vista previa) y deja el selector vacío. */
      soltar: function () {
        var salida = fotos.slice();
        fotos = [];
        pintar();
        return salida;
      },
      limpiar: function () {
        fotos.forEach(function (f) { URL.revokeObjectURL(f.url); });
        fotos = [];
        pintar();
      },
    };
  }

  // --- Formulario de reparación ------------------------------------------------

  function mostrarErrores(form, errors) {
    form.querySelectorAll("[data-error-for]").forEach(function (n) { n.hidden = true; n.textContent = ""; });
    var general = form.querySelector("[data-form-error]");
    var resto = [];
    Object.keys(errors || {}).forEach(function (campo) {
      var nodo = form.querySelector('[data-error-for="' + campo + '"]');
      if (nodo) { nodo.textContent = errors[campo]; nodo.hidden = false; }
      else resto.push(errors[campo]);
    });
    if (general) {
      general.hidden = !resto.length;
      var texto = general.querySelector("[data-form-error-texto]");
      if (texto) texto.textContent = resto.join(" ");
    }
    if (global.IntranetToast) global.IntranetToast.show("Revisa lo marcado antes de guardar.", { tone: "error" });
  }

  function mejorarReparacion(form) {
    var raiz = form.querySelector("[data-fotos]");
    if (!raiz) return;
    // Con JS, las fotos se eligen en el selector (el input queda sin name).
    raiz.querySelectorAll("[data-fotos-input]").forEach(function (i) { i.removeAttribute("name"); i.removeAttribute("required"); });
    var sel = selector(raiz, { max: Number(raiz.dataset.max) || 4 });
    var boton = form.querySelector("[type=submit]");
    var enviando = false;

    form.addEventListener("submit", function (e) {
      e.preventDefault();
      if (enviando) return;
      enviando = true;
      if (boton) { boton.disabled = true; boton.classList.add("is-cargando"); }
      sel.blobs().then(function (blobs) {
        var datos = new FormData(form);
        blobs.forEach(function (b, i) { datos.append("fotos", b, "reparacion-" + (i + 1) + ".jpg"); });
        return fetch(form.action, {
          method: "POST",
          body: datos,
          credentials: "same-origin",
          headers: { "X-Requested-With": "fetch", Accept: "application/json" },
        });
      }).then(function (res) {
        return res.json().catch(function () { return { errors: { general: "No se pudo guardar. Vuelve a intentarlo." } }; });
      }).then(function (json) {
        if (json && json.ok && json.redirect) { global.location.href = json.redirect; return; }
        mostrarErrores(form, (json && json.errors) || { general: "No se pudo guardar." });
        enviando = false;
        if (boton) { boton.disabled = false; boton.classList.remove("is-cargando"); }
      }).catch(function () {
        mostrarErrores(form, { general: "Sin conexión: no se pudo guardar. Vuelve a intentarlo." });
        enviando = false;
        if (boton) { boton.disabled = false; boton.classList.remove("is-cargando"); }
      });
    });
  }

  document.querySelectorAll("form[data-reparar-form]").forEach(mejorarReparacion);

  global.FlotaFotos = { reducir: reducir, selector: selector, dataUrlABlob: dataUrlABlob, mostrarErrores: mostrarErrores };
})(window);
