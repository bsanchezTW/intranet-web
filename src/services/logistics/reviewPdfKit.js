const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { getCountryConfig } = require("../../config/country");
const { formatDisplay } = require("../../utils/vacationDateUtils");

/**
 * Piezas comunes de los PDF de Gestión de flota (revisión mecánica y física),
 * para que los dos hablen el mismo lenguaje visual: A4 vertical en hoja
 * blanca, encabezado con el logo y el número, una franja con la patente y el
 * resultado, datos en tarjetas, secciones con título, observaciones, firmas
 * y un pie con «Página n de N».
 *
 * El pie y el sello de anulada se dibujan al final, sobre todas las hojas
 * (el documento se crea con bufferPages).
 */

// El de 4000 px lo decodifica pdfkit entero (png-js) y en cPanel el proceso
// muere por falta de memoria. Esta copia mide 800 px.
const LOGO_PATH = path.join(__dirname, "..", "billsOfExchange", "logotw_blue_print.png");

const C = Object.freeze({
  brand: "#26388f",
  brandDeep: "#1b2a6e",
  ink: "#1b2433",
  text: "#344054",
  muted: "#667085",
  faint: "#98a2b3",
  line: "#e2e6ed",
  soft: "#f4f6fa",
  white: "#ffffff",
  green: "#1f7a3a",
  greenSoft: "#e5f3ea",
  amber: "#8a5a00",
  amberSoft: "#fbf0d4",
  red: "#c0262d",
  redSoft: "#fbe9e9",
  gray: "#475467",
  graySoft: "#eceff3",
});

/** Tono de una etiqueta: [texto, fondo]. */
const TONES = Object.freeze({
  ok: [C.green, C.greenSoft],
  warn: [C.amber, C.amberSoft],
  bad: [C.red, C.redSoft],
  neutral: [C.gray, C.graySoft],
  brand: [C.brand, "#e8ebf7"],
});

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 32;
const CONTENT_W = PAGE_W - 2 * MARGIN;
/** Hasta dónde se dibuja contenido: más abajo va el pie. */
const BOTTOM = PAGE_H - MARGIN - 16;

function fmtDate(value) {
  return value ? formatDisplay(value).replace(/-/g, "/") : "—";
}

function fmtDateTime(value) {
  if (!value) return "—";
  const { locale, timezone } = getCountryConfig();
  return new Date(value).toLocaleString(locale, { dateStyle: "short", timeStyle: "short", timeZone: timezone });
}

/** Documento en blanco y su buffer cuando `draw` termina. */
function renderPdf(title, draw) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      autoFirstPage: false,
      bufferPages: true,
      info: { Title: title, Creator: "Intranet Transworld" },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      draw(doc);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Encabezado de cada hoja: logo a la izquierda; a la derecha el área, el
 * título del documento y su número. `ctx`: { title, number, area? }; sin
 * `area` dice «Logística · Gestión de flota».
 */
function drawHeader(doc, ctx) {
  if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, MARGIN, MARGIN + 8, { height: 22 });
  doc.font(FONT_BOLD).fontSize(6.5).fillColor(C.muted)
    .text(ctx.area || "LOGÍSTICA · GESTIÓN DE FLOTA", MARGIN, MARGIN, { width: CONTENT_W, align: "right", characterSpacing: 0.8, lineBreak: false });
  doc.font(FONT_BOLD).fontSize(16).fillColor(C.brand)
    .text(ctx.title, MARGIN, MARGIN + 10, { width: CONTENT_W, align: "right", lineBreak: false });
  doc.font(FONT).fontSize(8.5).fillColor(C.muted)
    .text(`N° ${ctx.number}`, MARGIN, MARGIN + 30, { width: CONTENT_W, align: "right", lineBreak: false });
  doc.moveTo(MARGIN, MARGIN + 43).lineTo(PAGE_W - MARGIN, MARGIN + 43).lineWidth(0.75).strokeColor(C.line).stroke();
  return MARGIN + 51;
}

/** Abre la primera hoja. Devuelve la y para seguir. */
function startDoc(doc, ctx) {
  doc.addPage();
  return drawHeader(doc, ctx);
}

/** Si no cabe `needed`, abre otra hoja. Devuelve la y para seguir. */
function ensure(doc, ctx, y, needed) {
  if (y + needed <= BOTTOM) return y;
  doc.addPage();
  return drawHeader(doc, ctx);
}

/**
 * Etiqueta redondeada. Con `align: "right"`, `x` es el borde derecho.
 * Devuelve su ancho.
 */
function drawPill(doc, x, y, text, tone = "neutral", { size = 7.5, h = 15, padX = 7, align = "left" } = {}) {
  const [color, fondo] = TONES[tone] || TONES.neutral;
  doc.font(FONT_BOLD).fontSize(size);
  const w = doc.widthOfString(text, { characterSpacing: 0.3 }) + 2 * padX;
  const left = align === "right" ? x - w : x;
  doc.roundedRect(left, y, w, h, h / 2).fill(fondo);
  doc.fillColor(color).text(text, left + padX, y + (h - size) / 2 + 0.6, { characterSpacing: 0.3, lineBreak: false });
  return w;
}

/**
 * Franja de la primera hoja: la patente como placa, el vehículo, una línea
 * de contexto y, a la derecha, el resultado y un resumen.
 */
function drawHero(doc, y, { plate, vehicle, subtitle, status, summary }) {
  const h = 50;
  doc.roundedRect(MARGIN, y, CONTENT_W, h, 10).fill(C.brand);

  // Placa
  doc.font(FONT_BOLD).fontSize(14);
  const placa = String(plate || "—");
  const placaW = doc.widthOfString(placa, { characterSpacing: 1.4 }) + 22;
  const placaY = y + (h - 28) / 2;
  doc.roundedRect(MARGIN + 16, placaY, placaW, 28, 5).fill(C.white);
  doc.roundedRect(MARGIN + 18.5, placaY + 2.5, placaW - 5, 23, 3.5).lineWidth(0.8).strokeColor(C.brand).stroke();
  doc.fillColor(C.ink).text(placa, MARGIN + 16, placaY + 8, { width: placaW, align: "center", characterSpacing: 1.4, lineBreak: false });

  // Estado (se mide antes para no pisar el texto del vehículo)
  const right = PAGE_W - MARGIN - 16;
  doc.font(FONT_BOLD).fontSize(9);
  const estadoW = status ? doc.widthOfString(status.text, { characterSpacing: 0.3 }) + 22 : 0;
  doc.font(FONT).fontSize(7.5);
  const resumenW = summary ? doc.widthOfString(summary) : 0;
  const ladoW = Math.max(estadoW, resumenW);

  const textoX = MARGIN + 16 + placaW + 14;
  const textoW = right - ladoW - 16 - textoX;
  doc.font(FONT_BOLD).fontSize(12).fillColor(C.white)
    .text(vehicle || "—", textoX, y + 11, { width: textoW, lineBreak: false, ellipsis: true });
  if (subtitle) {
    doc.font(FONT).fontSize(8.5).fillColor("#c9d0ee")
      .text(subtitle, textoX, y + 28, { width: textoW, lineBreak: false, ellipsis: true });
  }

  if (status) {
    drawPill(doc, right, y + (summary ? 8 : (h - 20) / 2), status.text, status.tone, { size: 9, h: 20, padX: 11, align: "right" });
  }
  if (summary) {
    doc.font(FONT).fontSize(7.5).fillColor("#c9d0ee")
      .text(summary, right - 260, y + 32, { width: 260, align: "right", lineBreak: false });
  }
  return y + h;
}

/**
 * Datos en tarjetas, `cols` por fila. Cada uno: { label, value, alert }.
 * Un dato con `alert` va en rojo (un documento vencido, por ejemplo).
 */
function drawFacts(doc, y, facts, { cols = 4 } = {}) {
  const gap = 5;
  const cellW = (CONTENT_W - gap * (cols - 1)) / cols;
  const cellH = 27;
  facts.forEach((f, i) => {
    const x = MARGIN + (i % cols) * (cellW + gap);
    const top = y + Math.floor(i / cols) * (cellH + gap);
    doc.roundedRect(x, top, cellW, cellH, 6).fill(f.alert ? C.redSoft : C.soft);
    doc.font(FONT_BOLD).fontSize(6.3).fillColor(f.alert ? C.red : C.muted)
      .text(String(f.label).toUpperCase(), x + 9, top + 5, { width: cellW - 18, characterSpacing: 0.5, lineBreak: false, ellipsis: true });
    doc.font(FONT_BOLD).fontSize(9).fillColor(f.alert ? C.red : C.ink)
      .text(f.value || "—", x + 9, top + 14.5, { width: cellW - 18, height: 11, lineBreak: false, ellipsis: true });
  });
  const rows = Math.ceil(facts.length / cols);
  return y + rows * cellH + Math.max(rows - 1, 0) * gap;
}

/** Título de sección con su acento y, a la derecha, un dato opcional. */
function drawSection(doc, y, title, aside) {
  doc.roundedRect(MARGIN, y + 0.5, 3, 12, 1.5).fill(C.brand);
  doc.font(FONT_BOLD).fontSize(10.5).fillColor(C.ink).text(title, MARGIN + 10, y + 1, { lineBreak: false });
  if (aside) {
    doc.font(FONT).fontSize(8).fillColor(C.muted).text(aside, MARGIN, y + 3, { width: CONTENT_W, align: "right", lineBreak: false });
  }
  return y + 19;
}

/** Aviso de anulación al inicio del documento. */
function drawVoidNotice(doc, y, text) {
  doc.font(FONT_BOLD).fontSize(8.5);
  const h = doc.heightOfString(text, { width: CONTENT_W - 28 }) + 16;
  doc.roundedRect(MARGIN, y, CONTENT_W, h, 8).fill(C.redSoft);
  doc.roundedRect(MARGIN, y, 4, h, 2).fill(C.red);
  doc.fillColor(C.red).text(text, MARGIN + 16, y + 8, { width: CONTENT_W - 28 });
  return y + h + 12;
}

/** Imagen ajustada a la caja con esquinas redondeadas, o un aviso si no hay. */
function drawImage(doc, buffer, x, y, w, h, missing = "Imagen no disponible", { radius = 6, background = C.soft } = {}) {
  let ok = false;
  doc.save();
  doc.roundedRect(x, y, w, h, radius).clip();
  doc.rect(x, y, w, h).fill(buffer ? background : C.soft);
  if (buffer) {
    try {
      doc.image(buffer, x, y, { fit: [w, h], align: "center", valign: "center" });
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    doc.font(FONT).fontSize(7.5).fillColor(C.muted).text(missing, x + 6, y + h / 2 - 4, { width: w - 12, align: "center", lineBreak: false });
  }
  doc.restore();
  doc.roundedRect(x, y, w, h, radius).lineWidth(0.6).strokeColor(C.line).stroke();
}

/**
 * Observaciones, la línea de quién registró y las firmas.
 * `notes`: [{ title, text }]; `signers`: [[rol, nombre], …].
 */
function drawClosing(doc, ctx, y, { notes, registered, signers }) {
  const lineas = notes.length ? notes : [{ title: "", text: "Sin observaciones." }];
  const anchoTexto = CONTENT_W - 28;
  doc.font(FONT).fontSize(8.5);
  const altoNotas = lineas.reduce((s, l) => s + doc.heightOfString(`${l.title}${l.text}`, { width: anchoTexto }) + 4, 0);
  const cajaH = altoNotas + 12;
  doc.fontSize(7.5);
  const altoRegistro = doc.heightOfString(registered, { width: CONTENT_W });
  const SIGN_GAP = 26;
  const needed = 19 + cajaH + 8 + altoRegistro + SIGN_GAP + 26;
  y = ensure(doc, ctx, y + 4, needed);

  y = drawSection(doc, y, "Observaciones");
  doc.roundedRect(MARGIN, y, CONTENT_W, cajaH, 8).fill(C.soft);
  let ty = y + 7;
  for (const l of lineas) {
    if (l.title) {
      doc.font(FONT_BOLD).fontSize(8.5).fillColor(C.ink).text(l.title, MARGIN + 14, ty, { continued: true, width: anchoTexto });
      doc.font(FONT).fillColor(C.text).text(l.text, { width: anchoTexto });
    } else {
      doc.font(FONT).fontSize(8.5).fillColor(notes.length ? C.text : C.muted).text(l.text, MARGIN + 14, ty, { width: anchoTexto });
    }
    ty = doc.y + 4;
  }
  y += cajaH + 8;

  doc.font(FONT).fontSize(7.5).fillColor(C.muted).text(registered, MARGIN, y, { width: CONTENT_W });
  y += altoRegistro + SIGN_GAP;

  const sigGap = 36;
  const sigW = (CONTENT_W - sigGap * (signers.length - 1)) / signers.length;
  signers.forEach(([rol, nombre], i) => {
    const x = MARGIN + i * (sigW + sigGap);
    doc.moveTo(x, y).lineTo(x + sigW, y).lineWidth(0.8).strokeColor(C.ink).stroke();
    doc.font(FONT_BOLD).fontSize(8.5).fillColor(C.ink).text(nombre || " ", x, y + 6, { width: sigW, align: "center", lineBreak: false, ellipsis: true });
    doc.font(FONT).fontSize(7).fillColor(C.muted).text(rol, x, y + 17, { width: sigW, align: "center", lineBreak: false });
  });
  return y + 26;
}

function drawVoidStamp(doc, text) {
  doc.save();
  doc.rotate(-30, { origin: [PAGE_W / 2, PAGE_H / 2] });
  doc.font(FONT_BOLD).fontSize(90).fillColor(C.red).fillOpacity(0.1)
    .text(text, 0, PAGE_H / 2 - 50, { width: PAGE_W, align: "center", lineBreak: false });
  doc.restore();
  doc.fillOpacity(1);
}

/**
 * Pie en todas las hojas (número, fecha de generación y «Página n de N») y,
 * si el documento está anulado, el sello sobre cada una.
 */
function finishDoc(doc, ctx, { voidStamp = null } = {}) {
  const range = doc.bufferedPageRange();
  const total = range.count;
  const generado = `Generado desde la intranet el ${fmtDateTime(new Date())}`;
  for (let i = range.start; i < range.start + total; i += 1) {
    doc.switchToPage(i);
    if (voidStamp) drawVoidStamp(doc, voidStamp);
    const y = PAGE_H - MARGIN - 4;
    doc.moveTo(MARGIN, y - 8).lineTo(PAGE_W - MARGIN, y - 8).lineWidth(0.5).strokeColor(C.line).stroke();
    doc.font(FONT).fontSize(7).fillColor(C.faint)
      .text(`${ctx.number} · ${generado}`, MARGIN, y, { width: CONTENT_W, lineBreak: false });
    doc.font(FONT_BOLD).fontSize(7).fillColor(C.muted)
      .text(`Página ${i - range.start + 1} de ${total}`, MARGIN, y, { width: CONTENT_W, align: "right", lineBreak: false });
  }
}

module.exports = {
  C,
  TONES,
  FONT,
  FONT_BOLD,
  PAGE_W,
  PAGE_H,
  MARGIN,
  CONTENT_W,
  BOTTOM,
  fmtDate,
  fmtDateTime,
  renderPdf,
  startDoc,
  drawHeader,
  ensure,
  drawPill,
  drawHero,
  drawFacts,
  drawSection,
  drawVoidNotice,
  drawImage,
  drawClosing,
  finishDoc,
};
