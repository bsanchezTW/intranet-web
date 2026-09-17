/* ==========================================================================
   Noticias — editor (crear y editar)
   Los archivos se quedan en el navegador y se suben recién al guardar, como
   en tickets: en el bucket quedan <N° de noticia>_1, _2… (la portada,
   `_portada`). Mientras tanto se muestra una vista previa local.
   ========================================================================== */
(function () {
  "use strict";

  var MAX_LADO_IMAGEN = 2000; // px: por encima de esto el correo pesa de más
  var CALIDAD_JPEG = 0.85;

  var ICONOS = { image: "IMG", pdf: "PDF", word: "DOC", video: "VID", file: "FILE" };
  var MAX_MB_POR_TIPO = { image: 20, pdf: 40, word: 25, video: 200, file: 25 };

  var estado = {
    modo: "crear",
    adjuntos: [],
    preparando: 0,
    cropper: null,
  };

  var el = {};

  function $(id) { return document.getElementById(id); }

  function maxFiles() {
    return Number(el.form && el.form.dataset.maxFiles) || 20;
  }

  function kindOf(name, mime) {
    var ext = String(name || "").split(".").pop().toLowerCase();
    var tipo = String(mime || "").toLowerCase();
    if (/^(jpe?g|png|gif|webp|bmp|avif)$/.test(ext) || tipo.indexOf("image/") === 0) return "image";
    if (ext === "pdf" || tipo === "application/pdf") return "pdf";
    if (ext === "doc" || ext === "docx") return "word";
    if (/^(mp4|webm|mov|avi|mkv|m4v)$/.test(ext) || tipo.indexOf("video/") === 0) return "video";
    return "file";
  }

  function maxBytesFor(kind) {
    return (MAX_MB_POR_TIPO[kind] || MAX_MB_POR_TIPO.file) * 1024 * 1024;
  }

  function cachearElementos() {
    el.modal = $("modalCrearNoticia");
    el.form = $("formNoticia");
    el.titulo = $("noticia_titulo");
    el.subtitulo = $("noticia_subtitulo");
    el.encabezado = $("editorTitulo");
    el.descripcion = $("editorDesc");
    el.filePortada = $("filePortada");
    el.urlPortada = $("url_portada");
    el.portadaWrap = $("cover-preview-wrap");
    el.portadaImg = $("cover-preview-img");
    el.btnQuitarPortada = $("btn-quitar-portada");
    el.btnSelectCover = $("btn-select-cover");
    el.zona = $("zonaSoltar");
    el.fileGaleria = $("fileGaleria");
    el.hiddenAdjuntos = $("adjuntos_data");
    el.lista = $("listaAdjuntos");
    el.vacio = $("adjuntosVacio");
    el.estado = $("editorEstado");
    el.guardar = $("btnGuardarNoticia");
  }

  function escapar(texto) {
    return String(texto == null ? "" : texto).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function mostrarEstado(mensaje, esError) {
    if (!el.estado) return;
    el.estado.textContent = mensaje || "";
    el.estado.classList.toggle("is-error", Boolean(esError));
  }

  /* ======================================================================
     Reducción de imágenes en el cliente
     Una foto de móvil son 6-10 MB; a 2000 px se ve igual, sube en un
     instante y no infla el correo.
     ====================================================================== */
  function reducirImagen(file) {
    return new Promise(function (resolver) {
      if (!/^image\/(jpeg|jpg|png|webp)$/i.test(file.type)) return resolver(file);

      var url = URL.createObjectURL(file);
      var img = new Image();

      img.onload = function () {
        var escala = Math.min(1, MAX_LADO_IMAGEN / Math.max(img.width, img.height));
        // Ya es pequeña y no pesa: no tiene sentido recomprimir y perder calidad.
        if (escala === 1 && file.size < 1.5 * 1024 * 1024) {
          URL.revokeObjectURL(url);
          return resolver(file);
        }

        var canvas = document.createElement("canvas");
        canvas.width = Math.round(img.width * escala);
        canvas.height = Math.round(img.height * escala);

        var ctx = canvas.getContext("2d");
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(url);

        canvas.toBlob(
          function (blob) {
            if (!blob || blob.size >= file.size) return resolver(file);
            var nombre = file.name.replace(/\.(png|webp)$/i, ".jpg");
            resolver(new File([blob], nombre, { type: "image/jpeg" }));
          },
          "image/jpeg",
          CALIDAD_JPEG,
        );
      };

      img.onerror = function () {
        URL.revokeObjectURL(url);
        resolver(file);
      };

      img.src = url;
    });
  }

  /* ======================================================================
     Archivos locales: se cachean aquí y viajan con el formulario al guardar.
     ====================================================================== */
  function esBlob(url) {
    return String(url || "").indexOf("blob:") === 0;
  }

  function soltarVistaPrevia(adjunto) {
    if (adjunto && esBlob(adjunto.previewUrl)) {
      URL.revokeObjectURL(adjunto.previewUrl);
      adjunto.previewUrl = "";
    }
  }

  function contarValidos() {
    return estado.adjuntos.filter(function (a) { return !a.error; }).length;
  }

  async function agregarArchivos(archivos) {
    var lista = Array.prototype.slice.call(archivos);
    if (!lista.length) return;

    if (contarValidos() + lista.length > maxFiles()) {
      mostrarEstado("Puedes adjuntar hasta " + maxFiles() + " archivos.", true);
      return;
    }

    for (var i = 0; i < lista.length; i += 1) {
      var original = lista[i];
      var kind = kindOf(original.name, original.type);
      var local = {
        id: "local_" + Date.now() + "_" + i,
        local: true,
        pendiente: true,
        name: original.name,
        kind: kind,
        file: original,
      };
      estado.adjuntos.push(local);
      renderizar();

      estado.preparando += 1;
      mostrarEstado("Preparando " + original.name + "…");
      actualizarBotonGuardar();

      try {
        if (original.size > maxBytesFor(kind)) {
          throw new Error("«" + original.name + "» supera el máximo de " + MAX_MB_POR_TIPO[kind] + " MB.");
        }
        var preparado = await reducirImagen(original);
        local.file = preparado;
        local.name = preparado.name || original.name;
        local.kind = kindOf(local.name, preparado.type || original.type);
        local.pendiente = false;
        if (local.kind === "image" || local.kind === "video") {
          local.previewUrl = URL.createObjectURL(preparado);
        }
      } catch (error) {
        local.pendiente = false;
        local.file = null;
        local.error = error.message;
        console.warn("[Noticias] No se pudo preparar el archivo:", error);
      } finally {
        estado.preparando -= 1;
        renderizar();
        actualizarBotonGuardar();
      }
    }

    mostrarEstado(estado.preparando > 0 ? "Preparando archivos…" : "");
  }

  /* ======================================================================
     Pintado de la lista de adjuntos
     ====================================================================== */
  function miniatura(adjunto) {
    var etiqueta = "<span>" + (ICONOS[adjunto.kind] || ICONOS.file) + "</span>";
    if (!adjunto.previewUrl) return etiqueta;

    // La etiqueta queda debajo: si la miniatura no carga (adjuntos heredados
    // que ya no existen) se ve el tipo de archivo y no un icono roto.
    return (
      etiqueta +
      '<img src="' + escapar(adjunto.previewUrl) + '" alt="" onerror="this.remove()">'
    );
  }

  function descripcion(adjunto) {
    if (adjunto.error) return '<span class="adj__meta--error">' + escapar(adjunto.error) + "</span>";
    if (adjunto.pendiente) return "Preparando…";
    if (adjunto.local) return "Se subirá al guardar";

    var partes = [];
    if (adjunto.kind === "pdf") {
      partes.push(adjunto.pages ? adjunto.pages + " páginas" : "PDF");
      if (adjunto.previewUrl) partes.push("portada lista");
    } else if (adjunto.kind === "word") {
      partes.push(adjunto.html_path ? "texto listo para mostrar" : "Word");
    } else if (adjunto.kind === "image" && adjunto.width) {
      partes.push(adjunto.width + " × " + adjunto.height);
    } else {
      partes.push(adjunto.label || adjunto.kind);
    }
    if (adjunto.sizeLabel) partes.push(adjunto.sizeLabel);
    return escapar(partes.join(" · "));
  }

  function renderizar() {
    if (!el.lista) return;

    el.lista.innerHTML = estado.adjuntos
      .map(function (adjunto, indice) {
        var clases = "adj";
        if (adjunto.pendiente) clases += " is-subiendo";
        if (adjunto.error) clases += " is-error";

        return (
          '<li class="' + clases + '">' +
          '<div class="adj__thumb">' + miniatura(adjunto) + "</div>" +
          '<div class="adj__datos">' +
          '<span class="adj__nombre">' + escapar(adjunto.name) + "</span>" +
          '<span class="adj__meta">' + descripcion(adjunto) + "</span>" +
          "</div>" +
          '<div class="adj__acciones">' +
          '<button type="button" class="adj__btn" data-mover="-1" data-indice="' + indice +
          '" aria-label="Subir" ' + (indice === 0 ? "disabled" : "") + ">&uarr;</button>" +
          '<button type="button" class="adj__btn" data-mover="1" data-indice="' + indice +
          '" aria-label="Bajar" ' + (indice === estado.adjuntos.length - 1 ? "disabled" : "") + ">&darr;</button>" +
          '<button type="button" class="adj__btn adj__btn--quitar" data-quitar="' + indice +
          '" aria-label="Quitar">&times;</button>' +
          "</div>" +
          "</li>"
        );
      })
      .join("");

    if (el.vacio) el.vacio.hidden = estado.adjuntos.length > 0;
    sincronizarCampoOculto();
  }

  function sincronizarCampoOculto() {
    if (!el.hiddenAdjuntos) return;
    // Los provisionales y los fallidos no se guardan. Los locales viajan
    // como archivos del formulario; aquí solo queda el plan de orden.
    var plan = estado.adjuntos
      .filter(function (a) { return !a.pendiente && !a.error; })
      .map(function (a) {
        if (a.local || a.file) return { nuevo: true, name: a.name };
        return { public_id: a.public_id, url: a.url };
      });
    el.hiddenAdjuntos.value = JSON.stringify(plan);
  }

  function actualizarBotonGuardar() {
    if (!el.guardar) return;
    el.guardar.disabled = estado.preparando > 0;
  }

  function iniciarDelegacionLista() {
    if (!el.lista) return;

    el.lista.addEventListener("click", function (evento) {
      var quitar = evento.target.closest("[data-quitar]");
      if (quitar) {
        var quitado = estado.adjuntos.splice(parseInt(quitar.getAttribute("data-quitar"), 10), 1)[0];
        soltarVistaPrevia(quitado);
        renderizar();
        return;
      }

      var mover = evento.target.closest("[data-mover]");
      if (mover) {
        var indice = parseInt(mover.getAttribute("data-indice"), 10);
        var destino = indice + parseInt(mover.getAttribute("data-mover"), 10);
        if (destino < 0 || destino >= estado.adjuntos.length) return;
        var item = estado.adjuntos.splice(indice, 1)[0];
        estado.adjuntos.splice(destino, 0, item);
        renderizar();
      }
    });
  }

  /* ======================================================================
     Arrastrar y soltar
     ====================================================================== */
  function iniciarZona() {
    if (!el.zona || !el.fileGaleria) return;

    el.zona.addEventListener("click", function () { el.fileGaleria.click(); });
    el.zona.addEventListener("keydown", function (evento) {
      if (evento.key === "Enter" || evento.key === " ") {
        evento.preventDefault();
        el.fileGaleria.click();
      }
    });

    el.fileGaleria.addEventListener("change", function () {
      agregarArchivos(el.fileGaleria.files);
      el.fileGaleria.value = "";
    });

    ["dragenter", "dragover"].forEach(function (nombre) {
      el.zona.addEventListener(nombre, function (evento) {
        evento.preventDefault();
        el.zona.classList.add("is-encima");
      });
    });

    ["dragleave", "drop"].forEach(function (nombre) {
      el.zona.addEventListener(nombre, function (evento) {
        evento.preventDefault();
        el.zona.classList.remove("is-encima");
      });
    });

    el.zona.addEventListener("drop", function (evento) {
      if (evento.dataTransfer && evento.dataTransfer.files.length) {
        agregarArchivos(evento.dataTransfer.files);
      }
    });
  }

  /* ======================================================================
     Portada
     ====================================================================== */
  function pintarPortada(url) {
    if (!el.portadaWrap) return;
    if (url) {
      el.portadaImg.hidden = false;
      el.portadaImg.src = url;
      el.portadaWrap.hidden = false;
      if (el.btnSelectCover) el.btnSelectCover.textContent = "Cambiar portada";
    } else {
      el.portadaWrap.hidden = true;
      el.portadaImg.hidden = true;
      el.portadaImg.removeAttribute("src");
      if (el.btnSelectCover) el.btnSelectCover.textContent = "Seleccionar portada";
    }
  }

  function quitarPortada() {
    if (el.urlPortada) el.urlPortada.value = "";
    if (el.filePortada) el.filePortada.value = "";
    if (estado.cropper && estado.cropper.clearPhoto) estado.cropper.clearPhoto();
    pintarPortada(null);
  }

  function iniciarCropper() {
    if (!window.ProfilePhotoCropper) return;

    estado.cropper = window.ProfilePhotoCropper.init({
      fileInputId: "filePortada",
      previewImgId: "cover-preview-img",
      previewPlaceholderId: null,
      selectBtnId: "btn-select-cover",
      overlayId: "coverCropOverlay",
      cropImgId: "coverCropImage",
      closeBtnId: "coverCropClose",
      cancelBtnId: "coverCropCancel",
      saveBtnId: "coverCropSave",
      errorElId: "coverCropError",
      aspectRatio: 16 / 9,
      outputWidth: 1280,
      outputHeight: 720,
      maxSizeMb: 8,
      outputFilename: "portada-noticia.jpg",
      selectLabel: "Seleccionar portada",
      changeLabel: "Cambiar portada",
      onCropped: function () {
        if (el.portadaWrap) el.portadaWrap.hidden = false;
        // El recortador deja el JPEG en el input `portada`; se sube al guardar.
        mostrarEstado("");
      },
    });

    if (el.btnQuitarPortada) el.btnQuitarPortada.addEventListener("click", quitarPortada);
  }

  /* ======================================================================
     TinyMCE
     ====================================================================== */
  function iniciarTinyMCE(despues) {
    if (typeof window.tinymce === "undefined") {
      if (despues) despues();
      return;
    }
    if (window.tinymce.get("noticia_contenido")) {
      if (despues) despues();
      return;
    }

    window.tinymce.init({
      selector: "#noticia_contenido",
      plugins: "lists link table autolink",
      toolbar:
        "undo redo | blocks | bold italic underline | bullist numlist | blockquote link table | removeformat",
      block_formats: "Párrafo=p; Subtítulo=h2; Subtítulo menor=h3",
      promotion: false,
      branding: false,
      menubar: false,
      statusbar: false,
      // El CSS estira .tox-tinymce dentro de su columna; esto es solo el mínimo
      // para que no arranque colapsado antes de que el flex tome el control.
      height: Math.max(360, Math.round(window.innerHeight * 0.55)),
      resize: false,
      content_style:
        "body{font-family:'Instrument Sans',Segoe UI,system-ui,sans-serif;font-size:16px;line-height:1.7;color:#0d1f33}" +
        "h2,h3{color:#0b3a63;font-weight:800;line-height:1.3}",
      init_instance_callback: function () {
        if (despues) despues();
      },
    });
  }

  function fijarContenido(html) {
    var editor = window.tinymce && window.tinymce.get("noticia_contenido");
    if (editor) {
      editor.setContent(html || "");
    } else {
      var area = $("noticia_contenido");
      if (area) area.value = html || "";
    }
  }

  /* ======================================================================
     Apertura del modal
     ====================================================================== */
  function reiniciar() {
    estado.adjuntos.forEach(soltarVistaPrevia);
    estado.adjuntos = [];
    estado.preparando = 0;
    if (el.form) el.form.reset();
    quitarPortada();
    mostrarEstado("");
    renderizar();
    actualizarBotonGuardar();
  }

  function abrir(despues) {
    if (window.IntranetModal) window.IntranetModal.open("modalCrearNoticia");
    // TinyMCE necesita que el contenedor ya esté visible para medirse.
    setTimeout(function () { iniciarTinyMCE(despues); }, 260);
  }

  window.abrirModalCrearNoticia = function () {
    if (!asegurarIniciado()) return;
    estado.modo = "crear";
    reiniciar();
    el.form.action = "/noticias/crear";
    el.encabezado.textContent = "Publicar noticia";
    el.descripcion.textContent =
      "Las imágenes, PDF y documentos se mostrarán dentro de la noticia y del correo.";
    el.guardar.textContent = "Publicar";
    abrir(function () { fijarContenido(""); });
  };

  window.abrirModalEditarNoticia = function (noticia) {
    if (!noticia || !asegurarIniciado()) return;

    estado.modo = "editar";
    reiniciar();

    el.form.action = "/noticias/editar/" + noticia.id;
    el.encabezado.textContent = "Editar noticia";
    el.descripcion.textContent = "Los cambios se publican al guardar.";
    el.guardar.textContent = "Guardar cambios";

    el.titulo.value = noticia.title || "";
    el.subtitulo.value = noticia.subtitle || "";

    if (noticia.image) {
      el.urlPortada.value = noticia.image;
      pintarPortada(noticia.image);
    }

    try {
      var adjuntos =
        typeof noticia.attachments === "string"
          ? JSON.parse(noticia.attachments)
          : noticia.attachments;
      estado.adjuntos = Array.isArray(adjuntos) ? adjuntos : [];
    } catch (error) {
      console.warn("[Noticias] Adjuntos ilegibles:", error);
      estado.adjuntos = [];
    }

    renderizar();
    abrir(function () { fijarContenido(noticia.content || ""); });
  };

  window.cerrarModalNoticia = function () {
    if (window.IntranetModal) window.IntranetModal.close("modalCrearNoticia");
  };
  window.cerrarModalCrearNoticia = window.cerrarModalNoticia;

  /* ====================================================================== */
  function iniciarEnvio() {
    if (!el.form) return;

    el.form.addEventListener("submit", function (evento) {
      if (window.tinymce && window.tinymce.get("noticia_contenido")) {
        window.tinymce.triggerSave();
      }

      if (estado.preparando > 0) {
        evento.preventDefault();
        mostrarEstado("Espera a que terminen de prepararse los archivos.", true);
        return;
      }

      var contenido = $("noticia_contenido");
      if (!contenido || !contenido.value.replace(/<[^>]*>/g, "").trim()) {
        evento.preventDefault();
        mostrarEstado("El contenido no puede quedar vacío.", true);
        return;
      }

      var fallidos = estado.adjuntos.filter(function (a) { return a.error; });
      if (fallidos.length) {
        evento.preventDefault();
        mostrarEstado("Quita los archivos con error antes de guardar.", true);
        return;
      }

      // Los File cacheados viajan con el POST; el servidor los nombra
      // <N° de noticia>_1, _2… cuando la noticia ya existe.
      if (el.fileGaleria && typeof DataTransfer === "function") {
        var transferencia = new DataTransfer();
        estado.adjuntos.forEach(function (adjunto) {
          if (adjunto.file) transferencia.items.add(adjunto.file);
        });
        el.fileGaleria.files = transferencia.files;
      }

      sincronizarCampoOculto();
      mostrarEstado(
        estado.modo === "editar"
          ? "Guardando y subiendo archivos…"
          : "Publicando y subiendo archivos…",
      );
    });
  }

  var iniciado = false;

  function iniciar() {
    if (iniciado) return true;

    cachearElementos();
    if (!el.modal) return false;

    iniciado = true;
    iniciarZona();
    iniciarDelegacionLista();
    iniciarCropper();
    iniciarEnvio();
    renderizar();
    return true;
  }

  /**
   * El detalle puede pedir abrir el editor (?editar=1) desde un script con
   * defer, que corre ANTES del DOMContentLoaded en el que este módulo se
   * inicializa. Sin esta garantía, el modal se abría con los elementos aún
   * sin cachear y fallaba.
   */
  function asegurarIniciado() {
    return iniciar();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", iniciar);
  } else {
    iniciar();
  }
})();
