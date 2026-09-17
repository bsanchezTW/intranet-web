(function () {
  const MAX_CHARS = 2000;
  const DEFAULT_STATUS_CLASS = 'ticket-upload-status';

  function setStatus(statusEl, text, modifier) {
    if (!statusEl) return;
    statusEl.className = modifier
      ? `${DEFAULT_STATUS_CLASS} ticket-status-text--${modifier}`
      : DEFAULT_STATUS_CLASS;
    statusEl.textContent = text;
  }

  /**
   * El texto del botón vive en un <span> propio: escribir sobre el botón
   * borraría el icono que lo acompaña.
   */
  function submitLabelEl(submit) {
    return submit?.querySelector('[data-ticket-submit-label]') || submit;
  }

  function resetForm(form) {
    form.reset();
    const fileInput = form.querySelector('[data-ticket-file-input]');
    const statusEl = form.querySelector('[data-ticket-upload-status]');
    const counter = form.querySelector('[data-ticket-counter]');
    const submit = form.querySelector('[data-ticket-submit]');

    if (fileInput) fileInput.value = '';
    if (counter) {
      counter.textContent = `0 / ${MAX_CHARS}`;
      counter.classList.remove('limit-reached');
    }
    if (submit) {
      const label = submitLabelEl(submit);
      submit.disabled = false;
      label.textContent = submit.dataset.defaultText || label.textContent;
    }
    setStatus(statusEl, 'Arrastra y suelta archivos aquí');
  }

  function bindCounter(form) {
    const textarea = form.querySelector('[data-ticket-description]');
    const counter = form.querySelector('[data-ticket-counter]');
    if (!textarea || !counter) return;

    const refresh = () => {
      const currentLength = textarea.value.length;
      counter.textContent = `${currentLength} / ${MAX_CHARS}`;
      counter.classList.toggle('limit-reached', currentLength >= MAX_CHARS);
    };

    textarea.addEventListener('input', refresh);
    refresh();
  }

  function bindFiles(form) {
    const fileInput = form.querySelector('[data-ticket-file-input]');
    const selectFiles = form.querySelector('[data-ticket-select-files]');
    const statusEl = form.querySelector('[data-ticket-upload-status]');
    if (!fileInput) return;

    selectFiles?.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      setStatus(
        statusEl,
        fileInput.files.length
          ? `${fileInput.files.length} archivos listos para subir.`
          : 'Arrastra y suelta archivos aquí',
      );
    });

    // Arrastrar y soltar sobre el formulario suma los archivos a los elegidos.
    form.addEventListener('dragover', (e) => {
      if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
      e.preventDefault();
      form.classList.add('is-dragging');
    });
    form.addEventListener('dragleave', (e) => {
      if (!form.contains(e.relatedTarget)) form.classList.remove('is-dragging');
    });
    form.addEventListener('drop', (e) => {
      if (!e.dataTransfer || !e.dataTransfer.files.length) return;
      e.preventDefault();
      form.classList.remove('is-dragging');
      const transfer = new DataTransfer();
      [...fileInput.files, ...e.dataTransfer.files].forEach((file) => transfer.items.add(file));
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event('change'));
    });
  }

  /**
   * Los archivos viajan con el formulario y se suben recién cuando el ticket
   * existe (quedan como <N° de ticket>_1, _2…). Aquí sólo se valida el peso.
   */
  function bindSubmit(form) {
    const fileInput = form.querySelector('[data-ticket-file-input]');
    const statusEl = form.querySelector('[data-ticket-upload-status]');
    const submit = form.querySelector('[data-ticket-submit]');
    const label = submitLabelEl(submit);
    const maxMb = Number(form.dataset.maxMb) || 40;
    if (!submit.dataset.defaultText) {
      submit.dataset.defaultText = label.textContent.trim();
    }

    form.addEventListener('submit', (e) => {
      const files = fileInput ? Array.from(fileInput.files || []) : [];
      const pesado = files.find((file) => file.size > maxMb * 1024 * 1024);
      if (pesado) {
        e.preventDefault();
        setStatus(statusEl, `«${pesado.name}» supera los ${maxMb} MB.`, 'error');
        return;
      }
      setStatus(statusEl, files.length ? 'Enviando ticket y archivos…' : 'Enviando ticket…');
    });
  }

  const MODAL_ID = 'modalNuevoTicketNavbar';

  /**
   * Abre el modal de nuevo ticket, opcionalmente prellenado (también con
   * archivos). Lo usan el botón «Abrir Ticket» y el asistente de la intranet.
   * @returns {boolean} false si el modal no existe en esta página.
   */
  function openCreateModal(prefill = {}) {
    const modal = document.getElementById(MODAL_ID);
    const form = modal?.querySelector('[data-ticket-create-form]');
    if (!window.IntranetModal || !modal || !form) return false;

    resetForm(form);
    const setValue = (selector, value) => {
      const field = form.querySelector(selector);
      if (!field || value == null || value === '') return;
      if (field.tagName === 'SELECT' && !Array.from(field.options).some((o) => o.value === value)) return;
      field.value = value;
      field.dispatchEvent(new Event('input', { bubbles: true }));
    };
    setValue('[name="title"]', prefill.title);
    setValue('[name="category"]', prefill.category);
    setValue('[name="priority"]', prefill.priority);
    setValue('[name="description"]', prefill.description);
    if (Array.isArray(prefill.files) && prefill.files.length) {
      const fileInput = form.querySelector('[data-ticket-file-input]');
      const transfer = new DataTransfer();
      prefill.files.forEach((file) => transfer.items.add(file));
      fileInput.files = transfer.files;
      fileInput.dispatchEvent(new Event('change'));
    }

    window.IntranetModal.open(MODAL_ID);
    return true;
  }

  function bindModalOpeners() {
    const modal = document.getElementById(MODAL_ID);
    const form = modal?.querySelector('[data-ticket-create-form]');

    document.querySelectorAll('.js-open-ticket-modal').forEach((link) => {
      link.addEventListener('click', (e) => {
        if (openCreateModal()) e.preventDefault();
      });
    });

    modal?.addEventListener('transitionend', () => {
      if (form && !modal.classList.contains('is-open')) resetForm(form);
    });
  }

  window.TicketCreateModal = { open: openCreateModal };

  function init() {
    document.querySelectorAll('[data-ticket-create-form]').forEach((form) => {
      bindCounter(form);
      bindFiles(form);
      bindSubmit(form);
    });
    bindModalOpeners();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
