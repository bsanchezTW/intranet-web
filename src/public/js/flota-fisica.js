/**
 * Revisión física (Gestión de flota): el panel de la zona elegida, los daños
 * nuevos con sus fotos y el envío.
 *
 * El visor (flota-modelo.js) avisa la zona con el evento "flota:zona". Aquí se
 * muestran los daños que la zona ya tiene abiertos y, para quien registra, el
 * formulario de un daño nuevo: tipo, observación y de 1 a 4 fotos, que se
 * reducen en el teléfono. Los daños quedan en la página (y en ámbar sobre el
 * modelo) hasta guardar la revisión, que sube todo junto con las capturas
 * del modelo desde los cuatro lados para el PDF.
 */
(function () {
  "use strict";

  const nodoDatos = document.getElementById("fisicaDatos");
  const nodoModelo = document.getElementById("modeloDatos");
  if (!nodoDatos || !nodoModelo) return;
  const datos = JSON.parse(nodoDatos.textContent);
  const zonas = new Map(JSON.parse(nodoModelo.textContent).model.zones.map((z) => [z.code, z]));
  const tipos = new Map(datos.tipos.map((t) => [t.value, t.label]));
  const VISTAS_CAPTURA = ["izquierdo", "derecho", "frente", "atras"];

  const panel = document.querySelector("[data-zona-panel]");
  const panelAbiertos = panel && panel.querySelector("[data-zona-abiertos]");
  const panelNuevos = panel && panel.querySelector("[data-zona-nuevos]");
  const formDanio = panel && panel.querySelector("[data-danio-form]");
  const form = document.querySelector("[data-fisica-form]");

  const abiertosPorZona = new Map();
  datos.abiertos.forEach((d) => {
    if (!abiertosPorZona.has(d.zone)) abiertosPorZona.set(d.zone, []);
    abiertosPorZona.get(d.zone).push(d);
  });

  /** Daños nuevos: { zone, type, description, fotos: [{ blob, url, listo }] } */
  const nuevos = [];
  let zonaActual = null;
  let enviado = false;

  const el = (tag, clase, texto) => {
    const n = document.createElement(tag);
    if (clase) n.className = clase;
    if (texto != null) n.textContent = texto;
    return n;
  };
  const toast = (texto, tone) => window.IntranetToast && window.IntranetToast.show(texto, { tone: tone || "ok" });

  // --- Marcas en el modelo y en la lista de zonas --------------------------------

  function estadoDe(code) {
    if (nuevos.some((d) => d.zone === code)) return "nuevo";
    if (abiertosPorZona.has(code)) return "danio";
    return null;
  }

  function marcarZona(code) {
    if (window.flotaModelo) window.flotaModelo.marcar(code, estadoDe(code));
    const total = (abiertosPorZona.get(code) || []).length + nuevos.filter((d) => d.zone === code).length;
    document.querySelectorAll(`.fisica-zona-btn[data-zona="${code}"] [data-zona-marca]`).forEach((m) => {
      m.textContent = total ? String(total) : "";
    });
  }

  function marcarTodo() {
    const codes = new Set([...abiertosPorZona.keys(), ...nuevos.map((d) => d.zone)]);
    codes.forEach(marcarZona);
  }

  // --- Panel de la zona -----------------------------------------------------------

  function miniatura(src, alt) {
    const img = el("img");
    img.src = src;
    img.alt = alt || "";
    img.loading = "lazy";
    img.decoding = "async";
    return img;
  }

  function filaAbierto(d) {
    const li = el("li", "fisica-zona__danio");
    const a = el("a", "fisica-zona__danio-foto");
    a.href = `${datos.daniosUrl}/${d.id}`;
    if (d.fotos.length) a.appendChild(miniatura(`${datos.fotosUrl}/${d.fotos[0]}`, ""));
    const texto = el("div", "fisica-zona__danio-texto");
    const titulo = el("a", "fisica-zona__danio-tipo", d.tipo);
    titulo.href = `${datos.daniosUrl}/${d.id}`;
    texto.append(titulo, el("p", "fisica-zona__danio-desc", d.descripcion), el("p", "fisica-zona__danio-meta", `Abierto desde ${d.desde}`));
    li.append(a, texto);
    return li;
  }

  function pintarPanel() {
    if (!panel || !zonaActual) return;
    const abiertos = abiertosPorZona.get(zonaActual) || [];
    panelAbiertos.innerHTML = "";
    if (abiertos.length) {
      panelAbiertos.appendChild(el("h4", "fisica-zona__subtitulo", abiertos.length === 1 ? "Ya registrado en esta zona" : `Ya registrados en esta zona (${abiertos.length})`));
      const ul = el("ul", "fisica-zona__danios");
      abiertos.forEach((d) => ul.appendChild(filaAbierto(d)));
      panelAbiertos.appendChild(ul);
    } else if (!datos.puedeRegistrar) {
      panelAbiertos.appendChild(el("p", "fisica-zona__vacio", "Esta zona no tiene daños abiertos."));
    }

    panelNuevos.innerHTML = "";
    const deLaZona = nuevos.filter((d) => d.zone === zonaActual);
    if (deLaZona.length) {
      panelNuevos.appendChild(el("h4", "fisica-zona__subtitulo", deLaZona.length === 1 ? "Nuevo en esta revisión" : `Nuevos en esta revisión (${deLaZona.length})`));
      const ul = el("ul", "fisica-zona__danios");
      deLaZona.forEach((d) => {
        const li = el("li", "fisica-zona__danio is-nuevo");
        const foto = el("span", "fisica-zona__danio-foto");
        if (d.fotos[0]) foto.appendChild(miniatura(d.fotos[0].url, ""));
        const texto = el("div", "fisica-zona__danio-texto");
        texto.append(el("span", "fisica-zona__danio-tipo", tipos.get(d.type)), el("p", "fisica-zona__danio-desc", d.description),
          el("p", "fisica-zona__danio-meta", `${d.fotos.length} ${d.fotos.length === 1 ? "foto" : "fotos"} · se guarda con la revisión`));
        li.append(foto, texto);
        ul.appendChild(li);
      });
      panelNuevos.appendChild(ul);
    }
  }

  // --- Formulario de un daño ------------------------------------------------------

  let selFotos = null;
  const errorDanio = formDanio && formDanio.querySelector("[data-danio-error]");
  const descDanio = formDanio && formDanio.querySelector("#danio_desc");

  function limpiarFormDanio() {
    if (!formDanio) return;
    formDanio.querySelectorAll("input[name=danio_tipo]").forEach((r) => { r.checked = false; });
    descDanio.value = "";
    if (selFotos) selFotos.limpiar();
    errorDanio.hidden = true;
  }

  if (formDanio && window.FlotaFotos) {
    selFotos = window.FlotaFotos.selector(formDanio.querySelector("[data-fotos]"), { max: datos.maxFotos });
    formDanio.querySelector("[data-danio-agregar]").addEventListener("click", () => {
      const tipo = (formDanio.querySelector("input[name=danio_tipo]:checked") || {}).value;
      const descripcion = descDanio.value.trim();
      const problemas = [];
      if (!tipo) problemas.push("Elige el tipo de daño.");
      if (descripcion.length < 3) problemas.push("Describe el daño en pocas palabras.");
      if (selFotos.cantidad() < 1) problemas.push("Agrega al menos una foto.");
      if (nuevos.length >= datos.maxDanios) problemas.push(`Son ${datos.maxDanios} daños nuevos por revisión como máximo.`);
      if (problemas.length) {
        errorDanio.textContent = problemas.join(" ");
        errorDanio.hidden = false;
        return;
      }
      nuevos.push({ zone: zonaActual, type: tipo, description: descripcion, fotos: selFotos.soltar() });
      limpiarFormDanio();
      marcarZona(zonaActual);
      pintarPanel();
      pintarResumen();
      toast(`Daño agregado en ${zonas.get(zonaActual).label}. Se guarda con la revisión.`);
    });
  }

  document.addEventListener("flota:zona", (e) => {
    const cambio = zonaActual !== e.detail.code;
    zonaActual = e.detail.code;
    if (cambio) limpiarFormDanio();
    pintarPanel();
    if (panel) {
      const r = panel.getBoundingClientRect();
      if (r.top < 70 || r.top > window.innerHeight * 0.7) panel.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });

  const cerrar = panel && panel.querySelector("[data-zona-cerrar]");
  if (cerrar) cerrar.addEventListener("click", () => { panel.hidden = true; });

  // --- Resumen de daños nuevos ------------------------------------------------------

  const resumen = form && form.querySelector("[data-nuevos-lista]");
  const resumenConteo = form && form.querySelector("[data-nuevos-conteo]");
  const textoVacio = resumen ? resumen.innerHTML : "";

  function pintarResumen(errores) {
    if (!resumen) return;
    resumenConteo.textContent = String(nuevos.length);
    if (!nuevos.length) {
      resumen.innerHTML = textoVacio;
      return;
    }
    resumen.innerHTML = "";
    const ul = el("ul", "fisica-nuevos");
    nuevos.forEach((d, i) => {
      const zona = zonas.get(d.zone);
      const li = el("li", "fisica-nuevo");
      const error = errores && errores[`danio_${i}`];
      if (error) li.classList.add("is-invalid");
      const head = el("div", "fisica-nuevo__head");
      const num = el("span", "fisica-nuevo__num", String(i + 1));
      const titulo = el("div", "fisica-nuevo__titulo");
      titulo.append(el("strong", null, zona ? zona.label : d.zone), el("span", "fisica-nuevo__tipo", tipos.get(d.type)));
      const acciones = el("div", "fisica-nuevo__acciones");
      const ver = el("button", "cfg-icono");
      ver.type = "button";
      ver.title = "Ver en el modelo";
      ver.setAttribute("aria-label", `Ver ${zona ? zona.label : ""} en el modelo`);
      ver.innerHTML = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>';
      ver.addEventListener("click", () => window.flotaModelo && window.flotaModelo.seleccionar(d.zone));
      const quitar = el("button", "cfg-icono cfg-icono--peligro");
      quitar.type = "button";
      quitar.title = "Quitar este daño";
      quitar.setAttribute("aria-label", `Quitar el daño ${i + 1}`);
      quitar.innerHTML = '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';
      quitar.addEventListener("click", async () => {
        const ok = window.IntranetDialog
          ? await window.IntranetDialog.confirm({ title: "¿Quitar este daño?", message: `Se quita el daño de ${zona ? zona.label : "la zona"} y sus fotos de esta revisión.`, acceptLabel: "Quitar", tone: "peligro" })
          : true;
        if (!ok) return;
        const [quitado] = nuevos.splice(i, 1);
        quitado.fotos.forEach((f) => URL.revokeObjectURL(f.url));
        marcarZona(quitado.zone);
        pintarPanel();
        pintarResumen();
      });
      acciones.append(ver, quitar);
      head.append(num, titulo, acciones);
      li.append(head, el("p", "fisica-nuevo__desc", d.description));
      const fotos = el("ul", "fisica-nuevo__fotos");
      d.fotos.forEach((f, j) => {
        const item = el("li");
        item.appendChild(miniatura(f.url, `Foto ${j + 1}`));
        fotos.appendChild(item);
      });
      li.appendChild(fotos);
      if (error) li.appendChild(el("p", "campo-form__error", error));
      ul.appendChild(li);
    });
    resumen.appendChild(ul);
  }

  // --- Conductor ------------------------------------------------------------------

  const conductor = form && form.querySelector("[data-conductor]");
  const conductorOtro = form && form.querySelector("[data-conductor-otro]");
  if (conductor && conductorOtro) {
    conductor.addEventListener("change", () => {
      conductorOtro.hidden = conductor.value !== "otro";
      if (!conductorOtro.hidden) conductorOtro.querySelector("input").focus();
    });
  }

  // --- Envío ------------------------------------------------------------------------

  function capturas() {
    const salida = {};
    if (!window.flotaModelo || !window.flotaModelo.listo) return salida;
    VISTAS_CAPTURA.forEach((vista) => {
      try {
        const url = window.flotaModelo.capturar(vista);
        if (url) salida[vista] = window.FlotaFotos.dataUrlABlob(url);
      } catch (err) {
        console.warn("[flota-fisica] captura", vista, err);
      }
    });
    return salida;
  }

  function mostrarErrores(errors) {
    window.FlotaFotos.mostrarErrores(form, Object.fromEntries(Object.entries(errors).filter(([k]) => !/^danio_\d+$/.test(k))));
    const deDanios = Object.keys(errors).filter((k) => /^danio_\d+$/.test(k));
    pintarResumen(errors);
    if (deDanios.length) {
      const nodo = form.querySelector('[data-error-for="danios"]');
      nodo.textContent = deDanios.length === 1 ? "Revisa el daño marcado." : "Revisa los daños marcados.";
      nodo.hidden = false;
    }
    const primero = form.querySelector(".is-invalid, [data-error-for]:not([hidden]), [data-form-error]:not([hidden])");
    if (primero) primero.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  if (form) {
    const boton = form.querySelector("[data-guardar]");
    const botonTexto = form.querySelector("[data-guardar-texto]");
    let enviando = false;

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (enviando) return;
      if (!nuevos.length && window.IntranetDialog) {
        const ok = await window.IntranetDialog.confirm({
          title: "¿Guardar sin daños nuevos?",
          message: "La revisión quedará registrada indicando que no encontraste daños nuevos.",
          acceptLabel: "Guardar",
        });
        if (!ok) return;
      }
      enviando = true;
      boton.disabled = true;
      boton.classList.add("is-cargando");
      botonTexto.textContent = nuevos.length ? "Subiendo fotos…" : "Guardando…";
      try {
        const cuerpo = new FormData(form);
        cuerpo.append("danios", JSON.stringify(nuevos.map((d) => ({ zone: d.zone, type: d.type, description: d.description }))));
        for (const [i, d] of nuevos.entries()) {
          const blobs = await Promise.all(d.fotos.map((f) => f.listo));
          blobs.forEach((b, j) => cuerpo.append(`foto_${i}`, b, `danio-${i + 1}-${j + 1}.jpg`));
        }
        Object.entries(capturas()).forEach(([vista, blob]) => cuerpo.append(`captura_${vista}`, blob, `captura-${vista}.jpg`));
        const res = await fetch(datos.postUrl, {
          method: "POST",
          body: cuerpo,
          credentials: "same-origin",
          headers: { "X-Requested-With": "fetch", Accept: "application/json" },
        });
        const json = await res.json().catch(() => ({ errors: { general: "No se pudo guardar. Vuelve a intentarlo." } }));
        if (json.ok && json.redirect) {
          enviado = true;
          window.location.href = json.redirect;
          return;
        }
        mostrarErrores(json.errors || { general: "No se pudo guardar." });
      } catch (err) {
        console.error("[flota-fisica]", err);
        mostrarErrores({ general: "Sin conexión: no se pudo guardar. Tus daños siguen aquí; vuelve a intentarlo." });
      }
      enviando = false;
      boton.disabled = false;
      boton.classList.remove("is-cargando");
      botonTexto.textContent = "Guardar revisión";
    });

    window.addEventListener("beforeunload", (e) => {
      if (enviado || !nuevos.length) return;
      e.preventDefault();
      e.returnValue = "";
    });
  }

  marcarTodo();
  document.addEventListener("flota:modelo-listo", marcarTodo);
})();
