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

      async function onRemovePhoto() {
        const ok = await global.IntranetDialog.confirm({
          title: '¿Quitar la foto?',
          message: 'El colaborador volverá a mostrarse con sus iniciales. El cambio se aplica al guardar.',
          acceptLabel: 'Quitar foto',
          tone: 'peligro',
        });
        if (!ok) return;
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
    // Teléfono de empresa y personal; correo personal. Todos opcionales: sólo
    // se marcan si tienen algo escrito que no es válido.
    const telefonoFields = Array.from(form.querySelectorAll('[data-phone-field]'));
    const correosExtra = Array.from(form.querySelectorAll('input[type="email"]'))
      .filter(function (input) { return input !== emailInput; });
    const FECHA_REQUERIDA_MSG = 'Fecha requerida sin correo';
    const EMAIL_LOCKED_MSG = 'Deja un correo de empresa o personal';

    /** La cuenta usa el correo de empresa y, si no hay, el personal. */
    function sinCorreos() {
      return (
        global.EmailValidate.isEmpty(emailInput) &&
        correosExtra.every(function (input) { return global.EmailValidate.isEmpty(input); })
      );
    }

    /** Sin correo no hay cuenta de intranet: el cumpleaños pasa a ser obligatorio. */
    function syncFechaRequired() {
      if (!fechaInput || !emailInput) return;
      const obligatoria = sinCorreos();
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
    correosExtra.forEach(function (input) { global.EmailValidate.initField(input); });
    telefonoFields.forEach(function (field) { global.PhoneField.initField(field); });

    function mensajeCorreo() {
      if (emailInput?.dataset.emailLocked === '1' && sinCorreos()) {
        return EMAIL_LOCKED_MSG;
      }
      if (!global.EmailValidate.isValid(emailInput)) return global.EmailValidate.ERROR_MSG;
      return '';
    }

    function onEmailInput() {
      global.CampoForm.marcar(emailInput, mensajeCorreo());
      syncFechaRequired();
    }

    function telefonoInvalido(field) {
      return !global.PhoneField.isFieldEmpty(field) && !global.PhoneField.isFieldValid(field);
    }

    function onTelefonoInput(event) {
      const field = event.target.closest('[data-phone-field]');
      global.CampoForm.marcar(event.target, telefonoInvalido(field) ? global.PhoneField.ERROR_MSG : '');
    }

    function onCorreoExtraInput(event) {
      global.CampoForm.marcar(
        event.target,
        global.EmailValidate.isValid(event.target) ? '' : global.EmailValidate.ERROR_MSG,
      );
      // Escribir el personal puede resolver el aviso del de empresa y la fecha.
      global.CampoForm.marcar(emailInput, mensajeCorreo());
      syncFechaRequired();
    }

    function onSubmit(event) {
      let hasError = false;

      const errorCorreo = mensajeCorreo();
      if (errorCorreo) {
        hasError = true;
        global.CampoForm.marcar(emailInput, errorCorreo);
      }

      correosExtra.forEach(function (input) {
        if (global.EmailValidate.isValid(input)) return;
        hasError = true;
        global.CampoForm.marcar(input, global.EmailValidate.ERROR_MSG);
      });

      telefonoFields.forEach(function (field) {
        if (!telefonoInvalido(field)) return;
        hasError = true;
        global.CampoForm.marcar(field.querySelector('.phone-field__local'), global.PhoneField.ERROR_MSG);
      });

      if (sinCorreos() && !String(fechaInput?.value || '').trim()) {
        hasError = true;
        global.CampoForm.marcar(fechaInput, FECHA_REQUERIDA_MSG);
      }

      if (hasError) {
        event.preventDefault();
        global.CampoForm.enfocarPrimerError(form);
        return;
      }
      global.CampoForm.ocuparSubmit(form);
    }

    emailInput?.addEventListener('input', onEmailInput);
    correosExtra.forEach(function (input) { input.addEventListener('input', onCorreoExtraInput); });
    telefonoFields.forEach(function (field) {
      field.querySelector('.phone-field__local')?.addEventListener('input', onTelefonoInput);
    });
    form.addEventListener('submit', onSubmit);
    syncFechaRequired();

    destroyFns.push(function () {
      emailInput?.removeEventListener('input', onEmailInput);
      correosExtra.forEach(function (input) { input.removeEventListener('input', onCorreoExtraInput); });
      telefonoFields.forEach(function (field) {
        field.querySelector('.phone-field__local')?.removeEventListener('input', onTelefonoInput);
      });
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
