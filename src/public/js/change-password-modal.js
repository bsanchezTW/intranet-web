(function (global) {
  const EYE_OPEN =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>';
  const EYE_CLOSED =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>';

  function initChangePasswordModal(config) {
    const overlay = document.getElementById(config.overlayId);
    const openBtn = document.getElementById(config.openBtnId);
    const form = document.getElementById(config.formId);
    const errorEl = document.getElementById(config.errorElId);
    const closeBtn = document.getElementById(config.closeBtnId);
    const cancelBtn = document.getElementById(config.cancelBtnId);
    const submitBtn = document.getElementById(config.submitBtnId);

    if (!overlay || !form) return;

    function showError(message) {
      if (!errorEl) return;
      errorEl.textContent = message;
      errorEl.hidden = false;
    }

    function clearError() {
      if (!errorEl) return;
      errorEl.textContent = '';
      errorEl.hidden = true;
    }

    function resetPasswordFields() {
      form.querySelectorAll('input[type="text"], input[type="password"]').forEach(function (input) {
        input.type = 'password';
      });
      overlay.querySelectorAll('[data-toggle-password]').forEach(function (btn) {
        btn.innerHTML = EYE_OPEN;
      });
    }

    const newPasswordInput = document.getElementById('new_password');
    const confirmPasswordInput = document.getElementById('confirm_password');
    const strengthBox = document.getElementById('changePasswordStrength');
    const strength = global.PasswordStrength;

    function updateStrength() {
      if (strength && newPasswordInput) {
        strength.renderMeter(strengthBox, newPasswordInput.value);
      }
    }

    newPasswordInput?.addEventListener('input', updateStrength);

    function resetForm() {
      form.reset();
      clearError();
      resetPasswordFields();
      updateStrength();
    }

    function clearQueryParams() {
      const url = new URL(window.location.href);
      url.searchParams.delete('openPasswordModal');
      url.searchParams.delete('password_error');
      window.history.replaceState({}, document.title, url.pathname + url.search);
    }

    function openModal() {
      resetForm();
      if (config.initialError) {
        showError(config.initialError);
        config.initialError = null;
      }
      global.IntranetModal.open(overlay);
      window.setTimeout(function () {
        document.getElementById('old_password')?.focus();
      }, 320);
    }

    function closeModal() {
      global.IntranetModal.close(overlay);
      resetForm();
      clearQueryParams();
    }

    openBtn?.addEventListener('click', openModal);
    closeBtn?.addEventListener('click', closeModal);
    cancelBtn?.addEventListener('click', closeModal);

    // El fondo cierra sólo si el gesto entero ocurrió sobre el fondo: soltar
    // fuera un arrastre iniciado dentro reporta el `click` sobre el overlay.
    overlay.addEventListener('click', function (e) {
      if (e.target !== overlay) return;
      if (!global.IntranetModal.gestoCompletoSobre(overlay)) return;
      closeModal();
    });

    overlay.querySelectorAll('[data-toggle-password]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        const inputId = btn.getAttribute('data-toggle-password');
        const input = document.getElementById(inputId);
        if (!input) return;
        if (input.type === 'password') {
          input.type = 'text';
          btn.innerHTML = EYE_CLOSED;
        } else {
          input.type = 'password';
          btn.innerHTML = EYE_OPEN;
        }
      });
    });

    form.addEventListener('submit', function (e) {
      e.preventDefault();
      clearError();

      // Misma política que el registro; el servidor la vuelve a validar.
      const newPassword = newPasswordInput ? newPasswordInput.value : '';
      if (strength && !strength.isPasswordStrongEnough(newPassword)) {
        showError(strength.POLICY_HINT);
        newPasswordInput?.focus();
        return;
      }
      if (confirmPasswordInput && newPassword !== confirmPasswordInput.value) {
        showError('Las nuevas contraseñas no coinciden.');
        confirmPasswordInput.focus();
        return;
      }

      if (global.IntranetModal) global.IntranetModal.ocuparBoton(submitBtn, true);

      const formData = new FormData(form);

      fetch('/change-password', {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'X-Requested-With': 'fetch',
        },
        body: formData,
        credentials: 'same-origin',
      })
        .then(function (res) {
          return res.json().then(function (data) {
            return { ok: res.ok, data: data };
          });
        })
        .then(function (result) {
          if (result.data.ok && result.data.redirect) {
            window.location.href = result.data.redirect;
            return;
          }
          showError(result.data.error || 'No se pudo actualizar la contraseña.');
        })
        .catch(function () {
          showError('Error de conexión. Intenta de nuevo.');
        })
        .finally(function () {
          if (global.IntranetModal) global.IntranetModal.ocuparBoton(submitBtn, false);
        });
    });

    if (config.openOnLoad) openModal();
  }

  global.ChangePasswordModal = { init: initChangePasswordModal };
})(window);
