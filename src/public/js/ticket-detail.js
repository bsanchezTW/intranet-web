/**
 * Detalle de ticket (modal y página completa).
 *
 * Guardar un ticket obliga a resolver quién se hace cargo: los botones del pie
 * abren un paso de asignación y sólo desde ahí se envía el formulario. Así no
 * queda un ticket gestionado y "sin asignar", que era el agujero del botón
 * "Tomar Ticket" suelto.
 */
(function () {
  const MAX_CHARS = 2000;

  function bindCharCounter(root, textareaId, counterId) {
    const textarea = root.querySelector(`#${textareaId}`);
    const counter = root.querySelector(`#${counterId}`);
    if (!textarea || !counter || textarea.dataset.counterBound === 'true') return;
    textarea.dataset.counterBound = 'true';

    const refresh = () => {
      const currentLength = textarea.value.length;
      counter.textContent = `${currentLength} / ${MAX_CHARS} caracteres`;
      counter.classList.toggle('limit-reached', currentLength >= MAX_CHARS);
    };

    textarea.addEventListener('input', refresh);
    refresh();
  }

  function setUploadStatus(statusEl, text, statusClass) {
    if (!statusEl) return;
    statusEl.className = statusClass ? `ticket-upload-status ${statusClass}` : 'ticket-upload-status';
    statusEl.textContent = text;
  }

  /** Muestra cuántos archivos se adjuntarán antes de enviar. */
  function bindFilePreview(root, inputFilesId, statusId) {
    const inputFiles = root.querySelector(`#${inputFilesId}`);
    const statusEl = root.querySelector(`#${statusId}`);
    if (!inputFiles || inputFiles.dataset.previewBound === 'true') return;
    inputFiles.dataset.previewBound = 'true';

    inputFiles.addEventListener('change', () => {
      const total = (inputFiles.files || []).length;
      if (total === 0) return setUploadStatus(statusEl, '');
      setUploadStatus(statusEl, total === 1 ? '1 archivo listo' : `${total} archivos listos`, 'ticket-status-text');
    });
  }

  function setupLocalUpload(root, formId, inputFilesId, hiddenDataId, statusId, btnSubmitId) {
    const form = root.querySelector(`#${formId}`);
    const inputFiles = root.querySelector(`#${inputFilesId}`);
    const hiddenInput = root.querySelector(`#${hiddenDataId}`);
    const statusEl = root.querySelector(`#${statusId}`);
    const btnSubmit = root.querySelector(`#${btnSubmitId}`);
    if (!form || !inputFiles || form.dataset.uploadBound === 'true') return;
    form.dataset.uploadBound = 'true';

    form.addEventListener('submit', async (e) => {
      const files = Array.from(inputFiles.files || []);
      if (files.length === 0) return;

      e.preventDefault();
      if (btnSubmit && window.IntranetModal) window.IntranetModal.ocuparBoton(btnSubmit, true);
      setUploadStatus(statusEl, `Preparando subida (${files.length} archivo/s)...`, 'ticket-status-text');

      try {
        const uploadedList = [];
        for (let i = 0; i < files.length; i += 1) {
          const file = files[i];
          setUploadStatus(statusEl, `Subiendo archivo ${i + 1} de ${files.length}: ${file.name}...`, 'ticket-status-text');

          const ticketId = form.getAttribute('data-ticket-id') || '';
          const formData = new FormData();
          formData.append('file', file);
          formData.append('ticket_id', ticketId);
          formData.append('index', String(i + 1));

          let dbType = 'doc';
          if (file.type.startsWith('video/')) dbType = 'video';
          else if (file.type.startsWith('image/')) dbType = 'image';
          else if (file.type === 'application/pdf') dbType = 'pdf';

          const resUp = await fetch('/soporte/tickets/upload', { method: 'POST', body: formData });
          if (!resUp.ok) throw new Error('Fallo subida');
          const data = await resUp.json();

          uploadedList.push({ url: data.secure_url, nombre: file.name, tipo: dbType });
        }

        hiddenInput.value = JSON.stringify(uploadedList);
        setUploadStatus(statusEl, 'Subida lista. Guardando...', 'ticket-status-text--success');
        form.submit();
      } catch (err) {
        console.error(err);
        setUploadStatus(statusEl, 'Error al subir. Inténtalo de nuevo.', 'ticket-status-text--error');
        if (btnSubmit && window.IntranetModal) window.IntranetModal.ocuparBoton(btnSubmit, false);
      }
    });
  }

  /**
   * Paso "¿tomar este ticket?": los botones del pie no envían, abren la
   * elección de responsable y desde ahí sale el formulario ya resuelto.
   */
  function setupAssignStep(root) {
    const form = root.querySelector('#form-upload-admin');
    const panel = root.querySelector('#ticketAsignar');
    if (!form || !panel || form.dataset.assignBound === 'true') return;
    form.dataset.assignBound = 'true';

    const inputAccion = root.querySelector('#ticketAccion');
    const inputModo = root.querySelector('#ticketAssignMode');
    const inputDestino = root.querySelector('#ticketAssignTo');
    const select = root.querySelector('#ticketAsignarSelect');
    const error = root.querySelector('#ticketAsignarError');
    const titulo = root.querySelector('#ticketAsignarTitulo');
    const hint = root.querySelector('#ticketAsignarHint');
    const btnConfirmar = root.querySelector('#btnAsignarConfirmar');
    const btnCancelar = root.querySelector('#btnAsignarCancelar');
    const radios = Array.from(panel.querySelectorAll('input[name="assign_choice"]'));

    const elegido = () => radios.find((r) => r.checked);

    const mostrarError = (mensaje) => {
      if (!error) return;
      error.textContent = mensaje || '';
      error.hidden = !mensaje;
    };

    const sincronizarSelect = () => {
      const opcion = elegido();
      const esOtro = opcion && opcion.value === 'otro';
      if (select) select.disabled = !esOtro;
      if (esOtro && select) select.focus();
      mostrarError('');
    };

    radios.forEach((radio) => radio.addEventListener('change', sincronizarSelect));
    select?.addEventListener('change', () => mostrarError(''));

    const abrir = (accion) => {
      if (inputAccion) inputAccion.value = accion;
      if (titulo) {
        titulo.textContent = accion === 'cerrar'
          ? '¿Quién cierra este ticket?'
          : '¿Tomar este ticket?';
      }
      if (hint) {
        hint.textContent = accion === 'cerrar'
          ? 'El ticket quedará cerrado a nombre del responsable que elijas.'
          : 'Al guardar, el ticket pasa a En curso a nombre del responsable que elijas.';
      }
      if (btnConfirmar) {
        btnConfirmar.textContent = accion === 'cerrar' ? 'Confirmar y cerrar' : 'Confirmar y guardar';
      }
      mostrarError('');
      panel.hidden = false;
      sincronizarSelect();
      panel.scrollIntoView({ block: 'nearest' });
    };

    const cerrar = () => {
      panel.hidden = true;
      mostrarError('');
    };

    form.querySelectorAll('[data-ticket-accion]').forEach((boton) => {
      boton.addEventListener('click', () => abrir(boton.dataset.ticketAccion));
    });

    btnCancelar?.addEventListener('click', cerrar);

    btnConfirmar?.addEventListener('click', () => {
      const opcion = elegido();
      if (!opcion) return mostrarError('Elige quién se hace cargo del ticket.');

      if (opcion.value === 'otro') {
        if (!select || !select.value) {
          return mostrarError('Selecciona a la persona de Informática que se hará cargo.');
        }
        if (inputDestino) inputDestino.value = select.value;
      } else if (inputDestino) {
        inputDestino.value = '';
      }

      if (inputModo) inputModo.value = opcion.value;
      btnConfirmar.disabled = true;
      form.requestSubmit ? form.requestSubmit() : form.submit();
    });

    // Escape cierra sólo el paso de asignación, no el modal entero.
    panel.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        cerrar();
      }
    });
  }

  function init(root = document) {
    bindCharCounter(root, 'mensajeAdmin', 'charCountAdmin');
    bindCharCounter(root, 'mensajeUser', 'charCountUser');
    bindFilePreview(root, 'archivos_admin', 'upload-status-admin');
    bindFilePreview(root, 'archivos_user', 'upload-status-user');
    setupLocalUpload(root, 'form-upload-admin', 'archivos_admin', 'adjuntos_data_admin', 'upload-status-admin', 'btn-submit-admin');
    setupLocalUpload(root, 'form-upload-user', 'archivos_user', 'adjuntos_data_user', 'upload-status-user', 'btn-submit-user');
    setupAssignStep(root);
  }

  // Las confirmaciones (data-confirm) las atiende IntranetDialog en modal.js.

  window.TicketDetail = { init };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init());
  } else {
    init();
  }
})();
