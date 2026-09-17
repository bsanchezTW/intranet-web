/* Formulario del centro de gastos, en un modal de Mis solicitudes.
   Un solo modal para rendiciones y solicitudes de fondos, que además guarda y
   retoma borradores. El total, el saldo, el período y el número de la
   CuentaRUT que se muestran aquí son conveniencias: el servidor los recalcula
   y nunca confía en lo que llegue del cliente. */
(function () {
  "use strict";

  var overlay = document.getElementById("modalGasto");
  if (!overlay || !window.IntranetModal) return;

  function byId(id) {
    return document.getElementById(id);
  }

  function todos(selector, raiz) {
    return Array.prototype.slice.call((raiz || document).querySelectorAll(selector));
  }

  var form = byId("formGasto");
  var cuerpoModal = overlay.querySelector(".gasto-modal__body");
  var tituloModal = byId("modalGastoTitulo");
  var estadoModal = byId("modalGastoEstado");
  var contenedor = byId("gastoItems");
  var plantilla = byId("plantillaFila");
  var btnAgregar = byId("btnAgregarFila");
  var totalEl = byId("totalCalculado");
  var adjuntoInput = byId("adjuntoInput");
  var dropzone = byId("dropzone");
  var listaAdjuntos = byId("listaAdjuntos");
  var errorEl = byId("formError");
  var btnEnviar = byId("btnEnviar");
  var btnBorrador = byId("btnGuardarBorrador");
  var btnEliminarBorrador = byId("btnEliminarBorrador");
  var campoTitulo = byId("titulo");
  var periodoDesde = byId("periodoDesde");
  var periodoHasta = byId("periodoHasta");
  var fondoAsignadoValor = byId("fondoAsignadoValor");
  var avisoFondo = byId("avisoFondo");
  var saldoEtiqueta = byId("saldoEtiqueta");
  var saldoValor = byId("saldoValor");
  // Con un solo centro asignado el id viaja en un hidden; con dos, en radios.
  var centroHidden = byId("centroCostoValor");

  var HOY = form.dataset.hoy;
  var MAX_BYTES = Number(form.dataset.maxMb || 20) * 1024 * 1024;
  var DECIMALES = Number(form.dataset.decimales || 0);
  var MAX_FILAS = 50;
  var MAX_ADJUNTOS = 50;
  var CATEGORIA_CON_DIAS = "hospedaje";
  var CATEGORIA_COMBUSTIBLE = "combustible";
  var TITULOS = { rendicion: "Rendición de gastos", fondos: "Solicitud de fondos" };

  var estado = {
    kind: "rendicion",
    borradorId: null,
    // Hay cambios que se perderían al cerrar.
    sucio: false,
    // Se guardó o borró algo: la lista de detrás ya no está al día.
    listaDesactualizada: false,
    ocupado: false,
  };

  // Comprobantes de esta sesión. En fondos van sueltos; en rendición, cada
  // línea tiene los suyos (por clave). Los nuevos se quedan en el navegador
  // (File + blob) hasta guardar o enviar; los del borrador ya tienen url
  // /content y public_id.
  var adjuntos = [];
  var adjuntosPorClave = {};
  var itemKeySeq = 0;
  var destinoAdjunto = "";

  /* Subidos al bucket en este guardado, todavía no persistidos. Si el POST
     falla o el usuario cierra, se borran. Los del borrador los administra
     el servidor. */
  var subidosSinGuardar = [];

  var JSON_HEADERS = {
    "Content-Type": "application/json",
    Accept: "application/json",
    "X-Requested-With": "fetch",
  };

  function mensajeDeRed(err, fallback) {
    var msg = err && err.message ? String(err.message) : "";
    if (/NetworkError|Failed to fetch|Load failed|network error/i.test(msg)) {
      return "No se pudo conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.";
    }
    return msg || fallback || "No se pudo completar la operación.";
  }

  function leerRespuestaJson(res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (res.status === 401) {
        throw new Error("Tu sesión expiró. Recarga la página e inicia sesión.");
      }
      return data;
    });
  }

  function descartarArchivos(refs, alSalir) {
    if (!refs.length) return;
    var cuerpo = JSON.stringify({ refs: refs });
    // Al abandonar la página un fetch normal se cancela; el beacon no.
    if (alSalir && navigator.sendBeacon) {
      navigator.sendBeacon("/gastos/adjuntos/descartar", new Blob([cuerpo], { type: "application/json" }));
      return;
    }
    fetch("/gastos/adjuntos/descartar", {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: cuerpo,
      keepalive: true,
    }).catch(function () {});
  }

  function descartarPendientes(alSalir) {
    var refs = subidosSinGuardar;
    subidosSinGuardar = [];
    descartarArchivos(refs, alSalir);
  }

  // ── Montos ───────────────────────────────────────────────────────────────

  /* Acepta "45.000" y "45000,50": se descartan los separadores de miles y la
     coma se trata como decimal. Es la misma normalización que hace el servidor
     en expenseRequestService.parseAmount. */
  function parseMonto(valor) {
    var raw = String(valor || "").trim();
    if (!raw) return 0;
    var n = Number(
      raw.replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."),
    );
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }

  function agruparMiles(digitos) {
    return digitos.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  }

  /* El símbolo de la moneda sale del total que el servidor ya pintó en el
     HTML, así no hay que duplicar la config de país en el cliente. */
  var MOLDE = totalEl.textContent;
  function formatearMoneda(valor) {
    var partes = MOLDE.match(/^([^\d]*)/);
    var prefijo = partes ? partes[1] : "";
    var numero = valor.toFixed(DECIMALES);
    var enteros = agruparMiles(numero.split(".")[0]);
    var resto = DECIMALES ? "," + numero.split(".")[1] : "";
    return prefijo + enteros + resto;
  }

  /* En monedas sin decimales el monto se deja con puntos de miles al salir del
     campo: "45000" se lee "45.000". Con decimales se respeta lo tecleado. */
  function formatearCampoMonto(input) {
    if (DECIMALES) return;
    var digitos = input.value.replace(/\D/g, "").replace(/^0+(?=\d)/, "");
    input.value = digitos ? agruparMiles(digitos) : "";
  }

  /* Monto guardado ("64990.00") tal como se escribiría en el campo. Una línea
     de borrador sin monto llega como null y queda vacía; un 0 escrito, como 0. */
  function montoParaCampo(valor) {
    if (valor === null || valor === undefined || valor === "") return "";
    var n = Number(valor);
    if (!Number.isFinite(n)) return "";
    return DECIMALES ? String(n).replace(".", ",") : agruparMiles(String(Math.round(n)));
  }

  function recalcular() {
    var total = 0;
    todos('[data-campo="amount"]', contenedor).forEach(function (input) {
      total += parseMonto(input.value);
    });
    totalEl.textContent = formatearMoneda(total);

    /* Saldo = gastado - asignado. Positivo: la empresa le paga al colaborador;
       negativo: el colaborador devuelve lo que sobró. El servidor lo recalcula. */
    if (estado.kind !== "rendicion") return;
    var asignado = montoFondoElegido();
    fondoAsignadoValor.textContent = asignado === null ? "Sin fondo" : formatearMoneda(asignado);
    var saldo = Math.round((total - (asignado || 0)) * 100) / 100;
    saldoEtiqueta.textContent = saldo < 0 ? "Debes devolver" : saldo > 0 ? "Te reembolsan" : "Sin saldo";
    saldoValor.textContent = formatearMoneda(Math.abs(saldo));
  }

  // ── Filas del desglose ───────────────────────────────────────────────────

  function fijarCampo(fila, campo, valor) {
    var el = fila.querySelector('[data-campo="' + campo + '"]');
    if (el) el.value = valor === null || valor === undefined ? "" : String(valor);
  }

  function agregarFila(foco, datos) {
    if (todos(".gasto-item-fila", contenedor).length >= MAX_FILAS) return null;
    contenedor.appendChild(plantilla.content.cloneNode(true));
    var filas = todos(".gasto-item-fila", contenedor);
    var fila = filas[filas.length - 1];

    // En una rendición los gastos ya ocurrieron; en fondos son estimados.
    var fecha = fila.querySelector('[data-campo="item_date"]');
    if (estado.kind === "rendicion") fecha.max = HOY;

    if (datos) {
      fijarCampo(fila, "item_date", datos.item_date);
      fijarCampo(fila, "category", datos.category);
      fijarCampo(fila, "detail", datos.detail);
    }
    sincronizarCategoria(fila);
    if (datos && datos.days) fijarCampo(fila, "days", datos.days);
    if (datos && datos.details) {
      fijarCampo(fila, "yield_km_l", decimalParaCampo(datos.details.yield_km_l));
      fijarCampo(fila, "distance_km", decimalParaCampo(datos.details.distance_km));
      fijarCampo(fila, "price_per_liter", montoParaCampo(datos.details.price_per_liter));
    }
    pintarCombustible(fila);
    if (datos) {
      var tieneMonto = datos.amount !== null && datos.amount !== undefined && datos.amount !== "";
      var categoria = valorDe(fila, "category");
      if (tieneMonto && categoria !== CATEGORIA_COMBUSTIBLE) {
        fijarCampo(fila, "amount", montoParaCampo(datos.amount));
      }
    }

    if (datos && datos.key) fila.dataset.key = String(datos.key);
    claveFila(fila);
    aplicarSoloFila(fila);
    if (datos && Array.isArray(datos.attachments)) {
      adjuntosPorClave[claveFila(fila)] = datos.attachments.map(function (a) {
        return { name: a.name, url: a.url, public_id: a.public_id };
      });
    }
    pintarAdjuntosFila(fila);

    actualizarBotonesQuitar();
    if (foco) {
      var primerCampo = fila.querySelector("input, select");
      if (primerCampo) primerCampo.focus();
    }
    return fila;
  }

  /* Con una sola fila el botón de quitar no tiene sentido: dejaría el desglose
     vacío, que es justo lo que el servidor rechaza. */
  function actualizarBotonesQuitar() {
    var filas = todos(".gasto-item-fila", contenedor);
    filas.forEach(function (fila) {
      var btn = fila.querySelector("[data-quitar-fila]");
      if (btn) btn.disabled = filas.length <= 1;
    });
  }

  function decimalParaCampo(valor) {
    if (valor === null || valor === undefined || valor === "") return "";
    var n = Number(valor);
    if (!Number.isFinite(n)) return "";
    return String(n).replace(".", ",");
  }

  function parseDecimalCampo(valor) {
    if (!String(valor || "").trim()) return null;
    var n = parseMonto(valor);
    return n > 0 ? n : null;
  }

  function litrosDe(rendimiento, distancia) {
    if (!rendimiento || !distancia) return null;
    return Math.round((distancia / rendimiento) * 100) / 100;
  }

  function redondearMoneda(valor) {
    var factor = Math.pow(10, DECIMALES);
    return Math.round(valor * factor) / factor;
  }

  function montoSugeridoCombustible(fila) {
    var litros = litrosDe(
      parseDecimalCampo(valorDe(fila, "yield_km_l")),
      parseDecimalCampo(valorDe(fila, "distance_km")),
    );
    var precio = parseDecimalCampo(valorDe(fila, "price_per_liter"));
    if (litros == null || !precio) return null;
    return redondearMoneda(litros * precio);
  }

  function fijarMontoCombustible(fila, bloquear) {
    var monto = fila.querySelector('[data-campo="amount"]');
    if (!monto) return;
    monto.readOnly = !!bloquear;
    monto.tabIndex = bloquear ? -1 : 0;
    if (bloquear) monto.setAttribute("aria-readonly", "true");
    else monto.removeAttribute("aria-readonly");
  }

  function pintarCombustible(fila) {
    if (!fila) return;
    var monto = fila.querySelector('[data-campo="amount"]');
    if (!monto || !monto.readOnly) return;
    var sugerido = montoSugeridoCombustible(fila);
    monto.value = sugerido != null ? montoParaCampo(sugerido) : "";
  }

  /* Hospedaje y combustible despliegan un panel extra bajo la línea; el resto
     no pide nada más que fecha, categoría, detalle y monto. En combustible el
     monto lo calculan los tres campos extra: no se escribe a mano. */
  function sincronizarCategoria(fila) {
    var categoria = fila.querySelector('[data-campo="category"]');
    var valor = categoria ? categoria.value : "";
    var conDias = valor === CATEGORIA_CON_DIAS;
    var conCombustible = valor === CATEGORIA_COMBUSTIBLE;

    fila.classList.toggle("gasto-item-fila--extra", conDias || conCombustible);

    var extra = fila.querySelector("[data-extra]");
    var extraCombustible = fila.querySelector("[data-extra-combustible]");
    var extraHospedaje = fila.querySelector("[data-extra-hospedaje]");
    if (extra) extra.hidden = !(conDias || conCombustible);
    if (extraCombustible) extraCombustible.hidden = !conCombustible;
    if (extraHospedaje) extraHospedaje.hidden = !conDias;

    var dias = fila.querySelector('[data-campo="days"]');
    if (dias && !conDias) dias.value = "";

    fijarMontoCombustible(fila, conCombustible);
    if (!conCombustible) {
      ["yield_km_l", "distance_km", "price_per_liter"].forEach(function (campo) {
        var input = fila.querySelector('[data-campo="' + campo + '"]');
        if (input) input.value = "";
      });
    } else {
      pintarCombustible(fila);
    }

    var detalle = fila.querySelector('[data-campo="detail"]');
    if (detalle) {
      detalle.placeholder = conCombustible
        ? "Ej: Copec Ruta 5 · patente ABCD12"
        : conDias
          ? "Ej: Hotel Antofagasta"
          : "Ej: Disco SSD 1 TB";
    }
  }

  contenedor.addEventListener("input", function (e) {
    var campo = e.target.dataset.campo;
    if (campo === "amount") {
      if (e.target.readOnly) return;
      recalcular();
    }
    if (campo === "yield_km_l" || campo === "distance_km" || campo === "price_per_liter") {
      pintarCombustible(e.target.closest(".gasto-item-fila"));
      recalcular();
    }
  });

  contenedor.addEventListener("focusout", function (e) {
    if (e.target.dataset.campo === "amount") formatearCampoMonto(e.target);
  });

  contenedor.addEventListener("change", function (e) {
    var campo = e.target.dataset.campo;
    if (campo === "item_date") derivarPeriodo();
    if (campo !== "category") return;
    var fila = e.target.closest(".gasto-item-fila");
    sincronizarCategoria(fila);
    if (e.target.value === CATEGORIA_CON_DIAS) {
      var dias = fila.querySelector('[data-campo="days"]');
      if (dias) dias.focus();
    }
    if (e.target.value === CATEGORIA_COMBUSTIBLE) {
      var rendimiento = fila.querySelector('[data-campo="yield_km_l"]');
      if (rendimiento) rendimiento.focus();
    }
    recalcular();
  });

  contenedor.addEventListener("click", function (e) {
    var adjuntar = e.target.closest("[data-adjuntar]");
    if (adjuntar) {
      e.preventDefault();
      if (estado.ocupado) return;
      destinoAdjunto = claveFila(adjuntar.closest(".gasto-item-fila"));
      adjuntoInput.click();
      return;
    }
    var btn = e.target.closest("[data-quitar-fila]");
    if (!btn || btn.disabled) return;
    var fila = btn.closest(".gasto-item-fila");
    soltarAdjuntosFila(fila);
    fila.remove();
    actualizarBotonesQuitar();
    recalcular();
    derivarPeriodo();
    marcarSucio();
  });

  btnAgregar.addEventListener("click", function () {
    agregarFila(true);
  });

  // ── Fondo que se rinde ───────────────────────────────────────────────────

  function fondoElegido() {
    return form.querySelector('input[name="fund_request_id"]:checked');
  }

  function hayFondosPorRendir() {
    return !!form.querySelector('input[name="fund_request_id"]');
  }

  /* Monto del fondo elegido, o null si es un reembolso o todavía no se eligió. */
  function montoFondoElegido() {
    var radio = fondoElegido();
    return radio && radio.value !== "reembolso" ? Number(radio.dataset.monto) || 0 : null;
  }

  /* Marca un fondo (al abrir desde "Rendir" o al retomar un borrador). Devuelve
     false si ese fondo ya no está entre los por rendir. */
  function elegirFondo(id) {
    if (!/^\d+$/.test(String(id || ""))) return false;
    var radio = form.querySelector('input[name="fund_request_id"][value="' + id + '"]');
    if (!radio) return false;
    radio.checked = true;
    if (radio.dataset.centro) cargarCentro(radio.dataset.centro);
    return true;
  }

  form.addEventListener("change", function (e) {
    if (e.target.name !== "fund_request_id") return;
    // El centro del fondo es el más probable; el usuario puede cambiarlo.
    if (e.target.dataset.centro) cargarCentro(e.target.dataset.centro);
    if (avisoFondo) avisoFondo.hidden = true;
    aplicarViajeDelFondo();
    recalcular();
  });

  function valorDe(fila, campo) {
    return (fila.querySelector('[data-campo="' + campo + '"]') || {}).value || "";
  }

  function claveFila(fila) {
    if (!fila.dataset.key) {
      itemKeySeq += 1;
      fila.dataset.key = "k" + itemKeySeq;
    }
    return fila.dataset.key;
  }

  function adjuntosDe(fila) {
    var key = claveFila(fila);
    if (!adjuntosPorClave[key]) adjuntosPorClave[key] = [];
    return adjuntosPorClave[key];
  }

  function aplicarSoloFila(fila) {
    todos("[data-solo]", fila).forEach(function (el) {
      el.hidden = el.dataset.solo !== estado.kind;
    });
  }

  function contarAdjuntos() {
    if (estado.kind !== "rendicion") return adjuntos.length;
    var n = 0;
    Object.keys(adjuntosPorClave).forEach(function (key) {
      n += (adjuntosPorClave[key] || []).length;
    });
    return n;
  }

  function leerAdjuntosPorItem() {
    var lista = [];
    todos(".gasto-item-fila", contenedor).forEach(function (fila) {
      var key = claveFila(fila);
      (adjuntosPorClave[key] || []).forEach(function (adj) {
        lista.push({
          name: adj.name,
          url: adj.url,
          public_id: adj.public_id,
          item_key: key,
        });
      });
    });
    return lista;
  }

  function leerItems() {
    return todos(".gasto-item-fila", contenedor)
      .map(function (fila, index) {
        var categoria = valorDe(fila, "category");
        return {
          key: claveFila(fila),
          item_date: valorDe(fila, "item_date"),
          category: categoria,
          days: categoria === CATEGORIA_CON_DIAS ? valorDe(fila, "days") : "",
          detail: valorDe(fila, "detail"),
          amount: valorDe(fila, "amount"),
          details: categoria === CATEGORIA_COMBUSTIBLE
            ? {
                yield_km_l: valorDe(fila, "yield_km_l"),
                distance_km: valorDe(fila, "distance_km"),
                price_per_liter: valorDe(fila, "price_per_liter"),
              }
            : null,
          sort_order: index,
        };
      })
      .filter(function (item) {
        return (
          item.detail.trim() ||
          item.amount.trim() ||
          item.category ||
          item.item_date ||
          (adjuntosPorClave[item.key] || []).length
        );
      });
  }

  /* Misma validación que normalizeItems, para señalar la fila exacta sin ir al
     servidor. Devuelve el mensaje y el campo a enfocar, o null. */
  function validarItems() {
    var filas = todos(".gasto-item-fila", contenedor);
    var alguna = false;
    for (var i = 0; i < filas.length; i += 1) {
      var fila = filas[i];
      var detalle = valorDe(fila, "detail").trim();
      var monto = valorDe(fila, "amount").trim();
      var categoria = valorDe(fila, "category");
      var conAdjunto = adjuntosDe(fila).length > 0;
      if (!detalle && !monto && !categoria && !conAdjunto) continue;
      alguna = true;
      var nombre = detalle ? "«" + detalle + "»" : "la línea " + (i + 1);
      var campo = function (nombreCampo) {
        return fila.querySelector('[data-campo="' + nombreCampo + '"]');
      };

      if (!categoria) return { msg: "Elige la categoría de " + nombre + ".", campo: campo("category") };
      if (categoria === CATEGORIA_CON_DIAS) {
        var dias = Number(valorDe(fila, "days"));
        if (!Number.isInteger(dias) || dias < 1) {
          return { msg: "Indica los días de hospedaje de " + nombre + ".", campo: campo("days") };
        }
      }
      if (categoria === CATEGORIA_COMBUSTIBLE) {
        if (!parseDecimalCampo(valorDe(fila, "yield_km_l"))) {
          return { msg: "Indica el rendimiento (km/L) de " + nombre + ".", campo: campo("yield_km_l") };
        }
        if (!parseDecimalCampo(valorDe(fila, "distance_km"))) {
          return { msg: "Indica la distancia recorrida de " + nombre + ".", campo: campo("distance_km") };
        }
        if (!parseDecimalCampo(valorDe(fila, "price_per_liter"))) {
          return { msg: "Indica el precio por litro de " + nombre + ".", campo: campo("price_per_liter") };
        }
      }
      if (!detalle) return { msg: "Agrega el detalle de la línea " + (i + 1) + ".", campo: campo("detail") };
      if (categoria !== CATEGORIA_COMBUSTIBLE && !monto) {
        return { msg: "Indica el monto de " + nombre + ".", campo: campo("amount") };
      }
      if (estado.kind === "rendicion" && !conAdjunto) {
        return {
          msg: "Adjunta el comprobante de " + nombre + ".",
          campo: fila.querySelector("[data-adjuntar]"),
        };
      }
    }
    if (!alguna) {
      return { msg: "Agrega al menos una línea al desglose.", campo: contenedor.querySelector("select, input") };
    }
    return null;
  }

  // ── Período ──────────────────────────────────────────────────────────────

  function fechasDesglose() {
    return todos('[data-campo="item_date"]', contenedor)
      .map(function (input) { return input.value; })
      .filter(Boolean)
      .sort();
  }

  /* Mientras el usuario no lo toque, en un reembolso el período va de la
     primera a la última fecha del desglose. En fondos es el viaje: no se
     deduce. Si rinde un fondo, se copia de ese viaje y no se edita. */
  function viajeDelFondoActivo() {
    if (estado.kind !== "rendicion") return null;
    var radio = fondoElegido();
    if (!radio || radio.value === "reembolso") return null;
    return radio;
  }

  function derivarPeriodo() {
    if (estado.kind === "fondos" || viajeDelFondoActivo()) return;
    var fechas = fechasDesglose();
    if (!periodoDesde.dataset.manual) periodoDesde.value = fechas[0] || "";
    if (!periodoHasta.dataset.manual) periodoHasta.value = fechas[fechas.length - 1] || "";
  }

  function aplicarViajeDelFondo() {
    var destino = byId("destino");
    var radio = viajeDelFondoActivo();
    var tieneViaje = !!(radio && (radio.dataset.desde || radio.dataset.hasta));
    if (radio) {
      if (radio.dataset.destino) destino.value = radio.dataset.destino;
      if (tieneViaje) {
        periodoDesde.value = radio.dataset.desde || "";
        periodoHasta.value = radio.dataset.hasta || "";
        periodoDesde.dataset.manual = "1";
        periodoHasta.dataset.manual = "1";
      }
    }
    destino.readOnly = !!(radio && radio.dataset.destino);
    periodoDesde.readOnly = tieneViaje;
    periodoHasta.readOnly = tieneViaje;
  }

  /* Al retomar un borrador, un extremo que coincide con las fechas del desglose
     sigue siendo automático; sólo uno distinto se considera escrito a mano. */
  function fijarPeriodo(input, valor, derivado) {
    input.value = valor || derivado || "";
    if (valor && valor !== derivado) input.dataset.manual = "1";
  }

  [periodoDesde, periodoHasta].forEach(function (input) {
    input.addEventListener("change", function () {
      if (input.value) {
        input.dataset.manual = "1";
      } else {
        delete input.dataset.manual;
        derivarPeriodo();
      }
    });
  });

  // ── Centro de costo ──────────────────────────────────────────────────────

  function centroElegido() {
    if (centroHidden) return centroHidden.value;
    var radio = form.querySelector('input[name="cost_center_id"]:checked');
    return radio ? radio.value : "";
  }

  function cargarCentro(id) {
    if (centroHidden || !/^\d+$/.test(String(id || ""))) return;
    var radio = form.querySelector('input[name="cost_center_id"][value="' + id + '"]');
    if (radio) radio.checked = true;
  }

  // ── Cuenta de destino ────────────────────────────────────────────────────

  var banco = (function () {
    var bloque = byId("datosBancarios");
    if (!bloque) return null;

    var BANCO_ESTADO = bloque.dataset.bancoEstado;
    var CUENTA_RUT = bloque.dataset.cuentaRut || "";
    var TIPO_RUT = "rut";

    var grupo = byId("cuentasGuardadas");
    var cuentaNueva = byId("cuentaNueva");
    var codigo = byId("bancoCodigo");
    var tipo = byId("bancoTipo");
    var numero = byId("bancoNumero");
    var ayuda = byId("bancoNumeroAyuda");
    var guardar = byId("guardarCuenta");
    var opcionRut = tipo.querySelector('option[value="' + TIPO_RUT + '"]');

    function radioElegido() {
      return grupo ? grupo.querySelector('input[name="cuentaDestino"]:checked') : null;
    }

    function usandoGuardada() {
      var radio = radioElegido();
      return !!radio && radio.value === "guardada";
    }

    function esCuentaRut() {
      return codigo.value === BANCO_ESTADO && tipo.value === TIPO_RUT;
    }

    /* La CuentaRUT sólo existe en Banco Estado: en cualquier otro banco la
       opción desaparece y, si estaba elegida, se limpia. */
    function sincronizarTipo() {
      var permite = codigo.value === BANCO_ESTADO;
      if (opcionRut) {
        opcionRut.hidden = !permite;
        opcionRut.disabled = !permite;
      }
      if (!permite && tipo.value === TIPO_RUT) tipo.value = "";
    }

    /* En la CuentaRUT el número es el RUT sin puntos ni dígito verificador: se
       rellena solo y no se edita. Al salir de ese caso se borra el número
       calculado para no dejar un RUT donde va otra cuenta. */
    function sincronizarNumero() {
      var rut = esCuentaRut();
      if (rut) {
        numero.value = CUENTA_RUT;
        numero.dataset.auto = "1";
      } else if (numero.dataset.auto) {
        numero.value = "";
        delete numero.dataset.auto;
      }
      numero.readOnly = rut;
      ayuda.hidden = !rut;
    }

    /* Con una cuenta guardada elegida los campos de cuenta nueva sobran. */
    function aplicarSeleccion() {
      cuentaNueva.hidden = usandoGuardada();
      sincronizarTipo();
      sincronizarNumero();
    }

    async function eliminarCuenta(btn) {
      var tarjeta = btn.closest("[data-cuenta]");
      var radio = tarjeta.querySelector("input");
      var ok = await window.IntranetDialog.confirm({
        title: "¿Eliminar la cuenta guardada?",
        message: "Dejará de ofrecerse en tus próximas solicitudes.",
        acceptLabel: "Eliminar",
        tone: "peligro",
      });
      if (!ok) return;

      btn.disabled = true;
      limpiarError();
      fetch("/gastos/cuentas/eliminar", {
        method: "POST",
        headers: JSON_HEADERS,
        credentials: "same-origin",
        body: JSON.stringify({
          bank_code: radio.dataset.bank,
          account_type: radio.dataset.type,
          account_number: radio.dataset.number,
        }),
      })
        .then(function (res) {
          return leerRespuestaJson(res).then(function (data) {
            // 404: ya no estaba guardada; para la pantalla es lo mismo.
            if (res.ok || res.status === 404) return;
            throw new Error(data.error || "No se pudo eliminar la cuenta.");
          });
        })
        .then(function () {
          var estabaElegida = radio.checked;
          tarjeta.remove();
          var restantes = grupo.querySelectorAll("[data-cuenta]");
          if (!restantes.length) {
            grupo.remove();
            grupo = null;
          } else if (estabaElegida) {
            restantes[0].querySelector("input").checked = true;
          }
          aplicarSeleccion();
        })
        .catch(function (err) {
          btn.disabled = false;
          mostrarError(mensajeDeRed(err, "No se pudo eliminar la cuenta."));
        });
    }

    if (grupo) {
      grupo.addEventListener("change", function () {
        aplicarSeleccion();
        if (!usandoGuardada()) codigo.focus();
      });
      grupo.addEventListener("click", function (e) {
        var btn = e.target.closest("[data-eliminar-cuenta]");
        if (btn) eliminarCuenta(btn);
      });
    }
    codigo.addEventListener("change", function () {
      sincronizarTipo();
      sincronizarNumero();
    });
    tipo.addEventListener("change", sincronizarNumero);

    return {
      /* Tras form.reset(): si la cuenta marcada por defecto se eliminó, se
         elige la primera que quede. */
      reiniciar: function () {
        delete numero.dataset.auto;
        numero.readOnly = false;
        if (grupo && !radioElegido()) {
          var primera = grupo.querySelector("[data-cuenta] input") ||
            grupo.querySelector('input[value="nueva"]');
          primera.checked = true;
        }
        aplicarSeleccion();
      },
      cargar: function (cuenta) {
        if (!cuenta) return;
        var guardada = grupo
          ? todos("[data-cuenta] input", grupo).filter(function (radio) {
              return radio.dataset.bank === cuenta.bank_code &&
                radio.dataset.type === cuenta.account_type &&
                radio.dataset.number === cuenta.account_number;
            })[0]
          : null;
        if (guardada) {
          guardada.checked = true;
          aplicarSeleccion();
          return;
        }
        if (grupo) grupo.querySelector('input[value="nueva"]').checked = true;
        codigo.value = cuenta.bank_code || "";
        sincronizarTipo();
        tipo.value = cuenta.account_type || "";
        aplicarSeleccion();
        if (!esCuentaRut()) numero.value = cuenta.account_number || "";
      },
      validar: function () {
        if (usandoGuardada()) return null;
        if (!codigo.value) return { msg: "Elige el banco de destino.", campo: codigo };
        if (!tipo.value) return { msg: "Elige el tipo de cuenta.", campo: tipo };
        var digitos = numero.value.replace(/[\s.\-]/g, "");
        if (!/^\d{4,20}$/.test(digitos)) {
          return { msg: "El número de cuenta debe tener entre 4 y 20 dígitos.", campo: numero };
        }
        return null;
      },
      leer: function () {
        if (usandoGuardada()) {
          var radio = radioElegido();
          return {
            bank_account: {
              bank_code: radio.dataset.bank,
              account_type: radio.dataset.type,
              account_number: radio.dataset.number,
            },
            save_bank_account: false,
          };
        }
        return {
          bank_account: {
            bank_code: codigo.value,
            account_type: tipo.value,
            account_number: numero.value,
          },
          save_bank_account: guardar.checked,
        };
      },
    };
  })();

  // ── Comprobantes ─────────────────────────────────────────────────────────

  function esAdjuntoLocal(adj) {
    return !!(adj && adj.file);
  }

  function adjuntoDesdeArchivo(file) {
    return {
      name: file.name,
      url: URL.createObjectURL(file),
      public_id: null,
      file: file,
    };
  }

  function liberarBlob(adj) {
    if (!adj || !adj.url || adj.url.indexOf("blob:") !== 0) return;
    try {
      URL.revokeObjectURL(adj.url);
    } catch (err) {}
  }

  function cadaAdjunto(fn) {
    if (estado.kind === "rendicion") {
      Object.keys(adjuntosPorClave).forEach(function (key) {
        (adjuntosPorClave[key] || []).forEach(fn);
      });
    } else {
      adjuntos.forEach(fn);
    }
  }

  function hayAdjuntosLocales() {
    var hay = false;
    cadaAdjunto(function (adj) {
      if (esAdjuntoLocal(adj)) hay = true;
    });
    return hay;
  }

  function liberarBlobsLocales() {
    cadaAdjunto(function (adj) {
      if (esAdjuntoLocal(adj)) liberarBlob(adj);
    });
  }

  function refrescarListasAdjuntos() {
    if (estado.kind === "rendicion") {
      todos(".gasto-item-fila", contenedor).forEach(pintarAdjuntosFila);
    } else {
      pintarAdjuntos();
    }
  }

  function chipAdjunto(adj, alQuitar) {
    var li = document.createElement("li");
    li.className = "gasto-adjunto";

    var nombre = document.createElement("a");
    nombre.className = "gasto-adjunto__nombre";
    nombre.href = adj.url;
    nombre.target = "_blank";
    nombre.rel = "noopener";
    nombre.textContent = adj.name;

    var quitar = document.createElement("button");
    quitar.type = "button";
    quitar.className = "gasto-adjunto__quitar";
    quitar.setAttribute("aria-label", "Quitar " + adj.name);
    quitar.textContent = "×";
    quitar.addEventListener("click", alQuitar);

    li.appendChild(nombre);
    li.appendChild(quitar);
    return li;
  }

  function descartarSiPendiente(adj) {
    if (esAdjuntoLocal(adj)) {
      liberarBlob(adj);
      return;
    }
    var ref = adj.public_id || adj.url;
    var pendiente = subidosSinGuardar.indexOf(ref);
    if (pendiente !== -1) {
      subidosSinGuardar.splice(pendiente, 1);
      descartarArchivos([ref]);
    }
  }

  function pintarAdjuntos() {
    if (!listaAdjuntos) return;
    while (listaAdjuntos.firstChild) listaAdjuntos.removeChild(listaAdjuntos.firstChild);
    adjuntos.forEach(function (adj, index) {
      listaAdjuntos.appendChild(chipAdjunto(adj, function () {
        adjuntos.splice(index, 1);
        descartarSiPendiente(adj);
        pintarAdjuntos();
        marcarSucio();
      }));
    });
  }

  function pintarAdjuntosFila(fila) {
    var lista = fila.querySelector("[data-adjuntos-lista]");
    var texto = fila.querySelector("[data-adjuntar-texto]");
    if (!lista) return;
    while (lista.firstChild) lista.removeChild(lista.firstChild);
    var archivos = adjuntosDe(fila);
    archivos.forEach(function (adj, index) {
      var li = chipAdjunto(adj, function () {
        archivos.splice(index, 1);
        descartarSiPendiente(adj);
        pintarAdjuntosFila(fila);
        marcarSucio();
      });
      li.classList.add("gasto-adjunto--linea");
      lista.appendChild(li);
    });
    if (texto) texto.textContent = archivos.length ? "Adjuntar otro" : "Adjuntar comprobante";
  }

  function soltarAdjuntosFila(fila) {
    var key = fila && fila.dataset.key;
    if (!key || !adjuntosPorClave[key]) return;
    adjuntosPorClave[key].forEach(descartarSiPendiente);
    delete adjuntosPorClave[key];
  }

  function subirArchivoAlServidor(file) {
    var datos = new FormData();
    datos.append("archivo", file);
    return fetch("/gastos/adjuntos/upload", {
      method: "POST",
      headers: { Accept: "application/json", "X-Requested-With": "fetch" },
      body: datos,
      credentials: "same-origin",
    }).then(function (res) {
      return leerRespuestaJson(res).then(function (data) {
        if (!res.ok || !data.secure_url) {
          throw new Error(data.error || 'No se pudo subir "' + file.name + '".');
        }
        return data;
      });
    });
  }

  /* Los File se quedan en memoria hasta este paso: guardar borrador o enviar. */
  async function persistirAdjuntosLocales() {
    var pendientes = [];
    function recoger(lista) {
      (lista || []).forEach(function (adj, i) {
        if (esAdjuntoLocal(adj)) pendientes.push({ lista: lista, index: i, adj: adj });
      });
    }
    if (estado.kind === "rendicion") {
      Object.keys(adjuntosPorClave).forEach(function (key) {
        recoger(adjuntosPorClave[key]);
      });
    } else {
      recoger(adjuntos);
    }

    for (var i = 0; i < pendientes.length; i += 1) {
      var item = pendientes[i];
      var data = await subirArchivoAlServidor(item.adj.file);
      liberarBlob(item.adj);
      item.lista[item.index] = {
        name: item.adj.name,
        url: data.secure_url,
        public_id: data.public_id,
      };
      subidosSinGuardar.push(data.public_id || data.secure_url);
    }
  }

  function adjuntarArchivos(archivos, itemKey) {
    if (estado.ocupado || !archivos.length) return;
    limpiarError();

    var lista = itemKey
      ? (adjuntosPorClave[itemKey] || (adjuntosPorClave[itemKey] = []))
      : adjuntos;
    var fila = itemKey
      ? contenedor.querySelector('.gasto-item-fila[data-key="' + itemKey + '"]')
      : null;
    var agregados = 0;

    for (var i = 0; i < archivos.length; i += 1) {
      var file = archivos[i];
      if (contarAdjuntos() >= MAX_ADJUNTOS) {
        mostrarError("Máximo " + MAX_ADJUNTOS + " comprobantes por solicitud.");
        break;
      }
      if (file.size > MAX_BYTES) {
        mostrarError('"' + file.name + '" supera los ' + form.dataset.maxMb + " MB.");
        continue;
      }
      lista.push(adjuntoDesdeArchivo(file));
      agregados += 1;
    }

    if (agregados) {
      if (fila) pintarAdjuntosFila(fila);
      else pintarAdjuntos();
      marcarSucio();
    }
  }

  function traeArchivos(e) {
    return !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, "Files") !== -1;
  }

  function zonaAdjuntoItem(el) {
    return el && el.closest ? el.closest("[data-col='attachments']") : null;
  }

  dropzone.addEventListener("click", function () {
    if (estado.ocupado) return;
    destinoAdjunto = "";
    adjuntoInput.click();
  });

  adjuntoInput.addEventListener("change", function () {
    var archivos = Array.prototype.slice.call(adjuntoInput.files);
    adjuntoInput.value = "";
    var clave = destinoAdjunto;
    destinoAdjunto = "";
    adjuntarArchivos(archivos, clave || undefined);
  });

  ["dragenter", "dragover"].forEach(function (tipoEvento) {
    dropzone.addEventListener(tipoEvento, function (e) {
      if (!traeArchivos(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      dropzone.classList.add("is-over");
    });
  });

  dropzone.addEventListener("dragleave", function (e) {
    if (!dropzone.contains(e.relatedTarget)) dropzone.classList.remove("is-over");
  });

  dropzone.addEventListener("drop", function (e) {
    if (!traeArchivos(e)) return;
    e.preventDefault();
    dropzone.classList.remove("is-over");
    destinoAdjunto = "";
    adjuntarArchivos(Array.prototype.slice.call(e.dataTransfer.files));
  });

  ["dragenter", "dragover"].forEach(function (tipoEvento) {
    contenedor.addEventListener(tipoEvento, function (e) {
      var zona = zonaAdjuntoItem(e.target);
      if (!zona || !traeArchivos(e) || estado.kind !== "rendicion") return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      zona.classList.add("is-over");
    });
  });

  contenedor.addEventListener("dragleave", function (e) {
    var zona = zonaAdjuntoItem(e.target);
    if (zona && !zona.contains(e.relatedTarget)) zona.classList.remove("is-over");
  });

  contenedor.addEventListener("drop", function (e) {
    var zona = zonaAdjuntoItem(e.target);
    if (!zona || !traeArchivos(e) || estado.kind !== "rendicion") return;
    e.preventDefault();
    zona.classList.remove("is-over");
    var fila = zona.closest(".gasto-item-fila");
    adjuntarArchivos(Array.prototype.slice.call(e.dataTransfer.files), claveFila(fila));
  });

  /* Un archivo soltado fuera de la zona no debe abrirse en la pestaña y hacer
     perder todo lo escrito. */
  ["dragover", "drop"].forEach(function (tipoEvento) {
    window.addEventListener(tipoEvento, function (e) {
      if (!traeArchivos(e)) return;
      if (dropzone.contains(e.target) || zonaAdjuntoItem(e.target)) return;
      e.preventDefault();
    });
  });

  // ── Estado del modal ─────────────────────────────────────────────────────

  function mostrarError(msg) {
    errorEl.textContent = msg;
    errorEl.style.display = "block";
  }

  function limpiarError() {
    errorEl.textContent = "";
    errorEl.style.display = "none";
  }

  function fallar(problema) {
    if (problema.campo && problema.campo.focus) {
      problema.campo.focus();
      if (problema.campo.scrollIntoView) problema.campo.scrollIntoView({ block: "center" });
    }
    mostrarError(problema.msg);
  }

  function marcarSucio() {
    estado.sucio = true;
  }

  form.addEventListener("input", marcarSucio);
  form.addEventListener("change", marcarSucio);

  var botones = [btnEnviar, btnBorrador, btnEliminarBorrador];
  botones.forEach(function (boton) {
    boton.dataset.texto = boton.textContent;
  });

  /* Mientras sube, guarda o envía, los tres botones se bloquean y el que
     corresponde dice qué está pasando. */
  function ocupar(activo, boton, texto) {
    estado.ocupado = activo;
    botones.forEach(function (b) {
      if (window.IntranetModal) window.IntranetModal.ocuparBoton(b, false);
      b.disabled = activo;
      b.textContent = b.dataset.texto;
    });
    if (activo && boton && window.IntranetModal) window.IntranetModal.ocuparBoton(boton, true);
    if (activo && texto) mostrarEstado(texto);
  }

  function mostrarEstado(texto) {
    estadoModal.textContent = texto || "";
  }

  function textoBorrador(id, fecha) {
    var d = fecha ? new Date(fecha) : new Date();
    var cuando = Number.isNaN(d.getTime())
      ? ""
      : " · guardado " +
        d.toLocaleDateString(undefined, { day: "2-digit", month: "2-digit" }) + " " +
        d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
    return "Borrador #" + id + cuando;
  }

  function aplicarKind(kind) {
    estado.kind = kind === "fondos" ? "fondos" : "rendicion";
    form.dataset.kind = estado.kind;
    tituloModal.textContent = TITULOS[estado.kind];
    todos("[data-solo]", form).forEach(function (el) {
      el.hidden = el.dataset.solo !== estado.kind;
    });
    campoTitulo.placeholder = estado.kind === "fondos"
      ? campoTitulo.dataset.placeholderFondos
      : campoTitulo.dataset.placeholderRendicion;
    [periodoDesde, periodoHasta].forEach(function (input) {
      if (estado.kind === "rendicion") input.max = HOY;
      else input.removeAttribute("max");
    });
  }

  function reiniciar() {
    liberarBlobsLocales();
    descartarPendientes();
    form.reset();
    todos(".gasto-item-fila", contenedor).forEach(function (fila) {
      fila.remove();
    });
    adjuntos = [];
    adjuntosPorClave = {};
    itemKeySeq = 0;
    destinoAdjunto = "";
    pintarAdjuntos();
    delete periodoDesde.dataset.manual;
    delete periodoHasta.dataset.manual;
    if (avisoFondo) avisoFondo.hidden = true;
    estado.borradorId = null;
    byId("destino").readOnly = false;
    periodoDesde.readOnly = false;
    periodoHasta.readOnly = false;
    limpiarError();
    if (banco) banco.reiniciar();
  }

  function rellenar(borrador) {
    estado.borradorId = borrador.id;
    campoTitulo.value = borrador.title || "";
    byId("descripcion").value = borrador.description || "";
    byId("destino").value = borrador.destination || "";

    // Primero el fondo (propone su centro) y después el centro guardado, que manda.
    if (borrador.fund_request_id && !elegirFondo(borrador.fund_request_id) && avisoFondo) {
      avisoFondo.hidden = false;
    }
    cargarCentro(borrador.cost_center_id);

    (borrador.items || []).forEach(function (item) {
      agregarFila(false, item);
    });
    if (!todos(".gasto-item-fila", contenedor).length) agregarFila(false);

    aplicarViajeDelFondo();
    if (estado.kind === "fondos") {
      fijarPeriodo(periodoDesde, borrador.period_start, "");
      fijarPeriodo(periodoHasta, borrador.period_end, "");
    } else if (!viajeDelFondoActivo()) {
      var fechas = fechasDesglose();
      fijarPeriodo(periodoDesde, borrador.period_start, fechas[0]);
      fijarPeriodo(periodoHasta, borrador.period_end, fechas[fechas.length - 1]);
    }

    var sueltos = (borrador.attachments || []).map(function (a) {
      return { name: a.name, url: a.url, public_id: a.public_id };
    });
    if (estado.kind === "fondos") {
      adjuntos = sueltos;
      pintarAdjuntos();
    } else if (sueltos.length) {
      // Borradores viejos: los comprobantes eran de la solicitud, no de la línea.
      var primera = todos(".gasto-item-fila", contenedor)[0];
      if (primera) {
        adjuntosDe(primera).push.apply(adjuntosDe(primera), sueltos);
        pintarAdjuntosFila(primera);
      }
    }

    if (banco) banco.cargar(borrador.bank_account);
  }

  function abrir(kind, borrador, opciones) {
    reiniciar();
    aplicarKind(kind);
    if (borrador) {
      rellenar(borrador);
    } else {
      agregarFila(false);
      if (estado.kind !== "fondos") derivarPeriodo();
    }
    // Desde el botón "Rendir" de un fondo, ese fondo llega elegido.
    if (opciones && opciones.fondoId) elegirFondo(opciones.fondoId);
    aplicarViajeDelFondo();
    recalcular();
    btnEliminarBorrador.hidden = !estado.borradorId;
    mostrarEstado(borrador ? textoBorrador(borrador.id, borrador.updated_at) : "");
    estado.sucio = false;

    window.IntranetModal.open(overlay);
    cuerpoModal.scrollTop = 0;
    // En móvil enfocar abriría el teclado encima de todo el formulario.
    if (window.matchMedia("(min-width: 769px)").matches) {
      setTimeout(function () { campoTitulo.focus(); }, 80);
    }
  }

  var confirmandoCierre = false;

  async function cerrar() {
    if (estado.ocupado || confirmandoCierre) return;
    if (estado.sucio) {
      confirmandoCierre = true;
      var salir = await window.IntranetDialog.confirm({
        title: "¿Cerrar sin guardar?",
        message: "Tienes cambios sin guardar en esta solicitud. Si cierras, se pierden.",
        acceptLabel: "Cerrar sin guardar",
        cancelLabel: "Seguir editando",
        tone: "peligro",
      });
      confirmandoCierre = false;
      if (!salir) return;
    }
    estado.sucio = false;
    // Los File locales se sueltan; lo subido en un guardado fallido se borra.
    liberarBlobsLocales();
    descartarPendientes();
    window.IntranetModal.close(overlay);
    if (estado.listaDesactualizada) {
      setTimeout(function () { window.location.reload(); }, window.IntranetModal.ANIM_MS);
    }
  }

  overlay.addEventListener("click", function (e) {
    if (e.target.closest("[data-gasto-cerrar]")) cerrar();
  });

  // data-dismiss="false" apaga el Escape genérico de modal.js: aquí se cierra
  // igual, pero preguntando si hay cambios.
  document.addEventListener("keydown", function (e) {
    // Sólo si este modal es el de arriba: con el aviso de cambios abierto,
    // Escape es para el aviso.
    if (e.key !== "Escape" || e.defaultPrevented || !window.IntranetModal.isOpen(overlay)) return;
    if (window.IntranetModal.top && window.IntranetModal.top() !== overlay) return;
    cerrar();
  });

  window.addEventListener("beforeunload", function (e) {
    if (window.IntranetModal.isOpen(overlay) && estado.sucio) {
      e.preventDefault();
      e.returnValue = "";
    }
  });

  // pagehide y no beforeunload: éste se dispara aunque el usuario luego
  // cancele la salida, y borraría archivos de un formulario que sigue abierto.
  window.addEventListener("pagehide", function () {
    descartarPendientes(true);
  });

  // ── Guardar, enviar, eliminar ────────────────────────────────────────────

  function leerCuerpo() {
    var fondo = fondoElegido();
    var cuerpo = {
      id: estado.borradorId,
      kind: estado.kind,
      // "" sin elegir, "reembolso" o el id del fondo. El servidor lo valida.
      fund_request_id: estado.kind === "rendicion" && fondo ? fondo.value : "",
      title: campoTitulo.value,
      destination: byId("destino").value,
      period_start: periodoDesde.value || periodoHasta.value,
      period_end: periodoHasta.value || periodoDesde.value,
      description: byId("descripcion").value,
      items: leerItems(),
      attachments: estado.kind === "rendicion" ? leerAdjuntosPorItem() : adjuntos,
      needed_by: "",
      cost_center_id: centroElegido(),
    };
    if (banco) Object.assign(cuerpo, banco.leer());
    return cuerpo;
  }

  function enviar(cuerpo) {
    return fetch("/gastos/guardar", {
      method: "POST",
      headers: JSON_HEADERS,
      credentials: "same-origin",
      body: JSON.stringify(cuerpo),
    }).then(function (res) {
      return leerRespuestaJson(res).then(function (data) {
        if (!res.ok) throw new Error(data.error || "No se pudo guardar la solicitud.");
        return data;
      });
    });
  }

  /* Valida en el orden en que se ven las secciones, para que el primer error
     sea el que el usuario tiene más arriba. */
  function validar() {
    if (estado.kind === "rendicion" && hayFondosPorRendir() && !fondoElegido()) {
      return {
        msg: "Elige qué fondo vas a rendir o marca «Sin fondo».",
        campo: form.querySelector('input[name="fund_request_id"]'),
      };
    }
    if (!centroElegido()) {
      return { msg: "Elige el centro de costo.", campo: form.querySelector('input[name="cost_center_id"]') };
    }
    if (!campoTitulo.value.trim()) return { msg: "Indica el asunto.", campo: campoTitulo };

    var problemaItems = validarItems();
    if (problemaItems) return problemaItems;

    if (estado.kind === "fondos") {
      if (!periodoDesde.value || !periodoHasta.value) {
        return {
          msg: "Indica el período del viaje (desde y hasta).",
          campo: periodoDesde.value ? periodoHasta : periodoDesde,
        };
      }
      if (periodoDesde.value > periodoHasta.value) {
        return { msg: "El período del viaje termina antes de empezar.", campo: periodoHasta };
      }
    } else {
      if (!viajeDelFondoActivo()) derivarPeriodo();
      if (periodoDesde.value && periodoHasta.value && periodoDesde.value > periodoHasta.value) {
        return { msg: "El período de gastos termina antes de empezar.", campo: periodoHasta };
      }
    }

    return banco ? banco.validar() : null;
  }

  btnBorrador.addEventListener("click", async function () {
    if (estado.ocupado) return;
    limpiarError();
    try {
      ocupar(true, btnBorrador, hayAdjuntosLocales() ? "Subiendo comprobantes…" : "Guardando…");
      await persistirAdjuntosLocales();
      ocupar(true, btnBorrador, "Guardando…");
      var cuerpo = leerCuerpo();
      cuerpo.draft = true;
      var data = await enviar(cuerpo);
      // Ya viven en el borrador: dejan de ser descartables desde el cliente.
      subidosSinGuardar = [];
      // Al guardar se renombran (<id>_<n>[_slug]): el próximo guardado debe
      // mandar las rutas nuevas, porque las temporales ya no existen.
      if (Array.isArray(data.attachments)) {
        if (estado.kind === "rendicion") {
          var porClave = {};
          data.attachments.forEach(function (a) {
            if (!a.item_key) return;
            if (!porClave[a.item_key]) porClave[a.item_key] = [];
            porClave[a.item_key].push({ name: a.name, url: a.url, public_id: a.public_id });
          });
          adjuntosPorClave = porClave;
          todos(".gasto-item-fila", contenedor).forEach(pintarAdjuntosFila);
        } else {
          adjuntos = data.attachments.map(function (a) {
            return { name: a.name, url: a.url, public_id: a.public_id };
          });
          pintarAdjuntos();
        }
      }
      estado.borradorId = data.id;
      estado.sucio = false;
      estado.listaDesactualizada = true;
      btnEliminarBorrador.hidden = false;
      mostrarEstado(textoBorrador(data.id, data.updatedAt));
    } catch (err) {
      refrescarListasAdjuntos();
      mostrarError(mensajeDeRed(err, "No se pudo guardar el borrador."));
    } finally {
      ocupar(false);
    }
  });

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    if (estado.ocupado) return;
    limpiarError();

    var problema = validar();
    if (problema) return fallar(problema);

    try {
      ocupar(true, btnEnviar, hayAdjuntosLocales() ? "Subiendo comprobantes…" : "Enviando…");
      await persistirAdjuntosLocales();
      ocupar(true, btnEnviar, "Enviando…");
      var cuerpo = leerCuerpo();
      cuerpo.draft = false;
      await enviar(cuerpo);
      subidosSinGuardar = [];
      estado.sucio = false;
      window.location.href = "/gastos?ok=1&msg=" + encodeURIComponent("Solicitud enviada.");
    } catch (err) {
      refrescarListasAdjuntos();
      mostrarError(mensajeDeRed(err, "No se pudo enviar la solicitud."));
      ocupar(false);
    }
  });

  btnEliminarBorrador.addEventListener("click", async function () {
    if (!estado.borradorId || estado.ocupado) return;
    var descartar = await window.IntranetDialog.confirm({
      title: "¿Descartar el borrador?",
      message: "Se borran también sus comprobantes. Esta acción no se puede deshacer.",
      acceptLabel: "Descartar",
      tone: "peligro",
    });
    if (!descartar) return;
    try {
      ocupar(true, btnEliminarBorrador, "Eliminando…");
      // Los guardados los borra el servidor con el borrador; los subidos
      // después del último guardado sólo los conoce el cliente.
      descartarPendientes();
      var res = await fetch("/gastos/" + estado.borradorId + "/borrador/eliminar", {
        method: "POST",
        headers: JSON_HEADERS,
        credentials: "same-origin",
        body: "{}",
      });
      var data = await leerRespuestaJson(res);
      if (!res.ok && res.status !== 404) {
        throw new Error(data.error || "No se pudo eliminar el borrador.");
      }
      estado.sucio = false;
      window.location.href = "/gastos?ok=1&msg=" + encodeURIComponent("Borrador eliminado.");
    } catch (err) {
      mostrarError(mensajeDeRed(err, "No se pudo eliminar el borrador."));
      ocupar(false);
    }
  });

  // ── Apertura ─────────────────────────────────────────────────────────────

  function abrirBorrador(id) {
    if (!/^\d+$/.test(String(id))) return;
    fetch("/gastos/" + id + "/borrador", {
      credentials: "same-origin",
      headers: { Accept: "application/json", "X-Requested-With": "fetch" },
    })
      .then(function (res) {
        return leerRespuestaJson(res).then(function (data) {
          if (!res.ok) throw new Error(data.error || "No se pudo abrir el borrador.");
          return data;
        });
      })
      .then(function (borrador) {
        abrir(borrador.kind, borrador);
      })
      .catch(function (err) {
        window.IntranetDialog.alert({
          title: "No se pudo abrir el borrador",
          message: mensajeDeRed(err, "Intenta de nuevo en un momento."),
        });
      });
  }

  document.addEventListener("click", function (e) {
    var nueva = e.target.closest("[data-abrir-gasto]");
    if (nueva) {
      e.preventDefault();
      abrir(nueva.dataset.abrirGasto, null, { fondoId: nueva.dataset.fondo });
      return;
    }
    var borrador = e.target.closest("[data-abrir-borrador]");
    if (borrador) {
      e.preventDefault();
      abrirBorrador(borrador.dataset.abrirBorrador);
    }
  });

  // Enlaces directos: /gastos?nueva=rendicion o /gastos?borrador=123456.
  (function () {
    var params = new URLSearchParams(window.location.search);
    var nueva = params.get("nueva");
    var borrador = params.get("borrador");
    if (!nueva && !borrador) return;

    params.delete("nueva");
    params.delete("borrador");
    var query = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (query ? "?" + query : ""));

    if (borrador) abrirBorrador(borrador);
    else if (nueva === "rendicion" || nueva === "fondos") abrir(nueva);
  })();
})();
