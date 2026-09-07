/**
 * RRHH · Áreas — modales, paleta de color y confirmaciones.
 */
(function () {
  'use strict';

  var POPUP_MS = 4500;
  var HEX = /^#?[0-9a-fA-F]{6}$/;

  function leerConfig() {
    var nodo = document.getElementById('areas-config');
    if (!nodo) return {};
    try {
      return JSON.parse(nodo.textContent) || {};
    } catch (error) {
      console.error('[Áreas] Configuración inicial inválida:', error);
      return {};
    }
  }

  function todos(selector, raiz) {
    return Array.prototype.slice.call((raiz || document).querySelectorAll(selector));
  }

  function normalizarHex(valor, fallback) {
    var raw = String(valor || '').trim();
    if (!HEX.test(raw)) return fallback || '#5a6879';
    return raw.charAt(0) === '#' ? raw.toLowerCase() : '#' + raw.toLowerCase();
  }

  function initPopup() {
    var popup = document.getElementById('popup');
    if (!popup) return;
    var cerrar = function () { popup.classList.remove('show'); };
    var boton = popup.querySelector('[data-popup-close]');
    if (boton) boton.addEventListener('click', cerrar);
    if (popup.classList.contains('show')) window.setTimeout(cerrar, POPUP_MS);
  }

  function marcarSwatch(hex) {
    todos('.area-palette__swatch').forEach(function (btn) {
      btn.classList.toggle('is-selected', normalizarHex(btn.dataset.color, '') === hex);
    });
  }

  function setColorInputs(hex) {
    var picker = document.getElementById('area_color_picker');
    var texto = document.getElementById('area_color');
    var valor = normalizarHex(hex);
    if (picker) picker.value = valor;
    if (texto) texto.value = valor;
    marcarSwatch(valor);
  }

  function initModal(config) {
    var overlay = document.getElementById('modalArea');
    var form = document.getElementById('formArea');
    if (!overlay || !form) return;

    var titulo = document.getElementById('modalAreaTitle');
    var submit = document.getElementById('modalAreaSubmit');
    var nombre = document.getElementById('area_name');
    var defaultColor = config.defaultColor || '#5a6879';

    function abrirCrear() {
      form.action = '/RRHH/areas';
      if (titulo) titulo.textContent = 'Agregar área';
      if (submit) submit.textContent = 'Crear área';
      if (nombre) nombre.value = '';
      setColorInputs(defaultColor);
      if (window.IntranetModal) window.IntranetModal.open(overlay);
      if (nombre) nombre.focus();
    }

    function abrirEditar(datos) {
      form.action = '/RRHH/areas/' + encodeURIComponent(datos.id);
      if (titulo) titulo.textContent = 'Editar área';
      if (submit) submit.textContent = 'Guardar cambios';
      if (nombre) nombre.value = datos.name || '';
      setColorInputs(datos.color || defaultColor);
      if (window.IntranetModal) window.IntranetModal.open(overlay);
      if (nombre) nombre.focus();
    }

    var disparador = document.querySelector('[data-abrir-crear]');
    if (disparador) {
      disparador.addEventListener('click', function () { abrirCrear(); });
    }

    document.addEventListener('click', function (evento) {
      var btn = evento.target && evento.target.closest
        ? evento.target.closest('[data-editar-area]')
        : null;
      if (!btn) return;
      abrirEditar({
        id: btn.dataset.id,
        name: btn.dataset.name,
        color: btn.dataset.color,
      });
    });

    todos('.area-palette__swatch').forEach(function (btn) {
      btn.addEventListener('click', function () {
        setColorInputs(btn.dataset.color);
      });
    });

    var picker = document.getElementById('area_color_picker');
    var texto = document.getElementById('area_color');
    if (picker) {
      picker.addEventListener('input', function () {
        setColorInputs(picker.value);
      });
    }
    if (texto) {
      texto.addEventListener('change', function () {
        setColorInputs(texto.value);
      });
    }

    form.addEventListener('submit', function (evento) {
      var raw = String(texto && texto.value || '').trim();
      if (!HEX.test(raw)) {
        evento.preventDefault();
        if (texto) {
          texto.setCustomValidity('Usa un color hexadecimal de 6 dígitos, por ejemplo #3cb371.');
          texto.reportValidity();
        }
        return;
      }
      if (texto) {
        texto.setCustomValidity('');
        texto.value = normalizarHex(raw);
      }
    });
  }

  function initConfirmaciones() {
    document.addEventListener('submit', function (evento) {
      var form = evento.target;
      if (!form || form.tagName !== 'FORM') return;

      if (form.hasAttribute('data-eliminar-area')) {
        var miembros = Number(form.dataset.miembros || 0);
        if (miembros > 0) {
          evento.preventDefault();
          return;
        }
        if (!window.confirm('¿Eliminar el área «' + (form.dataset.eliminarArea || '') + '»?')) {
          evento.preventDefault();
        }
        return;
      }

      if (form.hasAttribute('data-quitar-miembro')) {
        if (!window.confirm('¿Quitar a ' + (form.dataset.quitarMiembro || 'este colaborador') + ' de esta área?')) {
          evento.preventDefault();
        }
        return;
      }

      if (form.hasAttribute('data-agregar-miembro')) {
        var select = form.querySelector('select[name="user_id"]');
        var option = select && select.selectedOptions && select.selectedOptions[0];
        if (!option || !option.value) return;
        var areaActual = option.getAttribute('data-area-actual') || '';
        if (!areaActual) return;
        var nombre = option.getAttribute('data-nombre') || 'Este colaborador';
        if (!window.confirm(nombre + ' está en «' + areaActual + '». ¿Moverlo a esta área?')) {
          evento.preventDefault();
        }
      }
    });
  }

  function initMoverMiembro(config) {
    var overlay = document.getElementById('modalMoverMiembro');
    var form = document.getElementById('formMoverMiembro');
    var select = document.getElementById('target_area_id');
    var subtitle = document.getElementById('modalMoverSubtitle');
    var titulo = document.getElementById('modalMoverTitle');
    var submit = document.getElementById('modalMoverSubmit');
    var hiddenUser = document.getElementById('mover_user_id');
    if (!overlay || !form || !select) return;

    var areas = Array.isArray(config.areas) ? config.areas : [];
    var estado = { nombre: '', areaName: '', areaId: '', userId: '' };

    function llenarDestinos(areaActualId) {
      var actual = String(areaActualId || '');
      select.innerHTML = '';
      var placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = 'Selecciona un área…';
      select.appendChild(placeholder);
      areas.forEach(function (area) {
        if (String(area.id) === actual) return;
        var option = document.createElement('option');
        option.value = area.id;
        option.textContent = area.area_name || ('Área ' + area.id);
        select.appendChild(option);
      });
    }

    document.addEventListener('click', function (evento) {
      var btn = evento.target && evento.target.closest
        ? evento.target.closest('[data-mover-miembro]')
        : null;
      if (!btn || btn.disabled) return;
      var userId = btn.dataset.userId;
      if (!userId) return;

      estado.userId = userId;
      estado.areaId = btn.dataset.areaId || '';
      estado.nombre = btn.dataset.nombre || 'este colaborador';
      estado.areaName = btn.dataset.areaName || '';
      if (hiddenUser) hiddenUser.value = userId;

      if (estado.areaId) {
        form.action = '/RRHH/areas/' + encodeURIComponent(estado.areaId) +
          '/miembros/' + encodeURIComponent(userId) + '/mover';
        if (titulo) titulo.textContent = 'Cambiar de área';
        if (submit) submit.textContent = 'Mover';
      } else {
        form.action = '#';
        if (titulo) titulo.textContent = 'Asignar área';
        if (submit) submit.textContent = 'Asignar';
      }

      llenarDestinos(estado.areaId);
      if (subtitle) {
        subtitle.textContent = estado.areaName
          ? estado.nombre + ' está en «' + estado.areaName + '». Elige el área de destino.'
          : 'Elige el área para ' + estado.nombre + '.';
      }
      if (window.IntranetModal) window.IntranetModal.open(overlay);
      select.focus();
    });

    form.addEventListener('submit', function (evento) {
      var option = select.selectedOptions && select.selectedOptions[0];
      if (!option || !option.value) return;
      var destino = option.textContent || 'esa área';
      if (!estado.areaId) {
        form.action = '/RRHH/areas/' + encodeURIComponent(option.value) + '/miembros';
      }
      var mensaje = estado.areaName
        ? '¿Mover a ' + estado.nombre + ' de «' + estado.areaName + '» a «' + destino + '»?'
        : '¿Asignar a ' + estado.nombre + ' a «' + destino + '»?';
      if (!window.confirm(mensaje)) {
        evento.preventDefault();
      }
    });
  }

  function init() {
    var config = leerConfig();
    initPopup();
    initConfirmaciones();
    if (config.puedeEditar) {
      initModal(config);
      initMoverMiembro(config);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
