/**
 * RRHH · Personal — filtros, ordenación y modales del directorio.
 *
 * Antes vivía como <script> de 270 líneas dentro de personal.ejs. Aquí queda
 * separado en piezas con una responsabilidad cada una y sin handlers `onclick`
 * en el marcado.
 *
 * El servidor pasa su estado inicial en <script type="application/json"
 * id="personal-config">; este archivo no interpola nada de EJS.
 */
(function () {
  'use strict';

  var POPUP_MS = 4500;

  // ── Configuración enviada por el servidor ────────────────────────────────
  function leerConfig() {
    var nodo = document.getElementById('personal-config');
    if (!nodo) return {};
    try {
      return JSON.parse(nodo.textContent) || {};
    } catch (error) {
      console.error('[Personal] Configuración inicial inválida:', error);
      return {};
    }
  }

  // ── Utilidades ───────────────────────────────────────────────────────────
  function todos(selector, raiz) {
    return Array.prototype.slice.call((raiz || document).querySelectorAll(selector));
  }

  function limpiarQuery(claves) {
    var url = new URL(window.location.href);
    claves.forEach(function (clave) { url.searchParams.delete(clave); });
    window.history.replaceState({}, document.title, url.pathname + url.search);
  }

  function mostrarMensaje(elemento, texto) {
    if (!elemento) return;
    elemento.textContent = texto || '';
    elemento.classList.toggle('show', Boolean(texto));
  }

  /**
   * Ejecuta `alCerrar` cada vez que el modal pasa a estar oculto, sea cual sea
   * la vía (botón, fondo o Escape). IntranetModal no expone callbacks.
   */
  function alCerrarModal(overlay, alCerrar) {
    if (!overlay || typeof MutationObserver !== 'function') return;

    new MutationObserver(function () {
      if (overlay.getAttribute('aria-hidden') === 'true') alCerrar();
    }).observe(overlay, { attributes: true, attributeFilter: ['aria-hidden'] });
  }

  // ── Buscador + chips de área ─────────────────────────────────────────────
  function initFiltros() {
    var buscador = document.getElementById('buscarColaborador');
    var chips = todos('[data-filtro-area]');
    var filas = todos('#tablaPersonal tbody tr');
    var sinResultados = document.getElementById('personalSinResultados');
    var contador = document.getElementById('contadorColaboradores');
    if (!filas.length) return;

    var estado = { texto: '', area: '' };

    function aplicar() {
      var visibles = 0;

      filas.forEach(function (fila) {
        var coincideTexto = !estado.texto || (fila.dataset.search || '').indexOf(estado.texto) !== -1;
        var coincideArea = !estado.area || fila.dataset.area === estado.area;
        var visible = coincideTexto && coincideArea;
        fila.hidden = !visible;
        if (visible) visibles += 1;
      });

      if (contador) contador.textContent = String(visibles);
      if (sinResultados) sinResultados.hidden = visibles > 0;
    }

    if (buscador) {
      buscador.addEventListener('input', function () {
        estado.texto = buscador.value.trim().toLowerCase();
        aplicar();
      });
      buscador.addEventListener('keydown', function (evento) {
        if (evento.key !== 'Escape' || !buscador.value) return;
        buscador.value = '';
        estado.texto = '';
        aplicar();
      });
    }

    chips.forEach(function (chip) {
      chip.addEventListener('click', function () {
        estado.area = chip.dataset.filtroArea || '';
        chips.forEach(function (otro) {
          var activo = otro === chip;
          otro.classList.toggle('is-activo', activo);
          otro.setAttribute('aria-pressed', activo ? 'true' : 'false');
        });
        aplicar();
      });
    });
  }

  // ── Ordenación de la tabla ───────────────────────────────────────────────
  function initOrden() {
    var tabla = document.getElementById('tablaPersonal');
    if (!tabla) return;

    var cuerpo = tabla.querySelector('tbody');
    var cabeceras = todos('th[data-ordenable]', tabla);

    function valorDe(fila, indice) {
      var celda = fila.cells[indice];
      if (!celda) return '';
      var crudo = celda.dataset.sort !== undefined ? celda.dataset.sort : celda.innerText;
      return String(crudo).trim().toLowerCase();
    }

    function ordenarPor(cabecera) {
      var indice = cabecera.cellIndex;
      var ascendente = cabecera.getAttribute('aria-sort') !== 'ascending';

      cabeceras.forEach(function (otra) { otra.setAttribute('aria-sort', 'none'); });
      cabecera.setAttribute('aria-sort', ascendente ? 'ascending' : 'descending');

      todos('tr', cuerpo)
        .sort(function (a, b) {
          var valorA = valorDe(a, indice);
          var valorB = valorDe(b, indice);
          var numeroA = parseFloat(valorA);
          var numeroB = parseFloat(valorB);

          if (!isNaN(numeroA) && !isNaN(numeroB)) {
            return ascendente ? numeroA - numeroB : numeroB - numeroA;
          }
          return ascendente ? valorA.localeCompare(valorB, 'es') : valorB.localeCompare(valorA, 'es');
        })
        .forEach(function (fila) { cuerpo.appendChild(fila); });
    }

    cabeceras.forEach(function (cabecera) {
      var boton = cabecera.querySelector('button');
      if (boton) boton.addEventListener('click', function () { ordenarPor(cabecera); });
    });
  }

  // ── Aviso flotante ───────────────────────────────────────────────────────
  function initPopup() {
    var popup = document.getElementById('popup');
    if (!popup) return;

    var cerrar = function () { popup.classList.remove('show'); };
    var boton = popup.querySelector('[data-popup-close]');
    if (boton) boton.addEventListener('click', cerrar);
    if (popup.classList.contains('show')) window.setTimeout(cerrar, POPUP_MS);
  }

  // ── Modal: crear colaborador ─────────────────────────────────────────────
  function initModalCrear(config) {
    var overlay = document.getElementById('modalCrearColaborador');
    var disparador = document.querySelector('[data-abrir-crear]');
    if (!overlay) return;

    var error = document.getElementById('crearColaboradorError');

    function abrir(mensaje) {
      mostrarMensaje(error, mensaje);
      window.IntranetModal.open(overlay);
    }

    if (disparador) disparador.addEventListener('click', function () { abrir(''); });

    alCerrarModal(overlay, function () {
      mostrarMensaje(error, '');
      limpiarQuery(['crearError', 'abrirCrear']);
    });

    initFormularioCrear();

    if (config.abrirCrear) abrir(config.crearError);
  }

  /** Validación del formulario de alta (correo, teléfono y fecha obligatoria). */
  function initFormularioCrear() {
    var formulario = document.getElementById('formCrearColaborador');
    if (!formulario) return;

    var FECHA_REQUERIDA = 'Fecha requerida sin correo';

    var email = document.getElementById('crear_email');
    var fecha = document.getElementById('crear_fecha_nacimiento');
    var fechaMarca = document.getElementById('crear_fecha_nacimiento_mark');
    var telefonoCampo = document.getElementById('crear_phone_field');
    var telefonoLocal = document.getElementById('crear_telefono_local');

    // Sin correo no hay cuenta de intranet, así que el cumpleaños pasa a ser el
    // único dato con el que RRHH puede identificar la ficha.
    function sincronizarFecha() {
      if (!fecha) return;
      var obligatoria = window.EmailValidate.isEmpty(email);
      fecha.required = obligatoria;
      if (fechaMarca) fechaMarca.hidden = !obligatoria;
      if (!obligatoria) window.CampoForm.limpiar(fecha);
    }

    function telefonoInvalido() {
      return (
        !window.PhoneField.isFieldEmpty(telefonoCampo) &&
        !window.PhoneField.isFieldValid(telefonoCampo)
      );
    }

    window.EmailValidate.initField(email);
    window.PhoneField.initField(telefonoCampo);

    if (email) {
      email.addEventListener('input', function () {
        window.CampoForm.marcar(
          email,
          window.EmailValidate.isValid(email) ? '' : window.EmailValidate.ERROR_MSG,
        );
        sincronizarFecha();
      });
    }

    if (telefonoLocal) {
      telefonoLocal.addEventListener('input', function () {
        window.CampoForm.marcar(
          telefonoLocal,
          telefonoInvalido() ? window.PhoneField.ERROR_MSG : '',
        );
      });
    }

    sincronizarFecha();

    formulario.addEventListener('submit', function (evento) {
      var hayError = false;

      if (!window.EmailValidate.isValid(email)) {
        hayError = true;
        window.CampoForm.marcar(email, window.EmailValidate.ERROR_MSG);
      }

      if (telefonoInvalido()) {
        hayError = true;
        window.CampoForm.marcar(telefonoLocal, window.PhoneField.ERROR_MSG);
      }

      if (window.EmailValidate.isEmpty(email) && !String(fecha && fecha.value || '').trim()) {
        hayError = true;
        window.CampoForm.marcar(fecha, FECHA_REQUERIDA);
      }

      if (!hayError) return;
      evento.preventDefault();
      window.CampoForm.enfocarPrimerError(formulario);
    });
  }

  // ── Modal: editar colaborador ────────────────────────────────────────────
  function initModalEditar(config) {
    var overlay = document.getElementById('modalEditarColaborador');
    if (!overlay) return;

    var cuerpo = document.getElementById('modalEditarColaboradorBody');
    var error = document.getElementById('editarColaboradorError');
    var CARGANDO = '<p class="modal-loading">Cargando colaborador…</p>';
    var destruirFormulario = null;

    // Abrir y cerrar deprisa deja peticiones en vuelo. Cada apertura se queda
    // con un número, y sólo la última pinta: si no, la respuesta lenta de una
    // ficha anterior sobreescribe la que el usuario está mirando.
    var apertura = 0;

    async function abrir(id, mensaje) {
      var mia = ++apertura;
      mostrarMensaje(error, mensaje);
      cuerpo.innerHTML = CARGANDO;
      window.IntranetModal.open(overlay);

      try {
        var respuesta = await fetch('/RRHH/editar/' + encodeURIComponent(id) + '?partial=1', {
          credentials: 'same-origin',
        });
        if (!respuesta.ok) throw new Error('No se pudo cargar el colaborador');

        var html = await respuesta.text();
        if (mia !== apertura) return;

        cuerpo.innerHTML = html;
        if (window.NationalIdField) window.NationalIdField.init(cuerpo);
        if (destruirFormulario) destruirFormulario();
        destruirFormulario =
          typeof window.initPersonaEditarForm === 'function' ? window.initPersonaEditarForm() : null;
      } catch (fallo) {
        if (mia !== apertura) return;
        cuerpo.innerHTML = '<p class="modal-loading">No se pudo cargar el formulario de edición.</p>';
        mostrarMensaje(error, 'Error al cargar los datos del colaborador.');
      }
    }

    alCerrarModal(overlay, function () {
      // Invalida lo que siga en vuelo: al reabrir se pide de nuevo.
      apertura += 1;
      if (destruirFormulario) {
        destruirFormulario();
        destruirFormulario = null;
      }
      cuerpo.innerHTML = CARGANDO;
      mostrarMensaje(error, '');
      limpiarQuery(['editar', 'editarError']);
    });

    // Delegación: las filas se reordenan al ordenar la tabla.
    document.addEventListener('click', function (evento) {
      var origen = evento.target;
      var enlace = origen && origen.closest ? origen.closest('[data-editar-id]') : null;
      if (!enlace) return;
      evento.preventDefault();
      abrir(enlace.dataset.editarId, '');
    });

    if (config.editarId && !config.abrirCrear) abrir(config.editarId, config.editarError);
  }

  function init() {
    var config = leerConfig();

    initFiltros();
    initOrden();
    initPopup();

    if (!config.puedeEditar) return;
    initModalCrear(config);
    initModalEditar(config);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
