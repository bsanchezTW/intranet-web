(function (global) {
  const ANIM_MS = 280;
  let scrollLockCount = 0;
  let savedScrollY = 0;

  /**
   * Cierres en vuelo, por overlay.
   *
   * El cierre es diferido (espera la animación), así que si se reabre antes de
   * que termine hay que cancelar el temporizador y el listener pendientes: si
   * no, el cierre viejo se ejecuta sobre el modal recién abierto y lo apaga en
   * el acto. Ese era el bug de "abre y se cierra al tiro" al reabrir rápido.
   *
   * Todo cierre tiene dos disparadores —el transitionend del panel y un
   * temporizador de respaldo— y basta con que gane cualquiera de los dos. El
   * que gane tiene que desarmar al otro: si no, el perdedor queda huérfano,
   * fuera de este mapa, y nadie puede cancelarlo cuando el modal se reabre.
   */
  const cierresPendientes = new WeakMap();

  function cancelarCierrePendiente(overlay) {
    const pendiente = cierresPendientes.get(overlay);
    if (!pendiente) return;
    clearTimeout(pendiente.timer);
    pendiente.panel?.removeEventListener('transitionend', pendiente.onEnd);
    cierresPendientes.delete(overlay);
  }

  function resolve(el) {
    if (!el) return null;
    return typeof el === 'string' ? document.getElementById(el) : el;
  }

  function getPanel(overlay) {
    return (
      overlay.querySelector('.modal-content') ||
      overlay.querySelector('.modal-content2') ||
      overlay.querySelector('.modal-imagen-contenido') ||
      overlay.firstElementChild
    );
  }

  function hasBlockingOverlay() {
    return !!document.querySelector(
      '.modal-overlay.is-open, .modal-imagen.is-open, .foto-crop-overlay.is-open',
    );
  }

  function lockScroll() {
    if (scrollLockCount === 0) {
      savedScrollY = window.scrollY || document.documentElement.scrollTop || 0;
      document.documentElement.classList.add('modal-open');
      document.body.classList.add('modal-open');
      document.body.style.top = `-${savedScrollY}px`;
    }
    scrollLockCount += 1;
  }

  function unlockScroll() {
    if (scrollLockCount <= 0) return;
    scrollLockCount -= 1;
    if (scrollLockCount > 0) return;

    document.documentElement.classList.remove('modal-open');
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    window.scrollTo(0, savedScrollY);
  }

  function syncScrollLock() {
    if (hasBlockingOverlay()) {
      if (scrollLockCount === 0) lockScroll();
      return;
    }
    if (scrollLockCount > 0) {
      scrollLockCount = 1;
      unlockScroll();
    }
  }

  function isOpen(overlay) {
    return overlay && overlay.classList.contains('is-open');
  }

  /** El bloqueo de scroll se contabiliza una vez por overlay, no por llamada. */
  function lockFor(overlay) {
    if (overlay.dataset.modalLocked === 'true') return;
    overlay.dataset.modalLocked = 'true';
    lockScroll();
  }

  function unlockFor(overlay) {
    if (overlay.dataset.modalLocked !== 'true') return;
    delete overlay.dataset.modalLocked;
    unlockScroll();
  }

  function open(target) {
    const overlay = resolve(target);
    if (!overlay) return;

    // Un cierre a medio camino se aborta antes de volver a mostrar.
    cancelarCierrePendiente(overlay);

    overlay.classList.remove('is-closing');
    overlay.style.display = 'flex';
    overlay.setAttribute('aria-hidden', 'false');
    lockFor(overlay);

    // Force visible immediately; rAF only for enter transform.
    overlay.classList.add('is-open');
  }

  function close(target) {
    const overlay = resolve(target);
    if (!overlay) return;

    if (!overlay.classList.contains('is-open')) {
      cancelarCierrePendiente(overlay);
      overlay.style.display = 'none';
      overlay.classList.remove('is-open', 'is-closing');
      overlay.setAttribute('aria-hidden', 'true');
      unlockFor(overlay);
      syncScrollLock();
      return;
    }

    cancelarCierrePendiente(overlay);
    overlay.classList.remove('is-open');
    overlay.classList.add('is-closing');

    const finish = () => {
      // Desarma al otro disparador antes de nada: el que llega segundo ya no
      // tiene nada que cerrar, y un temporizador que sobreviva a este cierre
      // apagaría el modal que el usuario abra después.
      cancelarCierrePendiente(overlay);

      // Y si ya volvió a abrirse, este cierre perdió vigencia.
      if (overlay.classList.contains('is-open')) return;

      overlay.style.display = 'none';
      overlay.classList.remove('is-closing');
      overlay.setAttribute('aria-hidden', 'true');
      unlockFor(overlay);
      syncScrollLock();
    };

    const panel = getPanel(overlay);
    // Sólo interesa el fin de la animación del panel: los controles de dentro
    // también animan (bordes, sombras) y sus transitionend burbujean hasta aquí.
    const onEnd = (e) => {
      if (panel && e.target !== panel) return;
      finish();
    };

    // La entrada se registra antes de escuchar, para que un transitionend
    // inmediato encuentre qué cancelar.
    cierresPendientes.set(overlay, {
      timer: setTimeout(finish, ANIM_MS + 40),
      panel,
      onEnd,
    });

    if (panel) {
      panel.addEventListener('transitionend', onEnd);
    }
  }

  function bindOverlayDismiss() {
    document.addEventListener('click', (e) => {
      const target = e.target;
      const closeButton = target.closest('[data-modal-close]');
      if (closeButton) {
        const overlay = closeButton.closest('.modal-overlay, .modal-imagen');
        if (overlay) {
          close(overlay);
          return;
        }
      }

      if (
        (target.classList.contains('modal-overlay') ||
          target.classList.contains('modal-imagen')) &&
        target.classList.contains('is-open') &&
        target.dataset.dismiss !== 'false'
      ) {
        close(target);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      const openOverlay = document.querySelector(
        '.modal-overlay.is-open, .modal-imagen.is-open',
      );
      if (openOverlay && openOverlay.dataset.dismiss !== 'false') close(openOverlay);
    });
  }

  global.IntranetModal = { open, close, isOpen, lockScroll, unlockScroll, ANIM_MS };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindOverlayDismiss);
  } else {
    bindOverlayDismiss();
  }
})(window);
