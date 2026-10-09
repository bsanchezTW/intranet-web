/**
 * RRHH · Organigrama en modo edición — modales de área, paleta de color,
 * área superior y confirmaciones.
 */
(function () {
  'use strict';

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

  /**
   * Cualquier colaborador puede dirigir un área, también si trabaja en otra.
   * Se agrupa para que lo habitual quede arriba: primero la gente del área,
   * después quienes ya dirigen otras áreas (gerentes) y al final el resto.
   */
  function llenarJefes(area, areas, personas) {
    var select = document.getElementById('area_manager');
    if (!select) return;

    var miembros = {};
    ((area && area.members) || []).forEach(function (id) { miembros[String(id)] = true; });
    var dirige = {};
    areas.forEach(function (a) {
      if (!a.manager_user_id || (area && String(a.id) === String(area.id))) return;
      var clave = String(a.manager_user_id);
      (dirige[clave] = dirige[clave] || []).push(a.area_name);
    });

    var grupos = [
      { label: 'De esta área', items: [] },
      { label: 'Ya dirigen otras áreas', items: [] },
      { label: 'Otros colaboradores', items: [] },
    ];
    personas.forEach(function (p) {
      var id = String(p.id);
      var otras = dirige[id];
      var texto = (p.nombre || ('Usuario ' + p.id)) + (p.disponible === false ? ' (deshabilitado)' : '');
      if (miembros[id]) {
        grupos[0].items.push({ id: id, texto: otras ? texto + ' · dirige ' + otras.join(', ') : texto });
      } else if (otras) {
        grupos[1].items.push({ id: id, texto: texto + ' · dirige ' + otras.join(', ') });
      } else {
        grupos[2].items.push({ id: id, texto: texto + ' · ' + (p.area || 'Sin área') });
      }
    });

    select.innerHTML = '';
    var vacio = document.createElement('option');
    vacio.value = '';
    vacio.textContent = 'Sin jefe asignado';
    select.appendChild(vacio);

    grupos.forEach(function (grupo) {
      if (!grupo.items.length) return;
      var optgroup = document.createElement('optgroup');
      optgroup.label = grupo.label;
      grupo.items.forEach(function (item) {
        var option = document.createElement('option');
        option.value = item.id;
        option.textContent = item.texto;
        optgroup.appendChild(option);
      });
      select.appendChild(optgroup);
    });

    select.value = area && area.manager_user_id ? String(area.manager_user_id) : '';
  }

  /** Ids de las áreas que dependen de `areaId`, a cualquier profundidad. */
  function descendientes(areas, areaId) {
    var hijos = {};
    areas.forEach(function (a) {
      if (a.parent_area_id == null) return;
      var clave = String(a.parent_area_id);
      (hijos[clave] = hijos[clave] || []).push(String(a.id));
    });
    var encontrados = {};
    var pila = (hijos[String(areaId)] || []).slice();
    while (pila.length) {
      var id = pila.pop();
      if (encontrados[id] || id === String(areaId)) continue;
      encontrados[id] = true;
      pila.push.apply(pila, hijos[id] || []);
    }
    return encontrados;
  }

  /**
   * Opciones del área superior en orden de árbol, con sangría por nivel. Se
   * excluyen el área misma y todas sus dependientes: colgarla de una de ellas
   * cerraría un ciclo (el servidor también lo rechaza).
   */
  function llenarPadres(areas, areaId, seleccion) {
    var select = document.getElementById('area_parent');
    if (!select) return;

    var excluir = areaId != null ? descendientes(areas, areaId) : {};
    if (areaId != null) excluir[String(areaId)] = true;

    var existentes = {};
    areas.forEach(function (a) { existentes[String(a.id)] = true; });
    var hijos = {};
    var raices = [];
    areas.forEach(function (a) {
      var padre = a.parent_area_id != null ? String(a.parent_area_id) : null;
      if (padre && existentes[padre]) {
        (hijos[padre] = hijos[padre] || []).push(a);
      } else {
        raices.push(a);
      }
    });
    // Mismo orden que el organigrama (compareAreas en services/workAreaTree).
    var porNombre = function (x, y) {
      var ox = x.sort_order != null ? Number(x.sort_order) : null;
      var oy = y.sort_order != null ? Number(y.sort_order) : null;
      if (ox != null || oy != null) {
        if (ox == null) return 1;
        if (oy == null) return -1;
        if (ox !== oy) return ox - oy;
      }
      return String(x.area_name || '').localeCompare(String(y.area_name || ''), 'es');
    };

    select.innerHTML = '';
    var ninguna = document.createElement('option');
    ninguna.value = '';
    ninguna.textContent = 'Ninguna (área principal)';
    select.appendChild(ninguna);

    var vistos = {};
    function agregar(area, nivel) {
      var id = String(area.id);
      if (vistos[id]) return;
      vistos[id] = true;
      if (!excluir[id]) {
        var option = document.createElement('option');
        option.value = id;
        option.textContent = new Array(nivel + 1).join('\u2003') + (nivel ? '\u2514 ' : '') + area.area_name;
        select.appendChild(option);
      }
      (hijos[id] || []).sort(porNombre).forEach(function (h) { agregar(h, nivel + 1); });
    }
    raices.sort(porNombre).forEach(function (r) { agregar(r, 0); });

    select.value = seleccion != null && !excluir[String(seleccion)] ? String(seleccion) : '';
  }

  function initModal(config) {
    var overlay = document.getElementById('modalArea');
    var form = document.getElementById('formArea');
    if (!overlay || !form) return;

    var titulo = document.getElementById('modalAreaTitle');
    var submit = document.getElementById('modalAreaSubmit');
    var nombre = document.getElementById('area_name');
    var orden = document.getElementById('area_orden');
    var defaultColor = config.defaultColor || '#5a6879';
    var areas = Array.isArray(config.areas) ? config.areas : [];
    var personas = Array.isArray(config.personas) ? config.personas : [];

    function buscarArea(id) {
      var buscado = String(id);
      for (var i = 0; i < areas.length; i += 1) {
        if (String(areas[i].id) === buscado) return areas[i];
      }
      return null;
    }

    function abrirCrear(padreId) {
      form.action = '/RRHH/areas';
      var padre = padreId ? buscarArea(padreId) : null;
      if (titulo) {
        titulo.textContent = padre ? 'Agregar área dependiente de ' + padre.area_name : 'Agregar área';
      }
      if (submit) submit.textContent = 'Crear área';
      if (nombre) nombre.value = '';
      if (orden) orden.value = '';
      llenarJefes(null, areas, personas);
      llenarPadres(areas, null, padre ? padre.id : null);
      setColorInputs(defaultColor);
      if (window.IntranetModal) window.IntranetModal.open(overlay);
      if (nombre) nombre.focus();
    }

    function abrirEditar(datos) {
      form.action = '/RRHH/areas/' + encodeURIComponent(datos.id);
      if (titulo) titulo.textContent = 'Editar área';
      if (submit) submit.textContent = 'Guardar cambios';
      if (nombre) nombre.value = datos.name || '';
      if (orden) orden.value = datos.orden || '';
      llenarJefes(buscarArea(datos.id), areas, personas);
      llenarPadres(areas, datos.id, datos.parent || null);
      setColorInputs(datos.color || defaultColor);
      if (window.IntranetModal) window.IntranetModal.open(overlay);
      if (nombre) nombre.focus();
    }

    var disparador = document.querySelector('[data-abrir-crear]');
    if (disparador) {
      disparador.addEventListener('click', function () { abrirCrear(null); });
    }

    document.addEventListener('click', function (evento) {
      if (!evento.target || !evento.target.closest) return;
      var hija = evento.target.closest('[data-agregar-hija]');
      if (hija) {
        abrirCrear(hija.dataset.agregarHija);
        return;
      }
      var btn = evento.target.closest('[data-editar-area]');
      if (!btn) return;
      abrirEditar({
        id: btn.dataset.id,
        name: btn.dataset.name,
        color: btn.dataset.color,
        parent: btn.dataset.parent,
        orden: btn.dataset.orden,
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

  /**
   * Eliminar el área es lo único que se confirma desde la tarjeta: quitar o
   * agregar colaboradores ocurre dentro de los modales de ac-cards.js, que
   * trae sus propias confirmaciones.
   */
  function initConfirmaciones() {
    document.addEventListener('submit', function (evento) {
      var form = evento.target;
      if (!form || form.tagName !== 'FORM') return;
      if (!form.hasAttribute('data-eliminar-area')) return;

      // Un área con gente o con áreas dependientes no se borra: el botón ya
      // viene deshabilitado, esto sólo cubre el envío por teclado.
      if (form.dataset.bloqueada === 'true') {
        evento.preventDefault();
        return;
      }
      window.IntranetDialog.confirmarEnvio(evento, {
        title: '¿Eliminar el área?',
        message: 'Se eliminará el área «' + (form.dataset.eliminarArea || '') + '». Esta acción no se puede deshacer.',
        acceptLabel: 'Eliminar',
        tone: 'peligro',
      });
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
        ? estado.nombre + ' pasará de «' + estado.areaName + '» a «' + destino + '».'
        : estado.nombre + ' quedará en «' + destino + '».';
      window.IntranetDialog.confirmarEnvio(evento, {
        title: estado.areaName ? '¿Cambiar de área?' : '¿Asignar área?',
        message: mensaje,
        acceptLabel: estado.areaName ? 'Mover' : 'Asignar',
      });
    });
  }

  function init() {
    var config = leerConfig();
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
