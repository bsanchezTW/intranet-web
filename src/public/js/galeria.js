/* ==========================================================================
   Galería — piezas compartidas por la lista y el detalle de un evento
   1. Revelado de imágenes (sin huecos en blanco mientras cargan)
   2. Modal de evento: crear / editar, portada y zona de peligro
   ========================================================================== */
(function (global) {
  "use strict";

  /* ======================================================================
     Utilidades
     ====================================================================== */

  function aviso(mensaje, tono) {
    if (global.IntranetToast) global.IntranetToast.show(mensaje, { tone: tono });
  }

  function alertar(titulo, mensaje) {
    if (global.IntranetDialog) return global.IntranetDialog.alert({ title: titulo, message: mensaje });
    global.alert(mensaje);
    return Promise.resolve();
  }

  /** POST urlencoded que espera JSON. Lanza Error con el mensaje del servidor. */
  async function enviar(url, datos) {
    var cuerpo = datos instanceof FormData ? datos : new URLSearchParams(datos || {});
    var respuesta = await fetch(url, {
      method: "POST",
      headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest" },
      body: cuerpo,
      credentials: "same-origin",
    });
    var json = null;
    try { json = await respuesta.json(); } catch (e) { json = null; }
    if (!respuesta.ok) {
      throw new Error((json && json.error) || "No se pudo completar la acción. Intenta de nuevo.");
    }
    return json || {};
  }

  function rutaEvento(slug) {
    return "/marketing/eventos/" + encodeURIComponent(slug);
  }

  /** Sube una imagen a la carpeta del evento y la deja como portada. */
  async function subirPortada(slug, archivo) {
    var fd = new FormData();
    fd.append("archivo", archivo, archivo.name || "portada.jpg");
    var subido = await enviar(rutaEvento(slug) + "/fotos/upload", fd);
    await enviar(rutaEvento(slug) + "/portada", { url_imagen: subido.secure_url || subido.url });
    return subido;
  }

  /* ======================================================================
     1. Revelado de imágenes
     ====================================================================== */

  function revelar(img) {
    var marco = img.parentElement;
    function listo() {
      if (marco) marco.classList.remove("is-cargando");
      img.classList.add("is-lista");
    }
    function fallo() {
      if (marco) {
        marco.classList.remove("is-cargando");
        marco.classList.add("is-error");
      }
      img.remove();
    }
    if (img.complete && img.naturalWidth) { listo(); return; }
    img.addEventListener("load", listo, { once: true });
    img.addEventListener("error", fallo, { once: true });
  }

  function iniciarRevelado(raiz) {
    Array.prototype.forEach.call((raiz || document).querySelectorAll("img[data-galeria-revelar]"), revelar);
  }

  /* ======================================================================
     2. Modal de evento
     ====================================================================== */

  function iniciarModal() {
    var overlay = document.getElementById("modalEvento");
    if (!overlay) return;

    var modo = overlay.getAttribute("data-modo");
    var slug = overlay.getAttribute("data-slug");
    var esEditar = modo === "editar";

    var form = document.getElementById("formEvento");
    var alerta = document.getElementById("eventoAlerta");
    var estadoPie = document.getElementById("eventoEstado");
    var nombre = document.getElementById("eventoNombre");
    var descripcion = document.getElementById("eventoDescripcion");
    var guardar = document.getElementById("eventoGuardar");
    var textoGuardar = guardar.textContent.trim();

    var portada = document.getElementById("eventoPortada");
    var portadaImg = document.getElementById("eventoPortadaImg");
    var portadaVacia = document.getElementById("eventoPortadaVacia");
    var portadaQuitar = document.getElementById("eventoPortadaQuitar");
    var portadaElegir = document.getElementById("eventoPortadaElegir");
    var portadaGaleria = document.getElementById("eventoPortadaGaleria");
    var eliminar = document.getElementById("eventoEliminar");

    var portadaActual = portada.getAttribute("data-actual") || "";
    // null = sin cambios; { tipo: "url", url } o { tipo: "archivo", archivo }
    var portadaNueva = null;
    var cropper = null;
    var enviando = false;

    /* ---- Contadores ---- */
    Array.prototype.forEach.call(overlay.querySelectorAll("[data-contador-de]"), function (contador) {
      var campo = document.getElementById(contador.getAttribute("data-contador-de"));
      if (!campo) return;
      var max = Number(campo.getAttribute("maxlength")) || 0;
      function pintar() {
        contador.textContent = campo.value.length + " / " + max;
        contador.classList.toggle("limit-reached", max && campo.value.length >= max);
      }
      campo.addEventListener("input", pintar);
      pintar();
    });

    /* ---- Errores ---- */
    function marcarCampo(campo, mensaje) {
      var contenedor = campo.closest(".campo-form");
      if (!contenedor) return;
      contenedor.classList.toggle("is-invalid", Boolean(mensaje));
      var nodo = contenedor.querySelector(".campo-form__error");
      if (nodo) nodo.textContent = mensaje || "";
    }

    function mostrarAlerta(mensaje) {
      alerta.textContent = mensaje || "";
      alerta.hidden = !mensaje;
    }

    nombre.addEventListener("input", function () { marcarCampo(nombre, ""); });

    /* ---- Portada ---- */
    function pintarPortada(src) {
      if (src) {
        portadaImg.src = src;
        portadaImg.hidden = false;
        portadaVacia.hidden = true;
      } else {
        portadaImg.removeAttribute("src");
        portadaImg.hidden = true;
        portadaVacia.hidden = false;
      }
      portadaQuitar.hidden = !portadaNueva;
      portada.classList.toggle("is-nueva", Boolean(portadaNueva));
    }

    function marcarOpcion(url) {
      if (!portadaGaleria) return;
      Array.prototype.forEach.call(portadaGaleria.querySelectorAll(".galeria-portada__opcion"), function (op) {
        var elegida = op.getAttribute("data-url") === url;
        op.classList.toggle("is-elegida", elegida);
        op.setAttribute("aria-selected", elegida ? "true" : "false");
      });
    }

    function deshacerPortada() {
      portadaNueva = null;
      if (cropper && cropper.clearPhoto) cropper.clearPhoto();
      marcarOpcion(portadaActual);
      pintarPortada(portadaActual);
    }

    if (global.ProfilePhotoCropper) {
      cropper = global.ProfilePhotoCropper.init({
        fileInputId: "eventoPortadaArchivo",
        previewImgId: "eventoPortadaImg",
        previewPlaceholderId: "eventoPortadaVacia",
        selectBtnId: "eventoPortadaSubir",
        overlayId: "eventoCropOverlay",
        cropImgId: "eventoCropImagen",
        closeBtnId: "eventoCropCerrar",
        cancelBtnId: "eventoCropCancelar",
        saveBtnId: "eventoCropAplicar",
        errorElId: "eventoCropError",
        aspectRatio: 16 / 9,
        outputWidth: 1600,
        outputHeight: 900,
        maxSizeMb: 10,
        outputFilename: "portada-evento.jpg",
        selectLabel: "Subir imagen",
        changeLabel: "Subir otra imagen",
        onCropped: function (archivo) {
          portadaNueva = { tipo: "archivo", archivo: archivo };
          marcarOpcion(null);
          portadaQuitar.hidden = false;
          portada.classList.add("is-nueva");
        },
      });
    }

    portadaQuitar.addEventListener("click", deshacerPortada);

    if (portadaElegir && portadaGaleria) {
      portadaElegir.addEventListener("click", function () {
        var abrir = portadaGaleria.hidden;
        portadaGaleria.hidden = !abrir;
        portadaElegir.setAttribute("aria-expanded", abrir ? "true" : "false");
        if (!abrir) return;
        Array.prototype.forEach.call(portadaGaleria.querySelectorAll("img[data-src]"), function (img) {
          img.src = img.getAttribute("data-src");
          img.removeAttribute("data-src");
        });
      });

      portadaGaleria.addEventListener("click", function (evento) {
        var opcion = evento.target.closest(".galeria-portada__opcion");
        if (!opcion) return;
        var url = opcion.getAttribute("data-url");
        if (cropper && cropper.clearPhoto) cropper.clearPhoto();
        if (url === portadaActual) {
          deshacerPortada();
          return;
        }
        portadaNueva = { tipo: "url", url: url };
        marcarOpcion(url);
        pintarPortada(url);
      });
    }

    /* ---- Apertura ---- */
    function abrir() {
      mostrarAlerta("");
      if (global.IntranetModal) global.IntranetModal.open(overlay);
      global.requestAnimationFrame(function () { nombre.focus({ preventScroll: true }); });
    }

    Array.prototype.forEach.call(document.querySelectorAll("[data-abrir-modal-evento]"), function (boton) {
      boton.addEventListener("click", abrir);
    });

    var params = new URLSearchParams(global.location.search);
    var pedido = params.get("modal");
    if ((pedido === "nuevo" && !esEditar) || (pedido === "editar" && esEditar)) {
      abrir();
      if (params.get("error")) mostrarAlerta(params.get("error"));
      params.delete("modal");
      params.delete("error");
      var query = params.toString();
      global.history.replaceState({}, document.title, global.location.pathname + (query ? "?" + query : ""));
    }

    /* ---- Envío ---- */
    function ocupado(activo, texto) {
      enviando = activo;
      guardar.disabled = activo;
      guardar.classList.toggle("is-enviando", activo);
      guardar.innerHTML = activo
        ? '<span class="btn-submit-spinner" aria-hidden="true"></span> ' + (texto || "Guardando…")
        : textoGuardar;
      if (eliminar) eliminar.disabled = activo;
      estadoPie.textContent = activo ? texto || "" : "";
    }

    form.addEventListener("submit", async function (evento) {
      evento.preventDefault();
      if (enviando) return;
      mostrarAlerta("");

      var titulo = nombre.value.trim();
      if (!titulo) {
        marcarCampo(nombre, "Escribe el título del evento.");
        nombre.focus();
        return;
      }

      var datos = { name: titulo, description: descripcion.value.trim() };

      if (!esEditar) {
        ocupado(true, "Creando evento…");
        var creado;
        try {
          creado = await enviar(form.action, datos);
        } catch (error) {
          ocupado(false);
          if (/nombre/i.test(error.message)) marcarCampo(nombre, error.message);
          else mostrarAlerta(error.message);
          return;
        }

        var destino = rutaEvento(creado.slug) + "?ok=" + encodeURIComponent("Evento creado");
        if (portadaNueva && portadaNueva.tipo === "archivo") {
          ocupado(true, "Subiendo portada…");
          try {
            await subirPortada(creado.slug, portadaNueva.archivo);
          } catch (error) {
            await alertar("El evento se creó sin portada", error.message);
          }
        }
        global.location.href = destino;
        return;
      }

      ocupado(true, "Guardando cambios…");
      try {
        await enviar(form.action, datos);
        if (portadaNueva && portadaNueva.tipo === "url") {
          await enviar(rutaEvento(slug) + "/portada", { url_imagen: portadaNueva.url });
        } else if (portadaNueva && portadaNueva.tipo === "archivo") {
          ocupado(true, "Subiendo portada…");
          await subirPortada(slug, portadaNueva.archivo);
        }
      } catch (error) {
        ocupado(false);
        mostrarAlerta(error.message);
        return;
      }
      global.location.href = rutaEvento(slug) + "?ok=" + encodeURIComponent("Evento actualizado");
    });

    /* ---- Zona de peligro ---- */
    if (eliminar) {
      eliminar.addEventListener("click", async function () {
        if (enviando || !global.IntranetDialog) return;
        var confirmado = await global.IntranetDialog.confirm({
          title: "¿Eliminar el evento?",
          message:
            "Se eliminará «" + (nombre.defaultValue || "este evento") +
            "» junto con todas sus fotos y videos. Esta acción no se puede deshacer.",
          acceptLabel: "Eliminar evento",
          tone: "peligro",
        });
        if (!confirmado) return;

        ocupado(true, "Eliminando evento…");
        eliminar.classList.add("is-enviando");
        try {
          var respuesta = await enviar(rutaEvento(slug) + "/eliminar");
          global.location.href = respuesta.redirect || "/marketing/eventos";
        } catch (error) {
          eliminar.classList.remove("is-enviando");
          ocupado(false);
          mostrarAlerta(error.message);
        }
      });
    }
  }

  /* ====================================================================== */

  function iniciar() {
    iniciarRevelado(document);
    iniciarModal();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }

  global.Galeria = { aviso: aviso, alertar: alertar, enviar: enviar, rutaEvento: rutaEvento };
})(window);
