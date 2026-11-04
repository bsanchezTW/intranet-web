/**
 * Historial del vehículo · Kilometraje: gráfico de línea de las lecturas
 * (revisiones y correcciones de la ficha). Lo dibuja al ancho de su caja, con
 * una guía vertical y un recuadro al pasar el mouse, tocar o moverse con las
 * flechas. Los datos van en #kmDatos; la tabla de la página es la versión
 * accesible y la de respaldo sin JavaScript.
 */
(function () {
  "use strict";

  const caja = document.querySelector("[data-km-grafico]");
  const nodo = document.getElementById("kmDatos");
  if (!caja || !nodo) return;
  const datos = JSON.parse(nodo.textContent)
    .map((d) => ({ ...d, t: Date.parse(`${d.fecha}T12:00:00Z`) }))
    .filter((d) => Number.isFinite(d.km) && Number.isFinite(d.t));
  if (!datos.length) return;

  const SVG = "http://www.w3.org/2000/svg";
  const num = new Intl.NumberFormat("es-CL");
  const mes = new Intl.DateTimeFormat("es-CL", { month: "short", year: "2-digit", timeZone: "UTC" });
  const DIA = 86400000;

  const el = (tag, attrs = {}, padre) => {
    const n = document.createElementNS(SVG, tag);
    Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v));
    if (padre) padre.appendChild(n);
    return n;
  };

  /** Paso "redondo" (1, 2, 2,5 o 5 × 10^n) para unas cuatro divisiones. */
  function pasoRedondo(rango) {
    const crudo = rango / 4;
    const base = 10 ** Math.floor(Math.log10(crudo));
    const f = crudo / base;
    return base * (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10);
  }

  const tip = document.createElement("div");
  tip.className = "km-grafico__tip";
  tip.setAttribute("role", "status");
  tip.hidden = true;
  caja.appendChild(tip);

  let estado = null;

  function dibujar() {
    const ancho = caja.clientWidth;
    if (!ancho) return;
    const alto = Math.round(Math.min(320, Math.max(220, ancho * 0.4)));
    caja.querySelectorAll("svg").forEach((s) => s.remove());

    const kms = datos.map((d) => d.km);
    let yMin = Math.min(...kms);
    let yMax = Math.max(...kms);
    if (yMax - yMin < 100) { yMin -= 500; yMax += 500; }
    const paso = pasoRedondo(yMax - yMin);
    yMin = Math.max(0, Math.floor(yMin / paso) * paso);
    yMax = Math.ceil(yMax / paso) * paso;

    let tMin = datos[0].t;
    let tMax = datos[datos.length - 1].t;
    if (tMax - tMin < 14 * DIA) { tMin -= 15 * DIA; tMax += 15 * DIA; }

    const etiquetaMasLarga = `${num.format(yMax)}`.length;
    const m = { izq: 14 + etiquetaMasLarga * 7.2, der: 18, arr: 14, aba: 30 };
    const w = ancho - m.izq - m.der;
    const h = alto - m.arr - m.aba;
    const x = (t) => m.izq + ((t - tMin) / (tMax - tMin)) * w;
    const y = (km) => m.arr + h - ((km - yMin) / (yMax - yMin)) * h;

    const svg = el("svg", { width: ancho, height: alto, viewBox: `0 0 ${ancho} ${alto}`, class: "km-grafico__svg", "aria-hidden": "true" });

    // Rejilla y eje y.
    const rejilla = el("g", { class: "km-grafico__rejilla" }, svg);
    for (let v = yMin; v <= yMax + paso / 2; v += paso) {
      el("line", { x1: m.izq, x2: m.izq + w, y1: y(v), y2: y(v) }, rejilla);
      const texto = el("text", { x: m.izq - 8, y: y(v) + 4, "text-anchor": "end", class: "km-grafico__eje" }, svg);
      texto.textContent = num.format(v);
    }

    // Eje x: inicios de mes, sin amontonarse.
    const meses = [];
    const d0 = new Date(tMin);
    let cursor = Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() + 1, 1);
    while (cursor <= tMax) {
      meses.push(cursor);
      const c = new Date(cursor);
      cursor = Date.UTC(c.getUTCFullYear(), c.getUTCMonth() + 1, 1);
    }
    const caben = Math.max(1, Math.floor(w / 70));
    const cada = Math.max(1, Math.ceil(meses.length / caben));
    meses.forEach((t, i) => {
      if (i % cada) return;
      el("line", { x1: x(t), x2: x(t), y1: m.arr + h, y2: m.arr + h + 4, class: "km-grafico__marca" }, svg);
      const texto = el("text", { x: x(t), y: alto - 8, "text-anchor": "middle", class: "km-grafico__eje" }, svg);
      texto.textContent = mes.format(new Date(t)).replace(".", "");
    });
    el("line", { x1: m.izq, x2: m.izq + w, y1: m.arr + h, y2: m.arr + h, class: "km-grafico__base" }, svg);

    // Línea y puntos.
    const serie = el("g", { class: "km-grafico__serie" }, svg);
    if (datos.length > 1) {
      el("path", { d: datos.map((d, i) => `${i ? "L" : "M"}${x(d.t).toFixed(1)},${y(d.km).toFixed(1)}`).join(""), class: "km-grafico__linea" }, serie);
    }
    const guia = el("line", { y1: m.arr, y2: m.arr + h, class: "km-grafico__guia", visibility: "hidden" }, svg);
    const puntos = datos.map((d) => el("circle", {
      cx: x(d.t), cy: y(d.km), r: 4, class: `km-grafico__dato${d.fuente === "ficha" || d.fuente === "alta" ? " is-ficha" : ""}`,
    }, serie));

    // Zona de contacto: todo el área del gráfico.
    const area = el("rect", { x: m.izq, y: m.arr, width: w, height: h, class: "km-grafico__area", tabindex: "0", "aria-label": "Lecturas de kilometraje: usa las flechas para recorrerlas" }, svg);
    area.removeAttribute("aria-hidden");
    svg.removeAttribute("aria-hidden");
    caja.insertBefore(svg, tip);
    const previo = estado && estado.activo;
    estado = { x, y, puntos, guia, area, ancho, activo: null };
    if (previo != null) mostrar(previo);
  }

  function cercano(clientX) {
    const r = caja.getBoundingClientRect();
    const px = clientX - r.left;
    let mejor = 0;
    datos.forEach((d, i) => {
      if (Math.abs(estado.x(d.t) - px) < Math.abs(estado.x(datos[mejor].t) - px)) mejor = i;
    });
    return mejor;
  }

  function mostrar(i) {
    if (!estado) return;
    const d = datos[i];
    estado.activo = i;
    estado.puntos.forEach((p, j) => p.classList.toggle("is-activo", j === i));
    const px = estado.x(d.t);
    estado.guia.setAttribute("x1", px);
    estado.guia.setAttribute("x2", px);
    estado.guia.setAttribute("visibility", "visible");
    tip.innerHTML = "";
    const fuerte = document.createElement("strong");
    fuerte.textContent = d.kmTexto;
    const fecha = document.createElement("span");
    fecha.textContent = d.fechaTexto;
    const origen = document.createElement("span");
    origen.className = "km-grafico__tip-origen";
    origen.textContent = d.numero ? `${d.texto} ${d.numero}` : d.texto;
    tip.append(fuerte, fecha, origen);
    tip.hidden = false;
    const tw = tip.offsetWidth;
    const izq = Math.min(Math.max(px - tw / 2, 4), estado.ancho - tw - 4);
    tip.style.left = `${izq}px`;
    tip.style.top = `${Math.max(estado.y(d.km) - tip.offsetHeight - 14, 0)}px`;
  }

  function ocultar() {
    if (!estado) return;
    estado.activo = null;
    estado.puntos.forEach((p) => p.classList.remove("is-activo"));
    estado.guia.setAttribute("visibility", "hidden");
    tip.hidden = true;
  }

  caja.addEventListener("pointermove", (e) => { if (estado) mostrar(cercano(e.clientX)); });
  caja.addEventListener("pointerdown", (e) => { if (estado) mostrar(cercano(e.clientX)); });
  caja.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse") ocultar(); });
  caja.addEventListener("keydown", (e) => {
    if (!estado || !["ArrowLeft", "ArrowRight", "Home", "End", "Escape"].includes(e.key)) return;
    e.preventDefault();
    if (e.key === "Escape") return ocultar();
    const actual = estado.activo ?? (e.key === "ArrowLeft" ? datos.length : -1);
    const siguiente = e.key === "Home" ? 0 : e.key === "End" ? datos.length - 1
      : Math.min(datos.length - 1, Math.max(0, actual + (e.key === "ArrowLeft" ? -1 : 1)));
    mostrar(siguiente);
  });
  caja.addEventListener("focusout", ocultar);

  new ResizeObserver(() => dibujar()).observe(caja);
  dibujar();
})();
