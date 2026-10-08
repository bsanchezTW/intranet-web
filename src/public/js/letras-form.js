/* Formulario de emisión de letras de cambio (/letras/nueva).
 *
 *  - Arma el cronograma (cuotas iguales, céntimos sobrantes en la última) a
 *    partir del total, la cantidad, el primer vencimiento y el intervalo.
 *  - Muestra el número que tendrá cada letra.
 *  - Completa los datos del aceptante si ya se le emitieron letras.
 *
 * El servidor valida todo de nuevo: esto sólo ahorra tipeo y errores.
 */
(function () {
  'use strict';

  var form = document.getElementById('letrasForm');
  if (!form) return;

  var $ = function (id) { return document.getElementById(id); };
  var total = $('total_amount');
  var count = $('installments_count');
  var firstDue = $('first_due_date');
  var interval = $('interval_days');
  var issueDate = $('issue_date');
  var startNumber = $('start_number');
  var currencySymbol = form.dataset.currencySymbol || '';
  var body = $('cuotasBody');
  var totalLabel = $('cronogramaTotal');
  var siguienteLibre = $('siguienteLibre');
  var maxCuotas = Number(form.dataset.maxCuotas) || 36;

  var nextByYear = {};
  nextByYear[form.dataset.nextYear] = Number(form.dataset.nextSeq);
  // Si el usuario eligió el primer vencimiento a mano, cambiar el giro no lo pisa.
  var firstDueTouched = !!firstDue.value && firstDue.value !== addDays(issueDate.value, Number(interval.value) || 30);

  function addDays(iso, days) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
    if (!m) return '';
    var d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function toCents(value) {
    var n = Number(String(value || '').replace(/,/g, ''));
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) : 0;
  }

  function money(cents) {
    var text = (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return (currencySymbol ? currencySymbol + ' ' : '') + text;
  }

  function pad(n) { return String(n).padStart(5, '0'); }

  function year() {
    var y = Number(String(issueDate.value || '').slice(0, 4));
    return y >= 2000 && y <= 2100 ? y : null;
  }

  function placeholderRow(text) {
    body.innerHTML = '';
    var tr = document.createElement('tr');
    tr.className = 'letras-tabla__vacio';
    var td = document.createElement('td');
    td.colSpan = 4;
    td.textContent = text;
    tr.appendChild(td);
    body.appendChild(tr);
  }

  function rows() {
    return Array.prototype.filter.call(body.rows, function (tr) {
      return !tr.classList.contains('letras-tabla__vacio');
    });
  }

  function buildRow(i, due, cents) {
    var tr = document.createElement('tr');
    tr.innerHTML =
      '<td>' + (i + 1) + '</td>' +
      '<td class="letras-cuota-num">—</td>' +
      '<td><input type="date" name="cuotas[' + i + '][due_date]" aria-label="Vencimiento de la letra ' + (i + 1) + '"></td>' +
      '<td class="num"><input type="number" name="cuotas[' + i + '][amount]" min="0.01" step="0.01" inputmode="decimal" aria-label="Importe de la letra ' + (i + 1) + '"></td>';
    tr.querySelector('input[type="date"]').value = due;
    tr.querySelector('input[type="number"]').value = (cents / 100).toFixed(2);
    return tr;
  }

  function regenerate() {
    var cents = toCents(total.value);
    var n = Math.floor(Number(count.value));
    var gap = Math.floor(Number(interval.value)) || 30;
    var first = firstDue.value;
    if (!cents || !n || n < 1) {
      placeholderRow('Ingresa el importe total y el número de letras.');
      refresh();
      return;
    }
    if (n > maxCuotas) {
      placeholderRow('Máximo ' + maxCuotas + ' letras por emisión.');
      refresh();
      return;
    }
    if (!first) {
      placeholderRow('Indica el primer vencimiento.');
      refresh();
      return;
    }
    if (cents < n) {
      placeholderRow('El importe no alcanza para tantas letras.');
      refresh();
      return;
    }
    var base = Math.floor(cents / n);
    var resto = cents - base * n;
    body.innerHTML = '';
    for (var i = 0; i < n; i += 1) {
      body.appendChild(buildRow(i, addDays(first, i * gap), i === n - 1 ? base + resto : base));
    }
    refresh();
  }

  function refreshTotal() {
    var list = rows();
    if (!list.length) {
      totalLabel.textContent = '';
      totalLabel.classList.remove('is-descuadre');
      return;
    }
    var suma = list.reduce(function (acc, tr) {
      return acc + toCents(tr.querySelector('input[type="number"]').value);
    }, 0);
    var esperado = toCents(total.value);
    var descuadre = esperado && suma !== esperado;
    totalLabel.textContent = descuadre
      ? 'Las cuotas suman ' + money(suma) + ' y el total es ' + money(esperado)
      : list.length + (list.length === 1 ? ' letra · ' : ' letras · ') + money(suma);
    totalLabel.classList.toggle('is-descuadre', !!descuadre);
  }

  function refreshNumbers() {
    var y = year();
    var manual = Math.floor(Number(startNumber.value));
    var cells = body.querySelectorAll('.letras-cuota-num');
    if (!y) {
      cells.forEach(function (td) { td.textContent = '—'; });
      return;
    }
    var start = manual > 0 ? manual : nextByYear[y];
    if (!start) {
      cells.forEach(function (td) { td.textContent = '…'; });
      fetch('/letras/api/siguiente?anio=' + y, { headers: { Accept: 'application/json' } })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (data) {
          if (data && data.seq) {
            nextByYear[y] = data.seq;
            refreshNumbers();
          }
        })
        .catch(function () {});
      return;
    }
    if (siguienteLibre && nextByYear[y]) siguienteLibre.textContent = 'LT-' + pad(nextByYear[y]) + '-' + y;
    startNumber.placeholder = nextByYear[y] || '';
    cells.forEach(function (td, i) { td.textContent = 'LT-' + pad(start + i) + '-' + y; });
  }

  function refresh() {
    refreshTotal();
    refreshNumbers();
  }

  [total, count, interval].forEach(function (el) { el.addEventListener('input', regenerate); });
  firstDue.addEventListener('input', function () {
    firstDueTouched = true;
    regenerate();
  });
  issueDate.addEventListener('change', function () {
    if (!firstDueTouched && issueDate.value) {
      firstDue.value = addDays(issueDate.value, Math.floor(Number(interval.value)) || 30);
      regenerate();
    } else {
      refreshNumbers();
    }
  });
  startNumber.addEventListener('input', refreshNumbers);
  body.addEventListener('input', refreshTotal);

  // Al volver con errores del servidor se respetan las cuotas que ya traía.
  if (rows().length) refresh();
  else regenerate();

  form.addEventListener('submit', async function (event) {
    if (form.dataset.confirmado === '1') return;
    if (!totalLabel.classList.contains('is-descuadre')) return;
    event.preventDefault();
    var ok = window.IntranetDialog
      ? await window.IntranetDialog.confirm({
          title: 'Las cuotas no suman el total',
          message: totalLabel.textContent + '. Se emitirán las letras con los importes de cada cuota.',
          acceptLabel: 'Emitir igual',
        })
      : window.confirm(totalLabel.textContent + '. ¿Emitir igual?');
    if (!ok) return;
    form.dataset.confirmado = '1';
    form.submit();
  });

  // --- Aceptante conocido ----------------------------------------------------
  var doc = $('acceptor_doc');
  var ayuda = $('aceptanteAyuda');
  var ayudaOriginal = ayuda ? ayuda.textContent : '';
  var ultimoBuscado = '';

  var CAMPOS = [
    'acceptor_name', 'acceptor_address', 'acceptor_locality', 'acceptor_phone',
    'guarantor_name', 'guarantor_doc', 'guarantor_address', 'guarantor_locality', 'guarantor_phone',
    'bank_name', 'bank_office', 'bank_account', 'bank_dc',
  ];

  function buscarAceptante() {
    var valor = doc.value.replace(/\D/g, '');
    if ((valor.length !== 8 && valor.length !== 11) || valor === ultimoBuscado) return;
    ultimoBuscado = valor;
    fetch('/letras/api/aceptante?doc=' + valor, { headers: { Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data) {
          if (ayuda) ayuda.textContent = 'Aceptante nuevo: completa sus datos.';
          return;
        }
        var completados = 0;
        CAMPOS.forEach(function (campo) {
          var input = $(campo);
          if (input && !input.value && data[campo]) {
            input.value = data[campo];
            completados += 1;
          }
        });
        if (data.guarantor_name || data.guarantor_doc) {
          var panel = $('guarantor_name').closest('details');
          if (panel) panel.open = true;
        }
        if (data.bank_name || data.bank_account) {
          var panelCuenta = $('bank_name').closest('details');
          if (panelCuenta) panelCuenta.open = true;
        }
        if (ayuda) {
          ayuda.textContent = completados
            ? 'Datos completados desde la última letra emitida (' + data.acceptor_name + '). Revísalos.'
            : ayudaOriginal;
        }
      })
      .catch(function () {});
  }

  doc.addEventListener('change', buscarAceptante);
  doc.addEventListener('input', function () {
    var valor = doc.value.replace(/\D/g, '');
    if (valor.length === 11) buscarAceptante();
  });
})();
