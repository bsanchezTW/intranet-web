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
  var dropzoneTexto = byId("dropzoneTexto");
  var listaAdjuntos = byId("listaAdjuntos");
  var errorEl = byId("formError");
  var btnEnviar = byId("btnEnviar");
  var btnBorrador = byId("btnGuardarBorrador");
  var btnEliminarBorrador = byId("btnEliminarBorrador");
  var campoTitulo = byId("titulo");
  var periodoDesde = byId("periodoDesde");
  var periodoHasta = byId("periodoHasta");
  var fondoAsignado = byId("fondoAsignado");
  var saldoEtiqueta = byId("saldoEtiqueta");
  var saldoValor = byId("saldoValor");
  // Con un solo centro asignado el id viaja en un hidden; con dos, en radios.
  var centroHidden = byId("centroCostoValor");

  var HOY = form.dataset.hoy;
  var MAX_BYTES = Number(form.dataset.maxMb || 20) * 1024 * 1024;
  var DECIMALES = Number(form.dataset.decimales || 0);
  var MAX_FILAS = 50;
  var MAX_ADJUNTOS = 10;
  var CATEGORIA_CON_DIAS = "hospedaje";
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

  // Comprobantes ya subidos al bucket, pendientes de asociarse a la solicitud.
  var adjuntos = [];

  /* Referencias de los subidos desde el último guardado. Si el usuario los
     quita o cierra sin guardar, se borran del bucket en vez de quedar
     huérfanos. Los ya guardados en el borrador los administra el servidor. */
  var subidosSinGuardar = [];

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
      headers: { "Content-Type": "application/json" },
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

    /* Saldo = total gastado - fondo asignado. Positivo: la empresa le debe al
       colaborador; negativo: el colaborador devuelve lo que sobró. */
    if (estado.kind !== "rendicion" || !fondoAsignado) return;
    var saldo = total - parseMonto(fondoAsignado.value);
    saldoEtiqueta.textContent = saldo < 0 ? "A devolver" : "A reintegrar";
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
      fijarCampo(fila, "amount", montoParaCampo(datos.amount));
    }
    sincronizarDias(fila);
    if (datos && datos.days) fijarCampo(fila, "days", datos.days);

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

  /* Los días sólo aplican al hospedaje. Al cambiar a otra categoría se borran
     para que no viaje un valor que la fila ya no muestra. */
  function sincronizarDias(fila) {
    var categoria = fila.querySelector('[data-campo="category"]');
    var dias = fila.querySelector('[data-campo="days"]');
    var guion = fila.querySelector("[data-dias-na]");
    var conDias = !!categoria && categoria.value === CATEGORIA_CON_DIAS;

    fila.classList.toggle("gasto-item-fila--hospedaje", conDias);
    if (!dias) return;
    dias.hidden = !conDias;
    if (guion) guion.hidden = conDias;
    if (!conDias) dias.value = "";
  }

  contenedor.addEventListener("input", function (e) {
    if (e.target.dataset.campo === "amount") recalcular();
  });

  contenedor.addEventListener("focusout", function (e) {
    if (e.target.dataset.campo === "amount") formatearCampoMonto(e.target);
  });

  contenedor.addEventListener("change", function (e) {
    var campo = e.target.dataset.campo;
    if (campo === "item_date") derivarPeriodo();
    if (campo !== "category") return;
    var fila = e.target.closest(".gasto-item-fila");
    sincronizarDias(fila);
    if (e.target.value === CATEGORIA_CON_DIAS) {
      var dias = fila.querySelector('[data-campo="days"]');
      if (dias) dias.focus();
    }
  });

  contenedor.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-quitar-fila]");
    if (!btn || btn.disabled) return;
    btn.closest(".gasto-item-fila").remove();
    actualizarBotonesQuitar();
    recalcular();
    derivarPeriodo();
    marcarSucio();
  });

  btnAgregar.addEventListener("click", function () {
    agregarFila(true);
  });

  fondoAsignado.addEventListener("input", recalcular);
  fondoAsignado.addEventListener("focusout", function () {
    formatearCampoMonto(fondoAsignado);
  });

  function valorDe(fila, campo) {
    return (fila.querySelector('[data-campo="' + campo + '"]') || {}).value || "";
  }

  function leerItems() {
    return todos(".gasto-item-fila", contenedor)
      .map(function (fila, index) {
        var categoria = valorDe(fila, "category");
        return {
          item_date: valorDe(fila, "item_date"),
          category: categoria,
          days: categoria === CATEGORIA_CON_DIAS ? valorDe(fila, "days") : "",
          detail: valorDe(fila, "detail"),
          amount: valorDe(fila, "amount"),
          sort_order: index,
        };
      })
      .filter(function (item) {
        return item.detail.trim() || item.amount.trim() || item.category || item.item_date;
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
      if (!detalle && !monto && !categoria) continue;
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
      if (!detalle) return { msg: "Agrega el detalle de la línea " + (i + 1) + ".", campo: campo("detail") };
      if (!monto) return { msg: "Indica el monto de " + nombre + ".", campo: campo("amount") };
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

  /* Mientras el usuario no lo toque, el período va de la primera a la última
     fecha del desglose. Si borra un extremo, ese extremo vuelve a ser automático. */
  function derivarPeriodo() {
    var fechas = fechasDesglose();
    if (!periodoDesde.dataset.manual) periodoDesde.value = fechas[0] || "";
    if (!periodoHasta.dataset.manual) periodoHasta.value = fechas[fechas.length - 1] || "";
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

    function eliminarCuenta(btn) {
      var tarjeta = btn.closest("[data-cuenta]");
      var radio = tarjeta.querySelector("input");
      if (!window.confirm("¿Eliminar esta cuenta guardada?")) return;

      btn.disabled = true;
      limpiarError();
      fetch("/gastos/cuentas/eliminar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          bank_code: radio.dataset.bank,
          account_type: radio.dataset.type,
          account_number: radio.dataset.number,
        }),
      })
        .then(function (res) {
          // 404: ya no estaba guardada; para la pantalla es lo mismo.
          if (res.ok || res.status === 404) return;
          return res.json().catch(function () { return {}; }).then(function (data) {
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
          mostrarError(err.message);
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

  function pintarAdjuntos() {
    while (listaAdjuntos.firstChild) listaAdjuntos.removeChild(listaAdjuntos.firstChild);

    adjuntos.forEach(function (adj, index) {
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
      quitar.addEventListener("click", function () {
        adjuntos.splice(index, 1);
        // Recién subido y nunca guardado: nadie más lo usa, se borra ya.
        var ref = adj.public_id || adj.url;
        var pendiente = subidosSinGuardar.indexOf(ref);
        if (pendiente !== -1) {
          subidosSinGuardar.splice(pendiente, 1);
          descartarArchivos([ref]);
        }
        pintarAdjuntos();
        marcarSucio();
      });

      li.appendChild(nombre);
      li.appendChild(quitar);
      listaAdjuntos.appendChild(li);
    });
  }

  function subirArchivo(file) {
    var datos = new FormData();
    datos.append("archivo", file);
    return fetch("/gastos/adjuntos/upload", {
      method: "POST",
      body: datos,
      credentials: "same-origin",
    })
      .then(function (res) {
        // Un 413 del proxy o una página de error no traen JSON: el usuario
        // debe ver un mensaje, no el error de parseo.
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok || !data.secure_url) {
            throw new Error(data.error || 'No se pudo subir "' + file.name + '".');
          }
          return data;
        });
      })
      .then(function (data) {
        adjuntos.push({
          name: file.name,
          url: data.secure_url,
          public_id: data.public_id,
        });
        subidosSinGuardar.push(data.public_id || data.secure_url);
      });
  }

  var textoZona = dropzoneTexto.innerHTML;

  async function subirArchivos(archivos) {
    if (estado.ocupado || !archivos.length) return;
    limpiarError();
    ocupar(true, btnEnviar, "Subiendo…");
    dropzone.classList.add("is-subiendo");

    for (var i = 0; i < archivos.length; i += 1) {
      var file = archivos[i];
      if (adjuntos.length >= MAX_ADJUNTOS) {
        mostrarError("Máximo " + MAX_ADJUNTOS + " comprobantes por solicitud.");
        break;
      }
      if (file.size > MAX_BYTES) {
        mostrarError('"' + file.name + '" supera los ' + form.dataset.maxMb + " MB.");
        continue;
      }
      dropzoneTexto.textContent =
        "Subiendo " + (archivos.length > 1 ? i + 1 + " de " + archivos.length : file.name) + "…";
      try {
        await subirArchivo(file);
        pintarAdjuntos();
        marcarSucio();
      } catch (err) {
        mostrarError(err.message);
      }
    }

    dropzoneTexto.innerHTML = textoZona;
    dropzone.classList.remove("is-subiendo");
    ocupar(false);
  }

  function traeArchivos(e) {
    return !!e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types, "Files") !== -1;
  }

  // Toda la zona abre el selector; el botón interno está para el teclado y su
  // click llega aquí por burbujeo.
  dropzone.addEventListener("click", function () {
    if (!estado.ocupado) adjuntoInput.click();
  });

  adjuntoInput.addEventListener("change", function () {
    var archivos = Array.prototype.slice.call(adjuntoInput.files);
    adjuntoInput.value = "";
    subirArchivos(archivos);
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
    subirArchivos(Array.prototype.slice.call(e.dataTransfer.files));
  });

  /* Un archivo soltado fuera de la zona no debe abrirse en la pestaña y hacer
     perder todo lo escrito. */
  ["dragover", "drop"].forEach(function (tipoEvento) {
    window.addEventListener(tipoEvento, function (e) {
      if (traeArchivos(e) && !dropzone.contains(e.target)) e.preventDefault();
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
      b.disabled = activo;
      b.textContent = b.dataset.texto;
    });
    if (activo && boton) boton.textContent = texto;
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
    descartarPendientes();
    form.reset();
    todos(".gasto-item-fila", contenedor).forEach(function (fila) {
      fila.remove();
    });
    adjuntos = [];
    pintarAdjuntos();
    delete periodoDesde.dataset.manual;
    delete periodoHasta.dataset.manual;
    estado.borradorId = null;
    limpiarError();
    if (banco) banco.reiniciar();
  }

  function rellenar(borrador) {
    estado.borradorId = borrador.id;
    campoTitulo.value = borrador.title || "";
    byId("descripcion").value = borrador.description || "";
    byId("destino").value = borrador.destination || "";
    byId("neededBy").value = borrador.needed_by || "";
    fondoAsignado.value = montoParaCampo(borrador.assigned_amount);

    if (/^[a-z]+$/.test(borrador.fund_type || "")) {
      var radio = form.querySelector('input[name="fund_type"][value="' + borrador.fund_type + '"]');
      if (radio) radio.checked = true;
    }
    cargarCentro(borrador.cost_center_id);

    (borrador.items || []).forEach(function (item) {
      agregarFila(false, item);
    });
    if (!todos(".gasto-item-fila", contenedor).length) agregarFila(false);

    var fechas = fechasDesglose();
    fijarPeriodo(periodoDesde, borrador.period_start, fechas[0]);
    fijarPeriodo(periodoHasta, borrador.period_end, fechas[fechas.length - 1]);

    adjuntos = (borrador.attachments || []).map(function (a) {
      return { name: a.name, url: a.url, public_id: a.public_id };
    });
    pintarAdjuntos();

    if (banco) banco.cargar(borrador.bank_account);
  }

  function abrir(kind, borrador) {
    reiniciar();
    aplicarKind(kind);
    if (borrador) {
      rellenar(borrador);
    } else {
      agregarFila(false);
      derivarPeriodo();
    }
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

  function cerrar() {
    if (estado.ocupado) return;
    if (estado.sucio && !window.confirm("Tienes cambios sin guardar. ¿Cerrar de todos modos?")) {
      return;
    }
    estado.sucio = false;
    // Lo subido y no guardado se pierde al cerrar: se borra del bucket.
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
    if (e.key === "Escape" && window.IntranetModal.isOpen(overlay)) cerrar();
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
    var tipoFondo = form.querySelector('input[name="fund_type"]:checked');
    var cuerpo = {
      id: estado.borradorId,
      kind: estado.kind,
      fund_type: tipoFondo ? tipoFondo.value : "",
      title: campoTitulo.value,
      destination: byId("destino").value,
      period_start: periodoDesde.value || periodoHasta.value,
      period_end: periodoHasta.value || periodoDesde.value,
      description: byId("descripcion").value,
      items: leerItems(),
      attachments: adjuntos,
      assigned_amount: estado.kind === "rendicion" ? fondoAsignado.value : "",
      needed_by: estado.kind === "fondos" ? byId("neededBy").value : "",
      cost_center_id: centroElegido(),
    };
    if (banco) Object.assign(cuerpo, banco.leer());
    return cuerpo;
  }

  function enviar(cuerpo) {
    return fetch("/gastos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(cuerpo),
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw new Error(data.error || "No se pudo guardar la solicitud.");
        return data;
      });
    });
  }

  /* Valida en el orden en que se ven las secciones, para que el primer error
     sea el que el usuario tiene más arriba. */
  function validar() {
    if (!centroElegido()) {
      return { msg: "Elige el centro de costo.", campo: form.querySelector('input[name="cost_center_id"]') };
    }
    if (!campoTitulo.value.trim()) return { msg: "Indica el asunto.", campo: campoTitulo };
    if (!form.querySelector('input[name="fund_type"]:checked')) {
      return { msg: "Elige el tipo de fondo.", campo: form.querySelector('input[name="fund_type"]') };
    }

    var problemaItems = validarItems();
    if (problemaItems) return problemaItems;

    // El período es opcional; sólo se rechaza al revés.
    derivarPeriodo();
    if (periodoDesde.value && periodoHasta.value && periodoDesde.value > periodoHasta.value) {
      return { msg: "El período de gastos termina antes de empezar.", campo: periodoHasta };
    }

    if (estado.kind === "rendicion" && !adjuntos.length) {
      return { msg: "Adjunta al menos un comprobante.", campo: dropzone.querySelector("button") };
    }

    return banco ? banco.validar() : null;
  }

  btnBorrador.addEventListener("click", async function () {
    if (estado.ocupado) return;
    limpiarError();
    var cuerpo = leerCuerpo();
    cuerpo.draft = true;
    try {
      ocupar(true, btnBorrador, "Guardando…");
      var data = await enviar(cuerpo);
      // Ya viven en el borrador: dejan de ser descartables desde el cliente.
      subidosSinGuardar = [];
      estado.borradorId = data.id;
      estado.sucio = false;
      estado.listaDesactualizada = true;
      btnEliminarBorrador.hidden = false;
      mostrarEstado(textoBorrador(data.id, data.updatedAt));
    } catch (err) {
      mostrarError(err.message);
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

    var cuerpo = leerCuerpo();
    cuerpo.draft = false;
    try {
      ocupar(true, btnEnviar, "Enviando…");
      await enviar(cuerpo);
      subidosSinGuardar = [];
      estado.sucio = false;
      window.location.href = "/gastos?ok=1&msg=" + encodeURIComponent("Solicitud enviada.");
    } catch (err) {
      mostrarError(err.message);
      ocupar(false);
    }
  });

  btnEliminarBorrador.addEventListener("click", async function () {
    if (!estado.borradorId || estado.ocupado) return;
    if (!window.confirm("¿Descartar este borrador? Se borran también sus comprobantes.")) return;
    try {
      ocupar(true, btnEliminarBorrador, "Eliminando…");
      // Los guardados los borra el servidor con el borrador; los subidos
      // después del último guardado sólo los conoce el cliente.
      descartarPendientes();
      var res = await fetch("/gastos/" + estado.borradorId + "/borrador/eliminar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
      if (!res.ok && res.status !== 404) {
        var data = await res.json().catch(function () { return {}; });
        throw new Error(data.error || "No se pudo eliminar el borrador.");
      }
      estado.sucio = false;
      window.location.href = "/gastos?ok=1&msg=" + encodeURIComponent("Borrador eliminado.");
    } catch (err) {
      mostrarError(err.message);
      ocupar(false);
    }
  });

  // ── Apertura ─────────────────────────────────────────────────────────────

  function abrirBorrador(id) {
    if (!/^\d+$/.test(String(id))) return;
    fetch("/gastos/" + id + "/borrador", {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(function (res) {
        return res.json().catch(function () { return {}; }).then(function (data) {
          if (!res.ok) throw new Error(data.error || "No se pudo abrir el borrador.");
          return data;
        });
      })
      .then(function (borrador) {
        abrir(borrador.kind, borrador);
      })
      .catch(function (err) {
        window.alert(err.message);
      });
  }

  document.addEventListener("click", function (e) {
    var nueva = e.target.closest("[data-abrir-gasto]");
    if (nueva) {
      e.preventDefault();
      abrir(nueva.dataset.abrirGasto);
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
