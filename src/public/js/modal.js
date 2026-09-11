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

  /**
   * Modales apilados.
   *
   * Un modal puede abrirse encima de otro: la lista de colaboradores y, sobre
   * ella, el de mover de área o el de agregar. Antes el de abajo se cerraba a
   * mano porque todos comparten el z-index de la hoja de estilos y era el
   * orden en el DOM —no el de apertura— quien decidía cuál tapaba a cuál.
   * Aquí se lleva el orden real: cada modal se sitúa un escalón por encima del
   * que ya estaba, y Escape cierra el de más arriba, no el primero del DOM.
   */
  const Z_PASO = 10;
  const Z_BASE = 2000;
  const pila = [];

  function zDe(overlay) {
    const inline = parseInt(overlay.style.zIndex, 10);
    if (!Number.isNaN(inline)) return inline;
    const css = parseInt(window.getComputedStyle(overlay).zIndex, 10);
    return Number.isNaN(css) ? Z_BASE : css;
  }

  function apilar(overlay) {
    const i = pila.indexOf(overlay);
    if (i !== -1) pila.splice(i, 1);
    const debajo = pila[pila.length - 1];
    pila.push(overlay);
    // Dos fondos al 72 % dejan el modal de abajo casi negro. El de encima se
    // aclara para que siga leyéndose lo que hay detrás.
    overlay.classList.toggle('is-apilado', !!debajo);
    // El primero conserva el z-index de su hoja de estilos; sólo los que se
    // abren encima necesitan subir, y suben respecto al que tapan, que puede
    // venir de otra familia de modales con su propio z-index.
    if (debajo) overlay.style.zIndex = String(zDe(debajo) + Z_PASO);
  }

  function desapilar(overlay) {
    const i = pila.indexOf(overlay);
    if (i !== -1) pila.splice(i, 1);
  }

  function topeDePila() {
    for (let i = pila.length - 1; i >= 0; i -= 1) {
      if (pila[i].classList.contains('is-open')) return pila[i];
    }
    // Modales abiertos sin pasar por aquí (vistas con su propio display:flex).
    return document.querySelector('.modal-overlay.is-open, .modal-imagen.is-open');
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
    apilar(overlay);
    lockFor(overlay);

    // Force visible immediately; rAF only for enter transform.
    overlay.classList.add('is-open');
  }

  function close(target) {
    const overlay = resolve(target);
    if (!overlay) return;

    if (!overlay.classList.contains('is-open')) {
      cancelarCierrePendiente(overlay);
      desapilar(overlay);
      overlay.style.zIndex = '';
      overlay.style.display = 'none';
      overlay.classList.remove('is-open', 'is-closing', 'is-apilado');
      overlay.setAttribute('aria-hidden', 'true');
      unlockFor(overlay);
      syncScrollLock();
      return;
    }

    cancelarCierrePendiente(overlay);
    // Sale de la pila en el acto —Escape ya debe apuntar al de abajo— pero
    // conserva su z-index hasta que acabe la animación: quitárselo ahora lo
    // hundiría bajo el modal que estaba tapando a mitad del fundido.
    desapilar(overlay);
    overlay.classList.remove('is-open');
    overlay.classList.add('is-closing');

    const finish = () => {
      // Desarma al otro disparador antes de nada: el que llega segundo ya no
      // tiene nada que cerrar, y un temporizador que sobreviva a este cierre
      // apagaría el modal que el usuario abra después.
      cancelarCierrePendiente(overlay);

      // Y si ya volvió a abrirse, este cierre perdió vigencia.
      if (overlay.classList.contains('is-open')) return;

      overlay.style.zIndex = '';
      overlay.style.display = 'none';
      overlay.classList.remove('is-closing', 'is-apilado');
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

  /**
   * ¿El clic fue realmente sobre el fondo?
   *
   * El evento `click` se dispara en el ancestro común del punto donde se
   * apretó y donde se soltó: arrastrar desde dentro del modal —recortar una
   * foto, seleccionar texto, mover un slider— y soltar fuera lo reporta sobre
   * el overlay, y el modal se cerraba solo. Para cerrar exigimos que el gesto
   * entero, apretar y soltar, ocurra sobre el fondo.
   *
   * Los dos oyentes van en captura sobre `document`: así el gesto se registra
   * aunque algún control de dentro detenga la propagación del evento.
   */
  let apretadoEn = null;
  let soltadoEn = null;

  function seguirGesto() {
    document.addEventListener('pointerdown', (e) => { apretadoEn = e.target; }, true);
    document.addEventListener('pointerup', (e) => { soltadoEn = e.target; }, true);
  }

  function gestoCompletoSobre(overlay) {
    return apretadoEn === overlay && soltadoEn === overlay;
  }

  function bindOverlayDismiss() {
    seguirGesto();

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
        target.dataset.dismiss !== 'false' &&
        gestoCompletoSobre(target)
      ) {
        close(target);
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      // Con modales apilados, Escape cierra sólo el de arriba.
      const openOverlay = topeDePila();
      if (openOverlay && openOverlay.dataset.dismiss !== 'false') close(openOverlay);
    });
  }

  global.IntranetModal = {
    open,
    close,
    isOpen,
    lockScroll,
    unlockScroll,
    gestoCompletoSobre,
    ANIM_MS,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bindOverlayDismiss);
  } else {
    bindOverlayDismiss();
  }
})(window);
