(function (global) {
  function initProfilePhotoCropper(config) {
    const fileInput = document.getElementById(config.fileInputId);
    const previewImg = document.getElementById(config.previewImgId);
    const previewPlaceholder = document.getElementById(config.previewPlaceholderId);
    const selectBtn = document.getElementById(config.selectBtnId);
    const changeBtn = config.changeBtnId
      ? document.getElementById(config.changeBtnId)
      : null;
    const overlay = document.getElementById(config.overlayId);
    const cropImg = document.getElementById(config.cropImgId);
    const btnClose = document.getElementById(config.closeBtnId);
    const btnCancel = document.getElementById(config.cancelBtnId);
    const btnSave = document.getElementById(config.saveBtnId);
    const errorEl = document.getElementById(config.errorElId);

    const maxSizeMb = config.maxSizeMb || 8;
    const outputSize = config.outputSize || 300;
    const outputWidth = config.outputWidth || outputSize;
    const outputHeight = config.outputHeight || outputSize;
    const aspectRatio = config.aspectRatio || 1;
    const selectLabel = config.selectLabel || "Seleccionar foto";
    const changeLabel = config.changeLabel || "Cambiar foto";
    const outputFilename = config.outputFilename || "foto-perfil.jpg";

    let cropper = null;
    let objectUrl = null;
    let previewObjectUrl = null;
    let croppedBlob = null;

    function showError(msg) {
      errorEl.textContent = msg;
      errorEl.classList.add("is-visible");
    }

    function clearError() {
      errorEl.textContent = "";
      errorEl.classList.remove("is-visible");
    }

    function destroyCropper() {
      if (cropper) {
        cropper.destroy();
        cropper = null;
      }
      if (objectUrl) {
        URL.revokeObjectURL(objectUrl);
        objectUrl = null;
      }
      cropImg.removeAttribute("src");
    }

    function closeModal(resetInput) {
      overlay.classList.remove("is-open");
      overlay.setAttribute("hidden", "");
      if (global.IntranetModal?.unlockScroll) {
        global.IntranetModal.unlockScroll();
      } else {
        document.body.style.overflow = "";
      }
      destroyCropper();
      if (resetInput) fileInput.value = "";
      btnSave.disabled = false;
      btnSave.textContent = config.saveLabel || "Aplicar recorte";
      clearError();
    }

    function setPreviewFromBlob(blob) {
      if (previewObjectUrl) URL.revokeObjectURL(previewObjectUrl);
      previewObjectUrl = URL.createObjectURL(blob);
      if (previewImg) {
        previewImg.src = previewObjectUrl;
        previewImg.hidden = false;
      }
      if (previewPlaceholder) previewPlaceholder.hidden = true;
      if (changeBtn) changeBtn.hidden = false;
      if (selectBtn) selectBtn.textContent = changeLabel;
    }

    function syncFileInputFromBlob(blob) {
      if (!fileInput || !blob) return;
      const file = new File([blob], outputFilename, { type: "image/jpeg" });
      const dt = new DataTransfer();
      dt.items.add(file);
      fileInput.files = dt.files;
    }

    function clearStoredPhoto() {
      croppedBlob = null;
      if (fileInput) fileInput.value = "";
      if (previewImg) {
        previewImg.hidden = true;
        previewImg.removeAttribute("src");
      }
      if (previewPlaceholder) previewPlaceholder.hidden = false;
      if (changeBtn) changeBtn.hidden = true;
      if (selectBtn) selectBtn.textContent = selectLabel;
      if (previewObjectUrl) {
        URL.revokeObjectURL(previewObjectUrl);
        previewObjectUrl = null;
      }
    }

    function applyCroppedBlob(blob) {
      croppedBlob = blob;
      syncFileInputFromBlob(blob);
      setPreviewFromBlob(blob);
      if (typeof config.onCropped === "function") {
        config.onCropped(new File([blob], outputFilename, { type: "image/jpeg" }), blob);
      }
    }

    function openModal(file) {
      clearError();
      destroyCropper();
      objectUrl = URL.createObjectURL(file);
      cropImg.src = objectUrl;
      overlay.classList.add("is-open");
      overlay.removeAttribute("hidden");
      if (global.IntranetModal?.lockScroll) {
        global.IntranetModal.lockScroll();
      } else {
        document.body.style.overflow = "hidden";
      }

      function initCropperInstance() {
        if (typeof global.Cropper === "undefined") {
          showError(
            "No se pudo cargar el editor de imagen. Recarga la página e intenta de nuevo.",
          );
          return;
        }
        cropper = new global.Cropper(cropImg, {
          aspectRatio: aspectRatio,
          viewMode: 1,
          dragMode: "move",
          autoCropArea: 0.85,
          responsive: true,
          restore: false,
          guides: true,
          center: true,
          highlight: true,
          background: false,
          cropBoxMovable: true,
          cropBoxResizable: true,
          toggleDragModeOnDblclick: false,
          ready: function () {
            // Asegura que el canvas respete el contenedor de altura fija
            this.resize();
          },
        });
      }

      cropImg.onload = function () {
        cropImg.onload = null;
        initCropperInstance();
      };
      if (cropImg.complete) {
        cropImg.onload = null;
        initCropperInstance();
      }
    }

    function avisar(titulo, mensaje) {
      if (window.IntranetDialog) window.IntranetDialog.alert({ title: titulo, message: mensaje });
      else window.alert(mensaje);
    }

    function handleFileSelected(file) {
      if (!file) return;
      if (!file.type.startsWith("image/")) {
        avisar("Archivo no válido", "Selecciona un archivo de imagen válido (JPG, PNG, WebP o GIF).");
        fileInput.value = "";
        return;
      }
      if (file.size > maxSizeMb * 1024 * 1024) {
        avisar("Imagen demasiado pesada", "La imagen no puede superar " + maxSizeMb + " MB.");
        fileInput.value = "";
        return;
      }
      openModal(file);
    }

    function triggerFileSelect() {
      fileInput.click();
    }

    fileInput.addEventListener("change", function () {
      handleFileSelected(fileInput.files && fileInput.files[0]);
    });

    selectBtn.addEventListener("click", triggerFileSelect);
    if (changeBtn) changeBtn.addEventListener("click", triggerFileSelect);

    function onCancel() {
      closeModal(true);
    }

    btnClose.addEventListener("click", onCancel);
    btnCancel.addEventListener("click", onCancel);
    // Cerrar al pulsar el fondo exige que el gesto entero ocurra sobre el
    // fondo. Recortar es arrastrar: al soltar el ratón fuera del modal el
    // `click` se reporta sobre el overlay —es el ancestro común del punto
    // donde se apretó y donde se soltó— y el recorte se cancelaba solo.
    // Los oyentes de pointer van en captura para ver el gesto aunque
    // Cropper.js detenga la propagación del suyo.
    let apretadoEn = null;
    let soltadoEn = null;
    overlay.addEventListener(
      "pointerdown",
      function (e) {
        apretadoEn = e.target;
      },
      true,
    );
    overlay.addEventListener(
      "pointerup",
      function (e) {
        soltadoEn = e.target;
      },
      true,
    );
    overlay.addEventListener("click", function (e) {
      const gestoEnElFondo = apretadoEn === overlay && soltadoEn === overlay;
      apretadoEn = null;
      soltadoEn = null;
      if (e.target === overlay && gestoEnElFondo) onCancel();
    });
    // El recorte se abre por encima de otros modales (editar persona, por
    // ejemplo). En captura y cortando la propagación, Escape cierra sólo el
    // recorte: antes el mismo Escape llegaba a modal.js y cerraba también el
    // formulario de abajo, perdiendo lo escrito.
    document.addEventListener(
      "keydown",
      function (e) {
        if (e.key !== "Escape" || !overlay.classList.contains("is-open")) return;
        e.stopPropagation();
        onCancel();
      },
      true,
    );

    btnSave.addEventListener("click", function () {
      if (!cropper) return;
      clearError();
      btnSave.disabled = true;
      btnSave.textContent = "Procesando…";

      const canvas = cropper.getCroppedCanvas({
        width: outputWidth,
        height: outputHeight,
        imageSmoothingEnabled: true,
        imageSmoothingQuality: "high",
      });

      if (!canvas) {
        showError("No se pudo procesar la imagen.");
        btnSave.disabled = false;
        btnSave.textContent = config.saveLabel || "Aplicar recorte";
        return;
      }

      canvas.toBlob(
        function (blob) {
          if (!blob) {
            showError("Error al generar la imagen.");
            btnSave.disabled = false;
            btnSave.textContent = config.saveLabel || "Aplicar recorte";
            return;
          }

          if (typeof config.onSave === "function") {
            config.onSave(blob, {
              closeModal: function () {
                closeModal(false);
              },
              showError: showError,
              resetSaveButton: function () {
                btnSave.disabled = false;
                btnSave.textContent = config.saveLabel || "Aplicar recorte";
              },
            });
            return;
          }

          applyCroppedBlob(blob);
          closeModal(false);
        },
        "image/jpeg",
        0.92,
      );
    });

    window.addEventListener("pagehide", function () {
      if (config.clearOnLeave) clearStoredPhoto();
    });

    return {
      hasPhoto: function () {
        return Boolean(
          croppedBlob ||
            (fileInput && fileInput.files && fileInput.files.length > 0),
        );
      },
      getBlob: function () {
        return croppedBlob;
      },
      clearPhoto: clearStoredPhoto,
    };
  }

  global.ProfilePhotoCropper = { init: initProfilePhotoCropper };
})(window);
