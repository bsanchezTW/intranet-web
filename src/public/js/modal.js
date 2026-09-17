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
      overlay.dispatchEvent(new CustomEvent('modal:cerrando'));
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
    // Aviso para quien espera la respuesta de un diálogo: el cierre puede venir
    // de Escape o del fondo, no sólo de sus botones.
    overlay.dispatchEvent(new CustomEvent('modal:cerrando'));
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
      if (openOverlay && openOverlay.dataset.dismiss !== 'false') {
        // Marca la tecla como atendida: un modal que gestiona su propio
        // Escape (data-dismiss="false") no debe reaccionar a la misma pulsación.
        e.preventDefault();
        close(openOverlay);
      }
    });
  }

  /**
   * Botón en espera: el spinner se superpone al texto, que queda invisible
   * pero sigue ocupando su lugar, así el botón no cambia de ancho ni de alto.
   * Toma el color del texto para que el spinner se lea sobre cualquier fondo.
   *
   *   IntranetModal.ocuparBoton(boton, true);   // al enviar
   *   IntranetModal.ocuparBoton(boton, false);  // si el envío falla
   */
  function ocuparBoton(boton, activo = true) {
    if (!boton) return;
    if (activo) {
      if (boton.classList.contains('is-enviando')) return;
      boton.style.setProperty('--spinner-color', window.getComputedStyle(boton).color);
      boton.classList.add('is-enviando');
      boton.setAttribute('aria-busy', 'true');
      if (!boton.querySelector(':scope > .btn-submit-spinner')) {
        const spinner = document.createElement('span');
        spinner.className = 'btn-submit-spinner';
        spinner.setAttribute('aria-hidden', 'true');
        boton.appendChild(spinner);
      }
      // No se deshabilita en el mismo tick: en algunos navegadores deshabilitar
      // el botón que dispara el submit aborta el POST.
      window.setTimeout(() => {
        if (boton.classList.contains('is-enviando')) boton.disabled = true;
      }, 0);
      return;
    }
    boton.classList.remove('is-enviando');
    boton.removeAttribute('aria-busy');
    boton.disabled = false;
    boton.querySelectorAll(':scope > .btn-submit-spinner').forEach((el) => el.remove());
  }

  /**
   * Todo formulario que se envía de verdad (nadie hizo preventDefault) muestra
   * el spinner en su botón mientras carga la página siguiente. Va en window y
   * en burbuja para enterarse después de todos los oyentes del formulario.
   * Los envíos con fetch llaman a ocuparBoton por su cuenta.
   */
  function bindSpinnerDeEnvio() {
    window.addEventListener('submit', (e) => {
      const form = e.target;
      if (e.defaultPrevented || !(form instanceof HTMLFormElement)) return;
      if (form.method === 'dialog' || form.target === '_blank' || form.hasAttribute('data-sin-spinner')) return;
      const boton = (e.submitter && e.submitter.form === form && e.submitter.tagName === 'BUTTON')
        ? e.submitter
        : form.querySelector('button[type="submit"]') ||
          (form.id ? document.querySelector(`button[type="submit"][form="${form.id}"]`) : null);
      ocuparBoton(boton, true);
    });
    // Al volver con "atrás" la página sale de la caché con el botón ocupado.
    window.addEventListener('pageshow', (e) => {
      if (!e.persisted) return;
      document.querySelectorAll('.is-enviando').forEach((boton) => ocuparBoton(boton, false));
    });
  }

  bindSpinnerDeEnvio();

  global.IntranetModal = {
    ocuparBoton,
    open,
    close,
    isOpen,
    /** El modal abierto más arriba de la pila (el que recibe Escape). */
    top: topeDePila,
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

  /* ════════════════════════════════════════════════════════════════════════
     IntranetDialog — confirmar, avisar y pedir un dato con el modal propio.

     Reemplaza a window.confirm/alert/prompt, que el navegador pinta a su
     manera (con "localhost:3000" de título) y bloquean la página. Todo
     devuelve una promesa:

       await IntranetDialog.confirm({ title, message, acceptLabel, tone })  → boolean
       await IntranetDialog.alert({ title, message })                       → void
       await IntranetDialog.prompt({ title, message, label, required })     → string | null

     Y sin JavaScript propio, en el marcado:

       <form data-confirm="Mensaje" data-confirm-title="…"
             data-confirm-accept="Eliminar" data-confirm-tone="peligro">
       <button data-confirm="…">  ·  <a href data-confirm="…">
     ════════════════════════════════════════════════════════════════════════ */

  const ICONOS = {
    peligro:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    normal:
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
  };

  let dialogoSeq = 0;

  function normalizarOpciones(opciones, defecto) {
    const base = typeof opciones === 'string' ? { message: opciones } : { ...(opciones || {}) };
    // Un atributo ausente llega como undefined y no debe pisar el valor por defecto.
    Object.keys(base).forEach((k) => {
      if (base[k] === undefined || base[k] === '') delete base[k];
    });
    return { ...defecto, ...base };
  }

  function crearElemento(tag, clase, texto) {
    const el = document.createElement(tag);
    if (clase) el.className = clase;
    if (texto != null) el.textContent = texto;
    return el;
  }

  /**
   * Arma un diálogo, lo abre y resuelve cuando se cierra por cualquier vía.
   * Cada llamada crea su propio overlay y lo borra al terminar: dos diálogos
   * seguidos no comparten estado.
   */
  function abrirDialogo({ kind, title, message, acceptLabel, cancelLabel, tone, label, placeholder, required, multiline, defaultValue, maxLength }) {
    return new Promise((resolver) => {
      dialogoSeq += 1;
      const idBase = `intranet-dialogo-${dialogoSeq}`;
      const peligro = tone === 'peligro';
      const previo = document.activeElement;

      const overlay = crearElemento('div', 'modal-overlay modal-overlay--dialogo');
      overlay.id = idBase;
      overlay.setAttribute('role', kind === 'alert' ? 'alertdialog' : 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-labelledby', `${idBase}-titulo`);
      overlay.setAttribute('aria-hidden', 'true');

      const panel = crearElemento('div', `modal-content modal-content--sm modal-dialogo${peligro ? ' modal-dialogo--peligro' : ''}`);
      const form = crearElemento('form');
      form.noValidate = true;

      const head = crearElemento('header', 'modal-head');
      const icono = crearElemento('span', 'modal-head__icono');
      icono.innerHTML = peligro ? ICONOS.peligro : ICONOS.normal;
      const titulo = crearElemento('h2', 'modal-title', title);
      titulo.id = `${idBase}-titulo`;
      head.append(icono, titulo);

      const body = crearElemento('div', 'modal-body');
      if (message) {
        const texto = crearElemento('p', 'modal-text', message);
        texto.id = `${idBase}-texto`;
        overlay.setAttribute('aria-describedby', texto.id);
        body.append(texto);
      }

      let campo = null;
      let errorCampo = null;
      if (kind === 'prompt') {
        const wrap = crearElemento('div', 'campo-form');
        const lbl = crearElemento('label', null, label || 'Respuesta');
        campo = crearElemento(multiline ? 'textarea' : 'input');
        campo.id = `${idBase}-campo`;
        lbl.htmlFor = campo.id;
        if (!multiline) campo.type = 'text';
        if (multiline) campo.rows = 3;
        if (placeholder) campo.placeholder = placeholder;
        if (maxLength) campo.maxLength = maxLength;
        campo.value = defaultValue || '';
        errorCampo = crearElemento('span', 'campo-form__error', 'Este dato es obligatorio.');
        wrap.append(lbl, campo, errorCampo);
        body.append(wrap);
      }

      const foot = crearElemento('footer', 'modal-foot');
      let cancelar = null;
      if (kind !== 'alert') {
        cancelar = crearElemento('button', 'btn-secundario', cancelLabel);
        cancelar.type = 'button';
        foot.append(cancelar);
      }
      const aceptar = crearElemento('button', peligro ? 'btn-peligro' : 'btn-primario', acceptLabel);
      aceptar.type = 'submit';
      foot.append(aceptar);

      form.append(head, body, foot);
      panel.append(form);
      overlay.append(panel);
      document.body.append(overlay);

      let resultado = kind === 'confirm' ? false : kind === 'prompt' ? null : undefined;
      let resuelto = false;

      overlay.addEventListener('modal:cerrando', () => {
        if (resuelto) return;
        resuelto = true;
        resolver(resultado);
        window.setTimeout(() => {
          overlay.remove();
          if (previo && typeof previo.focus === 'function' && document.contains(previo)) {
            previo.focus({ preventScroll: true });
          }
        }, ANIM_MS + 60);
      });

      form.addEventListener('submit', (e) => {
        e.preventDefault();
        if (kind === 'prompt') {
          const valor = campo.value.trim();
          if (required && !valor) {
            campo.closest('.campo-form').classList.add('is-invalid');
            campo.focus();
            return;
          }
          resultado = valor;
        } else if (kind === 'confirm') {
          resultado = true;
        }
        close(overlay);
      });

      if (cancelar) cancelar.addEventListener('click', () => close(overlay));
      if (campo) {
        campo.addEventListener('input', () => campo.closest('.campo-form').classList.remove('is-invalid'));
      }

      open(overlay);
      // Lo destructivo arranca en Cancelar: un Enter distraído no borra nada.
      const foco = campo || (peligro && cancelar) || aceptar;
      window.requestAnimationFrame(() => foco.focus({ preventScroll: true }));
    });
  }

  const IntranetDialog = {
    confirm(opciones) {
      return abrirDialogo(normalizarOpciones(opciones, {
        kind: 'confirm',
        title: '¿Confirmas esta acción?',
        acceptLabel: 'Confirmar',
        cancelLabel: 'Cancelar',
        tone: 'normal',
      }));
    },
    alert(opciones) {
      return abrirDialogo(normalizarOpciones(opciones, {
        kind: 'alert',
        title: 'Aviso',
        acceptLabel: 'Entendido',
        tone: 'normal',
      }));
    },
    prompt(opciones) {
      return abrirDialogo(normalizarOpciones(opciones, {
        kind: 'prompt',
        title: 'Completa el dato',
        acceptLabel: 'Aceptar',
        cancelLabel: 'Cancelar',
        tone: 'normal',
        required: true,
      }));
    },
  };

  const confirmados = new WeakSet();

  /**
   * Para un oyente de `submit` que decide en el momento si pide confirmación:
   *
   *   form.addEventListener('submit', (e) => {
   *     if (!IntranetDialog.confirmarEnvio(e, { title, message })) return;
   *     …lo que tenga que pasar sólo con el envío ya confirmado…
   *   });
   *
   * La primera vez frena el envío y pregunta; si se acepta, lo repite con el
   * mismo botón y en esa segunda pasada devuelve true sin volver a preguntar.
   */
  IntranetDialog.confirmarEnvio = function confirmarEnvio(evento, opciones) {
    const form = evento.target;
    if (confirmados.has(form)) {
      confirmados.delete(form);
      return true;
    }
    evento.preventDefault();
    const boton = evento.submitter && evento.submitter.form === form ? evento.submitter : null;
    IntranetDialog.confirm(opciones).then((ok) => {
      if (!ok) return;
      confirmados.add(form);
      if (typeof form.requestSubmit === 'function') form.requestSubmit(boton || undefined);
      else form.submit();
    });
    return false;
  };

  function opcionesDesde(el) {
    const d = el.dataset;
    return {
      message: d.confirm,
      title: d.confirmTitle || undefined,
      acceptLabel: d.confirmAccept || undefined,
      cancelLabel: d.confirmCancel || undefined,
      tone: d.confirmTone || undefined,
    };
  }

  /**
   * Confirmación declarativa. Los oyentes van en captura sobre document para
   * adelantarse a cualquier otro manejador del formulario: si el usuario
   * cancela, nadie más se entera; si acepta, el envío se repite completo
   * —con su botón original— y ahí sí corren todos.
   */
  function bindConfirmacionesDeclarativas() {
    document.addEventListener('submit', (e) => {
      const form = e.target;
      if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-confirm')) return;
      if (confirmados.has(form)) {
        confirmados.delete(form);
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      const boton = e.submitter && e.submitter.form === form ? e.submitter : null;
      IntranetDialog.confirm(opcionesDesde(form)).then((ok) => {
        if (!ok) return;
        confirmados.add(form);
        if (typeof form.requestSubmit === 'function') form.requestSubmit(boton || undefined);
        else form.submit();
      });
    }, true);

    document.addEventListener('click', (e) => {
      const el = e.target.closest && e.target.closest('[data-confirm]');
      if (!el || el instanceof HTMLFormElement) return;
      if (confirmados.has(el)) {
        confirmados.delete(el);
        return;
      }
      e.preventDefault();
      e.stopImmediatePropagation();
      IntranetDialog.confirm(opcionesDesde(el)).then((ok) => {
        if (!ok) return;
        confirmados.add(el);
        el.click();
      });
    }, true);
  }

  bindConfirmacionesDeclarativas();

  global.IntranetDialog = IntranetDialog;
})(window);
