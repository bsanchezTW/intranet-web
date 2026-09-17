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

      // /RRHH/personal?q=… (enlace del asistente) llega con la búsqueda aplicada.
      var consulta = new URLSearchParams(window.location.search).get('q');
      if (consulta) {
        buscador.value = consulta;
        estado.texto = consulta.trim().toLowerCase();
        aplicar();
        limpiarQuery(['q']);
      }
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

  /** Validación del formulario de alta (correos, teléfonos y fecha obligatoria). */
  function initFormularioCrear() {
    var formulario = document.getElementById('formCrearColaborador');
    if (!formulario) return;

    var FECHA_REQUERIDA = 'Fecha requerida sin correo';

    var email = document.getElementById('crear_email');
    var fecha = document.getElementById('crear_fecha_nacimiento');
    var fechaMarca = document.getElementById('crear_fecha_nacimiento_mark');
    // Teléfono de empresa y personal, y correo personal: opcionales, sólo se
    // marcan cuando lo escrito no es válido.
    var telefonoCampos = todos('[data-phone-field]', formulario);
    var correoPersonal = document.getElementById('crear_personal_email');

    // Sin correo no hay cuenta de intranet, así que el cumpleaños pasa a ser el
    // único dato con el que RRHH puede identificar la ficha.
    function sincronizarFecha() {
      if (!fecha) return;
      // La cuenta usa el correo de empresa y, si no hay, el personal.
      var obligatoria =
        window.EmailValidate.isEmpty(email) && window.EmailValidate.isEmpty(correoPersonal);
      fecha.required = obligatoria;
      if (fechaMarca) fechaMarca.hidden = !obligatoria;
      if (!obligatoria) window.CampoForm.limpiar(fecha);
    }

    function telefonoInvalido(campo) {
      return (
        !window.PhoneField.isFieldEmpty(campo) &&
        !window.PhoneField.isFieldValid(campo)
      );
    }

    function marcarCorreo(input) {
      window.CampoForm.marcar(
        input,
        window.EmailValidate.isValid(input) ? '' : window.EmailValidate.ERROR_MSG,
      );
    }

    window.EmailValidate.initField(email);
    window.EmailValidate.initField(correoPersonal);

    if (email) {
      email.addEventListener('input', function () {
        marcarCorreo(email);
        sincronizarFecha();
      });
    }

    if (correoPersonal) {
      correoPersonal.addEventListener('input', function () {
        marcarCorreo(correoPersonal);
        sincronizarFecha();
      });
    }

    telefonoCampos.forEach(function (campo) {
      window.PhoneField.initField(campo);
      var local = campo.querySelector('.phone-field__local');
      if (!local) return;
      local.addEventListener('input', function () {
        window.CampoForm.marcar(
          local,
          telefonoInvalido(campo) ? window.PhoneField.ERROR_MSG : '',
        );
      });
    });

    sincronizarFecha();
    initVistaPreviaCrear(formulario);

    formulario.addEventListener('submit', function (evento) {
      var hayError = false;

      [email, correoPersonal].forEach(function (input) {
        if (!input || window.EmailValidate.isValid(input)) return;
        hayError = true;
        window.CampoForm.marcar(input, window.EmailValidate.ERROR_MSG);
      });

      telefonoCampos.forEach(function (campo) {
        if (!telefonoInvalido(campo)) return;
        hayError = true;
        window.CampoForm.marcar(campo.querySelector('.phone-field__local'), window.PhoneField.ERROR_MSG);
      });

      if (fecha && fecha.required && !String(fecha.value || '').trim()) {
        hayError = true;
        window.CampoForm.marcar(fecha, FECHA_REQUERIDA);
      }

      if (hayError) {
        evento.preventDefault();
        window.CampoForm.enfocarPrimerError(formulario);
        return;
      }
      window.CampoForm.ocuparSubmit(formulario);
    });
  }

  /** El lateral del alta muestra a quién se está creando, como en la edición. */
  function initVistaPreviaCrear(formulario) {
    var nombre = document.getElementById('crear_first_name');
    var apellido = document.getElementById('crear_last_name');
    var avatar = formulario.querySelector('[data-crear-iniciales]');
    var rotulo = formulario.querySelector('[data-crear-nombre]');
    if (!nombre || !apellido || !avatar || !rotulo) return;

    var iconoInicial = avatar.innerHTML;

    function pintar() {
      var n = nombre.value.trim();
      var a = apellido.value.trim();
      var completo = [n, a].filter(Boolean).join(' ');
      rotulo.textContent = completo || 'Nuevo colaborador';
      var iniciales = ((n[0] || '') + (a[0] || '')).toUpperCase();
      if (iniciales) avatar.textContent = iniciales;
      else avatar.innerHTML = iconoInicial;
    }

    nombre.addEventListener('input', pintar);
    apellido.addEventListener('input', pintar);
    formulario.addEventListener('reset', function () { window.setTimeout(pintar, 0); });
  }

  // ── Modal: editar colaborador ────────────────────────────────────────────
  function initModalEditar(config) {
    var overlay = document.getElementById('modalEditarColaborador');
    if (!overlay) return;

    var cuerpo = document.getElementById('modalEditarColaboradorBody');
    var error = document.getElementById('editarColaboradorError');
    var panel = cuerpo.parentNode;

    // El aviso de error vive fuera del hueco que se reemplaza y se muda dentro
    // del formulario una vez cargado; antes de vaciar el hueco vuelve a salir.
    function sacarError() {
      if (error && error.parentNode !== panel) panel.insertBefore(error, cuerpo);
    }

    function meterError() {
      var destino = cuerpo.querySelector('[data-colaborador-alertas]');
      if (error && destino) destino.appendChild(error);
    }
    var CARGANDO = '<p class="modal-loading">Cargando colaborador…</p>';
    var destruirFormulario = null;

    // Abrir y cerrar deprisa deja peticiones en vuelo. Cada apertura se queda
    // con un número, y sólo la última pinta: si no, la respuesta lenta de una
    // ficha anterior sobreescribe la que el usuario está mirando.
    var apertura = 0;

    async function abrir(id, mensaje) {
      var mia = ++apertura;
      sacarError();
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
        meterError();
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
      sacarError();
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

    // Al volver con atrás la página puede restaurarse con el botón girando.
    window.addEventListener('pageshow', function (evento) {
      if (!evento.persisted || !window.CampoForm) return;
      var crear = document.getElementById('formCrearColaborador');
      var editar = document.getElementById('formEditarPersona');
      if (crear) window.CampoForm.restaurarSubmit(crear);
      if (editar) window.CampoForm.restaurarSubmit(editar);
    });

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
