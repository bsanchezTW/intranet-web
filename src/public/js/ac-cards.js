/**
 * Tarjetas de agrupación (Áreas de trabajo y Centros de costo).
 *
 * Las dos pantallas comparten el mismo problema: un grupo con cuarenta
 * personas hacía una tarjeta diez veces más alta que la de al lado. La
 * solución también es común y vive aquí: la tarjeta sólo resume, y tanto ver
 * la lista completa como agregar gente ocurre en un modal. Así todas las
 * tarjetas miden lo mismo y abrir una no deja aire bajo las demás.
 *
 * Todo lo que cambia entre una vista y otra viaja en el JSON #ac-config, así
 * que este archivo no sabe si está en Áreas o en Centros de costo.
 */
(function () {
  "use strict";

  var SEL_TARJETA = ".area-card, .centro-card";

  // Rango de marcas diacríticas combinantes, escrito con escapes para que el
  // archivo siga siendo ASCII y no dependa de cómo se sirva la codificación.
  var DIACRITICOS = new RegExp("[\\u0300-\\u036f]", "g");

  function todos(selector, raiz) {
    return Array.prototype.slice.call(
      (raiz || document).querySelectorAll(selector),
    );
  }

  /** Quita tildes para que "informatica" encuentre "Informática". */
  function normalizar(texto) {
    var base = String(texto || "").toLowerCase();
    return base.normalize ? base.normalize("NFD").replace(DIACRITICOS, "") : base;
  }

  function leerConfig() {
    var nodo = document.getElementById("ac-config");
    if (!nodo) return null;
    try {
      return JSON.parse(nodo.textContent) || null;
    } catch (error) {
      console.error("[Agrupaciones] Configuración inicial inválida:", error);
      return null;
    }
  }

  function plantilla(texto, valores) {
    return String(texto || "").replace(/\{(\w+)\}/g, function (todo, clave) {
      return Object.prototype.hasOwnProperty.call(valores, clave)
        ? valores[clave]
        : todo;
    });
  }

  function abrirModal(overlay) {
    if (window.IntranetModal) window.IntranetModal.open(overlay);
  }

  /* ── Filtros de la barra superior ──────────────────────────────────────── */

  var PREDICADOS = {
    todas: function () { return true; },
    todos: function () { return true; },
    "sin-jefe": function (card) { return card.dataset.sinJefe === "true"; },
    vacias: function (card) { return Number(card.dataset.miembros || 0) === 0; },
    activos: function (card) { return card.dataset.activo === "true"; },
    inactivos: function (card) { return card.dataset.activo === "false"; },
  };

  function initBarra() {
    var barra = document.querySelector(".ac-toolbar");
    if (!barra) return;

    var input = barra.querySelector(".ac-search__input");
    var chips = todos(".ac-chip", barra);
    var aviso = document.querySelector(".ac-sin-resultados");
    var tarjetas = todos(SEL_TARJETA);
    if (!tarjetas.length) return;

    var estado = { texto: "", filtro: "todas" };

    function aplicar() {
      var q = normalizar(estado.texto).trim();
      var predicado = PREDICADOS[estado.filtro] || PREDICADOS.todas;
      var visibles = 0;

      tarjetas.forEach(function (card) {
        var visible =
          predicado(card) &&
          (!q || normalizar(card.dataset.buscar).indexOf(q) !== -1);
        card.classList.toggle("is-oculta", !visible);
        if (visible) visibles += 1;
      });

      if (aviso) aviso.hidden = visibles > 0;
    }

    if (input) {
      input.addEventListener("input", function () {
        estado.texto = input.value;
        aplicar();
      });
      // Con el buscador enfocado, Escape limpia en vez de salir de la página.
      input.addEventListener("keydown", function (evento) {
        if (evento.key !== "Escape" || !input.value) return;
        evento.stopPropagation();
        input.value = "";
        estado.texto = "";
        aplicar();
      });
    }

    chips.forEach(function (chip) {
      chip.addEventListener("click", function () {
        chips.forEach(function (otro) {
          otro.classList.toggle("is-active", otro === chip);
        });
        estado.filtro = chip.dataset.filtro || "todas";
        aplicar();
      });
    });
  }

  /* ── Modales de lista ──────────────────────────────────────────────────── */

  function initModales(config) {
    var modalMiembros = document.getElementById("modalMiembros");
    var modalAgregar = document.getElementById("modalAgregar");
    if (!modalMiembros || !modalAgregar) return;

    var textos = config.textos || {};
    var porId = {};
    (config.personas || []).forEach(function (p) {
      porId[String(p.id)] = p;
    });
    var grupos = {};
    (config.grupos || []).forEach(function (g) {
      grupos[String(g.id)] = g;
    });

    var actual = null;

    // ── Piezas del modal "ver colaboradores"
    var tituloMiembros = document.getElementById("modalMiembrosTitle");
    var subMiembros = document.getElementById("modalMiembrosSub");
    var buscarMiembros = document.getElementById("modalMiembrosBuscar");
    var listaMiembros = document.getElementById("modalMiembrosLista");
    var vacioMiembros = document.getElementById("modalMiembrosVacio");
    var botonAgregar = document.getElementById("modalMiembrosAgregar");

    // ── Piezas del modal "agregar colaboradores"
    var formAgregar = document.getElementById("formAgregar");
    var subAgregar = document.getElementById("modalAgregarSub");
    var buscarAgregar = document.getElementById("modalAgregarBuscar");
    var listaAgregar = document.getElementById("modalAgregarLista");
    var vacioAgregar = document.getElementById("modalAgregarVacio");
    var seleccionAgregar = document.getElementById("modalAgregarSeleccion");
    var submitAgregar = document.getElementById("modalAgregarSubmit");

    /** Avatar: foto si la hay, inicial de color si no. */
    function avatar(persona) {
      if (!config.avatares) return null;
      if (persona.photo) {
        var img = document.createElement("img");
        img.src = persona.photo;
        img.alt = "";
        img.loading = "lazy";
        img.decoding = "async";
        img.className = "avatar ac-lista__avatar";
        return img;
      }
      var span = document.createElement("span");
      span.className = "monogram avatar-fallback ac-lista__avatar";
      if (persona.monogramStyle) span.style.cssText = persona.monogramStyle;
      span.setAttribute("aria-hidden", "true");
      span.textContent = persona.inicial || "?";
      return span;
    }

    function bloqueTexto(persona, detalle) {
      var cuerpo = document.createElement("span");
      cuerpo.className = "ac-lista__texto";

      var nombre = document.createElement("span");
      nombre.className = "ac-lista__nombre";
      nombre.textContent = persona.nombre;
      cuerpo.appendChild(nombre);

      if (detalle) {
        var sub = document.createElement("span");
        sub.className = "ac-lista__detalle";
        sub.textContent = detalle;
        cuerpo.appendChild(sub);
      }
      return cuerpo;
    }

    /* ── Lista de miembros del grupo ─────────────────────────────────────── */

    function filaMiembro(persona, grupo) {
      var li = document.createElement("li");
      li.className = "ac-lista__item";
      li.dataset.buscar = normalizar(persona.nombre);

      var av = avatar(persona);
      if (av) li.appendChild(av);

      var esDestacado =
        grupo.destacado != null && String(grupo.destacado) === String(persona.id);
      var detalle = esDestacado
        ? textos.destacado || null
        : config.detalleEnMiembros
          ? persona.detalle
          : null;
      li.appendChild(bloqueTexto(persona, detalle));

      if (esDestacado) {
        var marca = document.createElement("span");
        marca.className = "ac-lista__marca";
        marca.textContent = textos.destacadoCorto || "Jefe";
        li.appendChild(marca);
      }

      if (!config.puedeEditar) return li;

      var acciones = document.createElement("div");
      acciones.className = "ac-lista__acciones";

      // Mover de grupo: sólo Áreas lo ofrece, y lo resuelve su propio modal.
      if (config.permiteMover) {
        var mover = document.createElement("button");
        mover.type = "button";
        mover.className = "ac-lista__btn";
        mover.setAttribute("data-mover-miembro", "");
        mover.dataset.userId = persona.id;
        mover.dataset.nombre = persona.nombre;
        // El grupo de los que no tienen área no es un área: su id de destino va
        // vacío para que el modal de mover ofrezca "asignar" en vez de "mover".
        mover.dataset.areaId = grupo.moverId != null ? grupo.moverId : grupo.id;
        mover.dataset.areaName = grupo.moverId === "" ? "" : grupo.titulo;
        mover.title = textos.mover || "Cambiar de grupo";
        mover.setAttribute("aria-label", (textos.mover || "Cambiar") + ": " + persona.nombre);
        mover.innerHTML =
          '<svg class="icon-svg" viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>';
        acciones.appendChild(mover);
      }

      var form = document.createElement("form");
      form.method = "POST";
      form.action =
        config.base + "/" + grupo.id + "/miembros/" + persona.id + "/quitar";
      form.className = "ac-lista__form";

      var quitar = document.createElement("button");
      quitar.type = "submit";
      quitar.className = "ac-lista__btn ac-lista__btn--danger";
      quitar.setAttribute(
        "data-ac-confirmar",
        plantilla(textos.quitarConfirmar || "¿Quitar a {nombre}?", {
          nombre: persona.nombre,
          grupo: grupo.titulo,
        }),
      );
      quitar.title = textos.quitar || "Quitar";
      quitar.setAttribute("aria-label", (textos.quitar || "Quitar") + ": " + persona.nombre);
      quitar.innerHTML = "&times;";
      form.appendChild(quitar);
      acciones.appendChild(form);

      li.appendChild(acciones);
      return li;
    }

    function pintarMiembros(grupo) {
      listaMiembros.textContent = "";
      var ids = grupo.miembros || [];
      ids.forEach(function (id) {
        var persona = porId[String(id)];
        if (persona) listaMiembros.appendChild(filaMiembro(persona, grupo));
      });
      vacioMiembros.textContent = textos.miembrosVacio || "Sin colaboradores.";
      vacioMiembros.hidden = ids.length > 0;
      listaMiembros.hidden = ids.length === 0;
    }

    /* ── Lista de candidatos ─────────────────────────────────────────────── */

    function candidatos(grupo) {
      var dentro = {};
      (grupo.miembros || []).forEach(function (id) {
        dentro[String(id)] = true;
      });
      return (config.personas || []).filter(function (p) {
        return !dentro[String(p.id)];
      });
    }

    function filaCandidato(persona) {
      var li = document.createElement("li");
      li.className = "ac-lista__item ac-lista__item--seleccion";
      li.dataset.buscar = normalizar(persona.nombre);

      var label = document.createElement("label");
      label.className = "ac-lista__label";

      var check = document.createElement("input");
      check.type = "checkbox";
      check.name = "user_id";
      check.value = persona.id;
      check.className = "ac-lista__check";
      if (persona.bloqueado) check.disabled = true;
      if (persona.mueve) check.dataset.mueve = "true";
      label.appendChild(check);

      var av = avatar(persona);
      if (av) label.appendChild(av);

      label.appendChild(
        bloqueTexto(persona, persona.bloqueado ? persona.motivo : persona.detalle),
      );

      if (persona.bloqueado) li.classList.add("is-bloqueada");
      li.appendChild(label);
      return li;
    }

    function actualizarSeleccion() {
      var marcados = todos(".ac-lista__check:checked", listaAgregar);
      submitAgregar.disabled = marcados.length === 0;
      submitAgregar.textContent = marcados.length
        ? "Agregar (" + marcados.length + ")"
        : "Agregar";
      seleccionAgregar.hidden = marcados.length === 0;
      seleccionAgregar.textContent =
        marcados.length === 1
          ? "1 colaborador seleccionado"
          : marcados.length + " colaboradores seleccionados";
    }

    function pintarCandidatos(grupo) {
      listaAgregar.textContent = "";
      var lista = candidatos(grupo);
      lista.forEach(function (persona) {
        listaAgregar.appendChild(filaCandidato(persona));
      });
      vacioAgregar.textContent =
        textos.candidatosVacio || "No queda nadie por agregar.";
      vacioAgregar.hidden = lista.length > 0;
      listaAgregar.hidden = lista.length === 0;
      actualizarSeleccion();
    }

    /* ── Filtro dentro de un modal ───────────────────────────────────────── */

    function filtrarLista(input, lista, vacio, textoVacio) {
      var q = normalizar(input.value).trim();
      var visibles = 0;
      todos(".ac-lista__item", lista).forEach(function (li) {
        var visible = !q || li.dataset.buscar.indexOf(q) !== -1;
        li.classList.toggle("is-oculta", !visible);
        if (visible) visibles += 1;
      });
      if (q && !visibles) {
        vacio.textContent = "Nadie coincide con «" + input.value.trim() + "».";
        vacio.hidden = false;
      } else if (q) {
        vacio.hidden = true;
      } else {
        vacio.textContent = textoVacio;
        vacio.hidden = lista.children.length > 0;
      }
      // La lista se estira para llenar el modal: sin filas visibles dejaría un
      // recuadro vacío enorme encima del mensaje.
      lista.hidden = visibles === 0;
    }

    /* ── Apertura ────────────────────────────────────────────────────────── */

    function abrirMiembros(grupoId) {
      var grupo = grupos[String(grupoId)];
      if (!grupo) return;
      actual = grupo;

      tituloMiembros.textContent = grupo.titulo;
      subMiembros.textContent = grupo.subtitulo || "";
      subMiembros.hidden = !grupo.subtitulo;
      buscarMiembros.value = "";
      pintarMiembros(grupo);
      // El buscador sólo estorba en una lista que cabe entera en pantalla.
      buscarMiembros.parentElement.hidden = (grupo.miembros || []).length < 8;
      botonAgregar.hidden = !(config.puedeEditar && grupo.puedeAgregar);
      botonAgregar.textContent = textos.agregarBoton || "Agregar colaboradores";
      abrirModal(modalMiembros);
    }

    function abrirAgregar(grupoId) {
      var grupo = grupos[String(grupoId)];
      if (!grupo || !config.puedeEditar || !grupo.puedeAgregar) return;
      actual = grupo;

      formAgregar.action = config.base + "/" + grupo.id + "/miembros";
      subAgregar.textContent = plantilla(textos.agregarSub || "", {
        grupo: grupo.titulo,
      });
      subAgregar.hidden = !subAgregar.textContent;
      buscarAgregar.value = "";
      pintarCandidatos(grupo);
      abrirModal(modalAgregar);
    }

    /* ── Enganches ───────────────────────────────────────────────────────── */

    document.addEventListener("click", function (evento) {
      var destino = evento.target;
      if (!destino || !destino.closest) return;

      var ver = destino.closest("[data-ver-miembros]");
      if (ver) {
        abrirMiembros(ver.dataset.verMiembros);
        return;
      }

      var agregar = destino.closest("[data-agregar-miembros]");
      if (agregar) {
        abrirAgregar(agregar.dataset.agregarMiembros);
        return;
      }

      // "Agregar" y "mover" se piden desde la lista de colaboradores y abren
      // un segundo modal encima. La lista se queda detrás a propósito: cerrarla
      // hacía desaparecer el contexto de lo que se estaba decidiendo, y al
      // cancelar el usuario quedaba en la página en vez de volver a la lista.
      // IntranetModal apila: el segundo modal sube por encima del primero.
      if (destino.closest("#modalMiembrosAgregar")) {
        if (actual) abrirAgregar(actual.id);
        return;
      }
    });

    document.addEventListener("submit", function (evento) {
      var form = evento.target;
      if (!form || form.tagName !== "FORM") return;
      var boton = form.querySelector("[data-ac-confirmar]");
      if (!boton || boton.disabled) return;
      if (!window.confirm(boton.dataset.acConfirmar)) evento.preventDefault();
    });

    listaAgregar.addEventListener("change", actualizarSeleccion);

    buscarMiembros.addEventListener("input", function () {
      filtrarLista(
        buscarMiembros,
        listaMiembros,
        vacioMiembros,
        textos.miembrosVacio || "Sin colaboradores.",
      );
    });

    buscarAgregar.addEventListener("input", function () {
      filtrarLista(
        buscarAgregar,
        listaAgregar,
        vacioAgregar,
        textos.candidatosVacio || "No queda nadie por agregar.",
      );
    });

    formAgregar.addEventListener("submit", function (evento) {
      var marcados = todos(".ac-lista__check:checked", listaAgregar);
      if (!marcados.length) {
        evento.preventDefault();
        return;
      }
      // Agregar a alguien que ya está en otro grupo lo mueve; en Áreas eso le
      // cambia quién le aprueba los gastos, así que se avisa antes.
      var mueven = marcados.filter(function (c) {
        return c.dataset.mueve === "true";
      });
      if (!mueven.length || !textos.confirmarMover) return;
      var texto =
        mueven.length === 1 && textos.confirmarMoverUno
          ? textos.confirmarMoverUno
          : textos.confirmarMover;
      var mensaje = plantilla(texto, {
        n: mueven.length,
        grupo: actual ? actual.titulo : "",
      });
      if (!window.confirm(mensaje)) evento.preventDefault();
    });
  }

  function init() {
    // Los oyentes son delegados en document: si el archivo se cargara dos veces
    // cada clic se atendería dos veces.
    if (window.__acCardsListo) return;
    window.__acCardsListo = true;

    initBarra();
    var config = leerConfig();
    if (config) initModales(config);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
