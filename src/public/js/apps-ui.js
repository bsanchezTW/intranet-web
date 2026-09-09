/**
 * Interacción de las tarjetas de aplicaciones: QR de Android, visor del
 * instructivo iOS y modales de alta/edición/notificación para administradores.
 *
 * Lo comparten la vista Apps y la autoayuda de la zona de Soporte, así que las
 * funciones quedan en window para los onclick de las tarjetas.
 */
(function () {
  // ── QR (solo Android; en móvil se abre el enlace directo) ──
  let qrActualUrl = '';

  function esDispositivoMovil() {
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || window.innerWidth <= 768;
  }

  function abrirModalQR(enlaceDescarga, nombreApp) {
    const img = document.getElementById('qr-imagen');
    const btnEnlace = document.getElementById('qr-btn-enlace');
    const titulo = document.getElementById('qr-titulo');
    if (!img) return;

    if (titulo) titulo.innerText = 'QR para ' + nombreApp;
    qrActualUrl = '/apps/qr?url=' + encodeURIComponent(enlaceDescarga);
    img.src = qrActualUrl;
    img.alt = 'Generando código QR...';
    img.onerror = function () {
      img.alt = 'No se pudo generar el código QR';
      qrActualUrl = '';
    };

    if (btnEnlace) {
      btnEnlace.href = enlaceDescarga;
      btnEnlace.style.display = 'inline-flex';
    }

    window.IntranetModal.open('modal-qr');
  }

  function manejarDescargaConQR(urlDescarga, nombreApp) {
    if (!urlDescarga || urlDescarga.trim() === '') return;

    if (esDispositivoMovil()) {
      window.open(urlDescarga, '_blank');
    } else {
      abrirModalQR(urlDescarga, nombreApp);
    }
  }

  function forzarDescargaQR() {
    if (!qrActualUrl) return;
    const link = document.createElement('a');
    link.href = qrActualUrl;
    link.setAttribute('download', 'Codigo_QR.png');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  // ── Visor del instructivo iOS/iPad ──
  function abrirModalPdf(urlPdf, titulo) {
    if (!urlPdf || !String(urlPdf).trim()) return;

    const iframe = document.getElementById('pdf-iframe');
    const btnAbrir = document.getElementById('pdf-btn-abrir');
    const tituloEl = document.getElementById('pdf-titulo');

    if (tituloEl) tituloEl.textContent = titulo || 'Instructivo iOS/iPad';
    if (btnAbrir) btnAbrir.href = urlPdf;
    if (iframe) iframe.src = urlPdf;

    window.IntranetModal.open('modal-pdf');
  }

  // Al cerrar el modal se descarga el PDF de memoria.
  function observarCierreModalPdf() {
    const overlay = document.getElementById('modal-pdf');
    const iframe = document.getElementById('pdf-iframe');
    if (!overlay || !iframe || typeof MutationObserver !== 'function') return;

    new MutationObserver(function () {
      if (overlay.getAttribute('aria-hidden') === 'true') {
        iframe.src = 'about:blank';
      }
    }).observe(overlay, { attributes: true, attributeFilter: ['aria-hidden'] });
  }

  // ── Modales de administración ──
  function appInitialsClient(name) {
    if (!name) return '?';
    const parts = String(name).trim().split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return parts[0].slice(0, 2).toUpperCase();
  }

  function toggleFormulario() {
    if (window.nuevaAppIconCropper) {
      window.nuevaAppIconCropper.clearPhoto();
      const placeholder = document.getElementById('nueva-icon-placeholder');
      if (placeholder) {
        const span = placeholder.querySelector('span');
        if (span) span.textContent = 'AA';
      }
    }
    window.IntranetModal.open('modal-nueva');
  }

  function cerrarModal(id) {
    window.IntranetModal.close(id);
  }

  function setEditIconPreview(iconUrl, iniciales) {
    const previewImg = document.getElementById('edit-icon-preview-img');
    const placeholder = document.getElementById('edit-icon-placeholder');
    const initialsEl = document.getElementById('edit-icon-initials');
    const selectBtn = document.getElementById('edit-icon-select');
    if (!previewImg || !placeholder) return;

    if (initialsEl) initialsEl.textContent = iniciales || 'AA';

    if (iconUrl) {
      previewImg.src = iconUrl;
      previewImg.hidden = false;
      placeholder.hidden = true;
      if (selectBtn) selectBtn.textContent = 'Cambiar icono';
    } else {
      previewImg.hidden = true;
      previewImg.removeAttribute('src');
      placeholder.hidden = false;
      if (selectBtn) selectBtn.textContent = 'Subir icono';
    }
  }

  function abrirModalEditar(id, nombre, desc, pc, apk, iosPdf, web, iconUrl) {
    const formEditar = document.getElementById('form-editar');
    if (!formEditar) return;

    formEditar.action = '/apps/editar/' + id;
    document.getElementById('edit-nombre').value = nombre;
    document.getElementById('edit-desc').value = desc;
    document.getElementById('edit-pc').value = pc || '';
    document.getElementById('edit-apk').value = apk || '';
    document.getElementById('edit-web').value = web || '';

    const editIosPdf = document.getElementById('edit-ios-pdf');
    if (editIosPdf) editIosPdf.value = '';

    const iosActual = document.getElementById('edit-ios-actual');
    const iosVer = document.getElementById('edit-ios-ver');
    if (iosActual && iosVer) {
      if (iosPdf) {
        iosActual.hidden = false;
        iosVer.onclick = function () {
          abrirModalPdf(iosPdf, nombre + ' · Instructivo iOS/iPad');
        };
      } else {
        iosActual.hidden = true;
        iosVer.onclick = null;
      }
    }

    if (window.editAppIconCropper) {
      window.editAppIconCropper.clearPhoto();
    }
    setEditIconPreview(iconUrl || '', appInitialsClient(nombre));

    window.IntranetModal.open('modal-editar');
  }

  function abrirModalNotificar(id, nombre) {
    const form = document.getElementById('form-notificar');
    if (!form) return;

    document.getElementById('notificar-titulo').innerText = 'Notificar cambios: ' + nombre;
    document.getElementById('preview-asunto').innerText = nombre + ': Nueva actualización.';

    form.action = '/apps/notificar/' + id;
    window.IntranetModal.open('modal-notificar');
  }

  function initCroppers() {
    if (typeof ProfilePhotoCropper === 'undefined') return;

    const cropperConfig = {
      maxSizeMb: 5,
      outputSize: 256,
      aspectRatio: 1,
      selectLabel: 'Subir icono',
      changeLabel: 'Cambiar icono',
      outputFilename: 'icono-app.jpg',
    };

    window.nuevaAppIconCropper = ProfilePhotoCropper.init({
      ...cropperConfig,
      fileInputId: 'nueva-icon',
      previewImgId: 'nueva-icon-preview-img',
      previewPlaceholderId: 'nueva-icon-placeholder',
      selectBtnId: 'nueva-icon-select',
      overlayId: 'nuevaIconCropOverlay',
      cropImgId: 'nuevaIconCropImage',
      closeBtnId: 'nuevaIconCropClose',
      cancelBtnId: 'nuevaIconCropCancel',
      saveBtnId: 'nuevaIconCropSave',
      errorElId: 'nuevaIconCropError',
    });

    window.editAppIconCropper = ProfilePhotoCropper.init({
      ...cropperConfig,
      fileInputId: 'edit-icon',
      previewImgId: 'edit-icon-preview-img',
      previewPlaceholderId: 'edit-icon-placeholder',
      selectBtnId: 'edit-icon-select',
      overlayId: 'editIconCropOverlay',
      cropImgId: 'editIconCropImage',
      closeBtnId: 'editIconCropClose',
      cancelBtnId: 'editIconCropCancel',
      saveBtnId: 'editIconCropSave',
      errorElId: 'editIconCropError',
    });

    const nuevaNombre = document.getElementById('nueva-nombre');
    const nuevaPlaceholder = document.querySelector('#nueva-icon-placeholder span');
    if (nuevaNombre && nuevaPlaceholder) {
      nuevaNombre.addEventListener('input', function () {
        const img = document.getElementById('nueva-icon-preview-img');
        if (img && !img.hidden && img.getAttribute('src')) return;
        nuevaPlaceholder.textContent = appInitialsClient(nuevaNombre.value);
      });
    }

    const editNombre = document.getElementById('edit-nombre');
    const editInitials = document.getElementById('edit-icon-initials');
    if (editNombre && editInitials) {
      editNombre.addEventListener('input', function () {
        const img = document.getElementById('edit-icon-preview-img');
        if (img && !img.hidden && img.getAttribute('src')) return;
        editInitials.textContent = appInitialsClient(editNombre.value);
      });
    }
  }

  /**
   * Reordenamiento de tarjetas.
   *
   * Sólo se activa al entrar en modo "Reordenar", para que el uso normal —abrir
   * un enlace, editar— no compita con el arrastre. El orden se guarda de una
   * vez al confirmar, no en cada movimiento.
   */
  function initReorder() {
    const grid = document.querySelector('[data-orden-grid]');
    const toggle = document.querySelector('[data-orden-toggle]');
    const barra = document.querySelector('[data-orden-barra]');
    if (!grid || !toggle || !barra) return;
    // Sin esta guarda, cargar el script dos veces duplicaría los listeners y
    // cada flecha movería la tarjeta dos posiciones.
    if (grid.dataset.ordenBound === 'true') return;
    grid.dataset.ordenBound = 'true';

    const estado = barra.querySelector('[data-orden-estado]');
    const btnGuardar = barra.querySelector('[data-orden-guardar]');
    const btnCancelar = barra.querySelector('[data-orden-cancelar]');
    const catalogo = grid.dataset.ordenCatalogo || 'support';

    let activo = false;
    let ordenOriginal = [];
    let arrastrando = null;

    const items = () => Array.from(grid.querySelectorAll('[data-orden-item]'));
    const idsActuales = () => items().map((el) => el.dataset.ordenItem);

    const aviso = (texto, clase) => {
      if (!estado) return;
      estado.textContent = texto || '';
      estado.className = clase
        ? `apps-orden-barra__estado ${clase}`
        : 'apps-orden-barra__estado';
    };

    const setActivo = (valor) => {
      activo = valor;
      grid.classList.toggle('apps-grid--ordenando', valor);
      barra.hidden = !valor;
      toggle.classList.toggle('is-active', valor);
      toggle.setAttribute('aria-pressed', String(valor));
      items().forEach((el) => {
        el.draggable = valor;
        el.querySelectorAll('[data-orden-mover]').forEach((b) => {
          b.tabIndex = valor ? 0 : -1;
        });
      });
      if (valor) {
        ordenOriginal = idsActuales();
        aviso('');
      }
    };

    const restaurar = () => {
      const porId = new Map(items().map((el) => [el.dataset.ordenItem, el]));
      ordenOriginal.forEach((id) => {
        const el = porId.get(id);
        if (el) grid.appendChild(el);
      });
    };

    toggle.addEventListener('click', () => {
      if (activo) restaurar();
      setActivo(!activo);
    });

    btnCancelar?.addEventListener('click', () => {
      restaurar();
      setActivo(false);
    });

    // Flechas: mueven la tarjeta una posición.
    grid.addEventListener('click', (e) => {
      const boton = e.target.closest('[data-orden-mover]');
      if (!boton || !activo) return;
      e.preventDefault();

      const tarjeta = boton.closest('[data-orden-item]');
      const paso = Number(boton.dataset.ordenMover);
      const lista = items();
      const desde = lista.indexOf(tarjeta);
      const hasta = desde + paso;
      if (hasta < 0 || hasta >= lista.length) return;

      if (paso < 0) grid.insertBefore(tarjeta, lista[hasta]);
      else grid.insertBefore(lista[hasta], tarjeta);

      aviso('');
      tarjeta.focus?.();
    });

    // Arrastre con la API nativa: la tarjeta se suelta antes o después de otra
    // según de qué lado del centro cae el puntero.
    grid.addEventListener('dragstart', (e) => {
      const tarjeta = e.target.closest('[data-orden-item]');
      if (!activo || !tarjeta) return e.preventDefault();
      arrastrando = tarjeta;
      tarjeta.classList.add('is-dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox exige datos para iniciar el arrastre.
      e.dataTransfer.setData('text/plain', tarjeta.dataset.ordenItem);
    });

    grid.addEventListener('dragend', () => {
      arrastrando?.classList.remove('is-dragging');
      arrastrando = null;
    });

    grid.addEventListener('dragover', (e) => {
      if (!activo || !arrastrando) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';

      const destino = e.target.closest('[data-orden-item]');
      if (!destino || destino === arrastrando) return;

      const caja = destino.getBoundingClientRect();
      const despues =
        e.clientY > caja.top + caja.height / 2 ||
        (e.clientY >= caja.top && e.clientX > caja.left + caja.width / 2);

      if (despues) destino.after(arrastrando);
      else destino.before(arrastrando);
      aviso('');
    });

    grid.addEventListener('drop', (e) => {
      if (activo) e.preventDefault();
    });

    btnGuardar?.addEventListener('click', async () => {
      const ids = idsActuales();
      btnGuardar.disabled = true;
      aviso('Guardando…');

      try {
        const res = await fetch('/apps/orden', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ catalog: catalogo, ids }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.ok) throw new Error(data.error || 'Error al guardar');

        ordenOriginal = ids;
        aviso('Orden guardado', 'apps-orden-barra__estado--ok');
        setTimeout(() => setActivo(false), 700);
      } catch (err) {
        console.error(err);
        aviso('No se pudo guardar el orden', 'apps-orden-barra__estado--error');
      } finally {
        btnGuardar.disabled = false;
      }
    });

    setActivo(false);
  }

  function init() {
    observarCierreModalPdf();
    if (document.querySelector('[data-apps-admin="true"]')) initCroppers();
    initReorder();
  }

  // Las tarjetas invocan estas funciones desde onclick.
  window.manejarDescargaConQR = manejarDescargaConQR;
  window.forzarDescargaQR = forzarDescargaQR;
  window.abrirModalQR = abrirModalQR;
  window.abrirModalPdf = abrirModalPdf;
  window.abrirModalEditar = abrirModalEditar;
  window.abrirModalNotificar = abrirModalNotificar;
  window.toggleFormulario = toggleFormulario;
  window.cerrarModal = cerrarModal;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
