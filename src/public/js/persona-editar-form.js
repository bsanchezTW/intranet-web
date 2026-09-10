(function (global) {
  function initPersonaEditarForm() {
    const form = document.getElementById('formEditarPersona');
    if (!form) {
      return function noop() {};
    }

    const destroyFns = [];

    const eliminarInput = document.getElementById('eliminar_foto');
    const btnRemove = document.getElementById('btn-remove-photo');
    const selectBtn = document.getElementById('btn-select-photo');

    if (typeof global.ProfilePhotoCropper !== 'undefined') {
      const photoCropper = global.ProfilePhotoCropper.init({
        fileInputId: 'foto',
        previewImgId: 'photo-preview-img',
        previewPlaceholderId: 'photo-placeholder',
        selectBtnId: 'btn-select-photo',
        overlayId: 'fotoCropOverlay',
        cropImgId: 'fotoCropImage',
        closeBtnId: 'fotoCropClose',
        cancelBtnId: 'fotoCropCancel',
        saveBtnId: 'fotoCropSave',
        errorElId: 'fotoCropError',
        maxSizeMb: 5,
        outputSize: 400,
        outputFilename: 'foto-perfil.jpg',
        saveLabel: 'Aplicar recorte',
        onCropped: function () {
          eliminarInput.value = '0';
          btnRemove.hidden = false;
          selectBtn.textContent = 'Cambiar foto';
        },
      });

      function onRemovePhoto() {
        if (!confirm('¿Quitar la foto de este colaborador?')) return;
        photoCropper.clearPhoto();
        eliminarInput.value = '1';
        btnRemove.hidden = true;
        selectBtn.textContent = 'Seleccionar foto';
      }

      btnRemove?.addEventListener('click', onRemovePhoto);
      destroyFns.push(function () {
        btnRemove?.removeEventListener('click', onRemovePhoto);
        photoCropper.clearPhoto();
      });
    }

    const emailInput = document.getElementById('email');
    const fechaInput = document.getElementById('fecha_nacimiento');
    const fechaLabel = document.getElementById('fecha_nacimiento_label');
    const telefonoField = form.querySelector('[data-phone-field]');
    const telefonoLocal = telefonoField?.querySelector('.phone-field__local');
    const FECHA_REQUERIDA_MSG = 'Fecha requerida sin correo';
    const EMAIL_LOCKED_MSG = 'El correo no se puede quitar';

    /** Sin correo no hay cuenta de intranet: el cumpleaños pasa a ser obligatorio. */
    function syncFechaRequired() {
      if (!fechaInput || !emailInput) return;
      const obligatoria = global.EmailValidate.isEmpty(emailInput);
      fechaInput.required = obligatoria;
      if (fechaLabel) {
        const marca = fechaLabel.querySelector('.required-mark');
        if (obligatoria && !marca) {
          fechaLabel.insertAdjacentHTML(
            'beforeend',
            ' <span class="required-mark">*</span>',
          );
        } else if (!obligatoria && marca) {
          marca.remove();
        }
      }
      if (!obligatoria) global.CampoForm.limpiar(fechaInput);
    }

    global.EmailValidate.initField(emailInput);
    global.PhoneField.initField(telefonoField);

    function mensajeCorreo() {
      if (emailInput?.dataset.emailLocked === '1' && global.EmailValidate.isEmpty(emailInput)) {
        return EMAIL_LOCKED_MSG;
      }
      if (!global.EmailValidate.isValid(emailInput)) return global.EmailValidate.ERROR_MSG;
      return '';
    }

    function onEmailInput() {
      global.CampoForm.marcar(emailInput, mensajeCorreo());
      syncFechaRequired();
    }

    function onTelefonoInput() {
      const invalid =
        !global.PhoneField.isFieldEmpty(telefonoField) &&
        !global.PhoneField.isFieldValid(telefonoField);
      global.CampoForm.marcar(telefonoLocal, invalid ? global.PhoneField.ERROR_MSG : '');
    }

    function onSubmit(event) {
      let hasError = false;

      const errorCorreo = mensajeCorreo();
      if (errorCorreo) {
        hasError = true;
        global.CampoForm.marcar(emailInput, errorCorreo);
      }

      if (
        !global.PhoneField.isFieldEmpty(telefonoField) &&
        !global.PhoneField.isFieldValid(telefonoField)
      ) {
        hasError = true;
        global.CampoForm.marcar(telefonoLocal, global.PhoneField.ERROR_MSG);
      }

      if (
        global.EmailValidate.isEmpty(emailInput) &&
        !String(fechaInput?.value || '').trim()
      ) {
        hasError = true;
        global.CampoForm.marcar(fechaInput, FECHA_REQUERIDA_MSG);
      }

      if (!hasError) return;
      event.preventDefault();
      global.CampoForm.enfocarPrimerError(form);
    }

    emailInput?.addEventListener('input', onEmailInput);
    telefonoLocal?.addEventListener('input', onTelefonoInput);
    form.addEventListener('submit', onSubmit);
    syncFechaRequired();

    destroyFns.push(function () {
      emailInput?.removeEventListener('input', onEmailInput);
      telefonoLocal?.removeEventListener('input', onTelefonoInput);
      form.removeEventListener('submit', onSubmit);
    });

    return function destroy() {
      destroyFns.forEach(function (fn) {
        fn();
      });
    };
  }

  global.initPersonaEditarForm = initPersonaEditarForm;
})(window);
