const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { getCountryConfig } = require("../../config/country");
const {
  INSPECTION_KINDS,
  RESULTS,
  labelFrom,
  formatKm,
} = require("../../constants/vehicleChecklist");
const { formatDisplay } = require("../../utils/vacationDateUtils");

/**
 * PDF del checklist de vehículos: A4 vertical, en hoja blanca, para archivar
 * o firmar a mano. Encabezado con el número, datos del vehículo y del
 * conductor, resultado, la tabla de ítems por categoría (Bien / Falla / N/A
 * con su detalle), observaciones y líneas de firma.
 *
 * La tabla sigue en páginas nuevas si no cabe; el encabezado de columnas se
 * repite y cada página lleva el número del checklist al pie.
 */

const LOGO_PATH = path.join(__dirname, "..", "..", "public", "img", "logotw_blue.png");

const BLUE = "#26388f";
const INK = "#111111";
const MUTED = "#5b6270";
const LINE = "#c9ced8";
const SOFT = "#eef1f7";
const RED = "#c62828";
const RESULT_COLORS = { apto: "#1f7a3a", observado: "#a16207", no_apto: RED };

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

const MARGIN = 40;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const BOTTOM = PAGE_H - MARGIN - 24;

// Columnas de la tabla de ítems.
const COLS = (() => {
  const mark = 44;
  const item = 230;
  return {
    item: { x: MARGIN, w: item },
    ok: { x: MARGIN + item, w: mark },
    falla: { x: MARGIN + item + mark, w: mark },
    na: { x: MARGIN + item + 2 * mark, w: mark },
    detalle: { x: MARGIN + item + 3 * mark, w: CONTENT_W - item - 3 * mark },
  };
})();

function fmtDate(value) {
  return value ? formatDisplay(value).replace(/-/g, "/") : "—";
}

function fmtDateTime(value) {
  if (!value) return "—";
  const { locale, timezone } = getCountryConfig();
  return new Date(value).toLocaleString(locale, { dateStyle: "short", timeStyle: "short", timeZone: timezone });
}

function drawHeader(doc, registro) {
  if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, MARGIN, MARGIN, { height: 26 });
  doc.font(FONT_BOLD).fontSize(15).fillColor(BLUE)
    .text("CHECKLIST DE VEHÍCULO", MARGIN, MARGIN, { width: CONTENT_W, align: "right" });
  doc.font(FONT_BOLD).fontSize(11).fillColor(INK)
    .text(registro.number, MARGIN, MARGIN + 20, { width: CONTENT_W, align: "right" });
  doc.moveTo(MARGIN, MARGIN + 42).lineTo(PAGE_W - MARGIN, MARGIN + 42).lineWidth(1).strokeColor(BLUE).stroke();
  return MARGIN + 54;
}

function drawFooter(doc, registro, page) {
  doc.font(FONT).fontSize(7.5).fillColor(MUTED).text(
    `${registro.number} · Generado desde la intranet el ${fmtDateTime(new Date())} · Página ${page}`,
    MARGIN,
    PAGE_H - MARGIN - 10,
    { width: CONTENT_W, align: "center", lineBreak: false },
  );
}

/** Rejilla de datos: pares etiqueta / valor en 4 columnas. */
function drawFacts(doc, y, facts) {
  const colW = CONTENT_W / 4;
  const rowH = 34;
  facts.forEach((fact, i) => {
    const col = i % 4;
    const row = Math.floor(i / 4);
    const x = MARGIN + col * colW;
    const top = y + row * rowH;
    doc.font(FONT_BOLD).fontSize(7).fillColor(MUTED)
      .text(fact.label.toUpperCase(), x + 8, top + 6, { width: colW - 16, characterSpacing: 0.4 });
    doc.font(fact.bold ? FONT_BOLD : FONT).fontSize(9.5).fillColor(fact.color || INK)
      .text(fact.value || "—", x + 8, top + 16, { width: colW - 16, height: 14, ellipsis: true });
  });
  const rows = Math.ceil(facts.length / 4);
  doc.rect(MARGIN, y, CONTENT_W, rows * rowH).lineWidth(0.6).strokeColor(LINE).stroke();
  for (let r = 1; r < rows; r += 1) {
    doc.moveTo(MARGIN, y + r * rowH).lineTo(PAGE_W - MARGIN, y + r * rowH).strokeColor(LINE).stroke();
  }
  return y + rows * rowH;
}

function drawTableHead(doc, y) {
  doc.rect(MARGIN, y, CONTENT_W, 18).fill(BLUE);
  doc.font(FONT_BOLD).fontSize(7.5).fillColor("#ffffff");
  doc.text("ÍTEM", COLS.item.x + 6, y + 5, { width: COLS.item.w - 12 });
  doc.text("BIEN", COLS.ok.x, y + 5, { width: COLS.ok.w, align: "center" });
  doc.text("FALLA", COLS.falla.x, y + 5, { width: COLS.falla.w, align: "center" });
  doc.text("N/A", COLS.na.x, y + 5, { width: COLS.na.w, align: "center" });
  doc.text("DETALLE", COLS.detalle.x + 6, y + 5, { width: COLS.detalle.w - 12 });
  return y + 18;
}

function drawItems(doc, registro, startY, state) {
  let y = drawTableHead(doc, startY);
  let categoria = null;

  const newPage = () => {
    drawFooter(doc, registro, state.page);
    doc.addPage();
    state.page += 1;
    y = drawTableHead(doc, drawHeader(doc, registro));
  };

  for (const a of registro.answers || []) {
    const label = a.critical ? `${a.label}  (crítico)` : a.label;
    doc.font(FONT).fontSize(8.5);
    const hItem = doc.heightOfString(label, { width: COLS.item.w - 12 });
    const hDet = a.comment ? doc.heightOfString(a.comment, { width: COLS.detalle.w - 12 }) : 0;
    const rowH = Math.max(16, Math.max(hItem, hDet) + 8);
    const needsGroup = a.category !== categoria;
    const groupH = needsGroup ? 16 : 0;

    if (y + groupH + rowH > BOTTOM) newPage();

    if (needsGroup) {
      categoria = a.category;
      doc.rect(MARGIN, y, CONTENT_W, 16).fill(SOFT);
      doc.font(FONT_BOLD).fontSize(7.5).fillColor(BLUE)
        .text(String(categoria).toUpperCase(), MARGIN + 6, y + 4.5, { width: CONTENT_W - 12, characterSpacing: 0.4 });
      y += 16;
    }

    if (a.answer === "falla") doc.rect(MARGIN, y, CONTENT_W, rowH).fill("#fdf1f1");
    doc.font(a.critical ? FONT_BOLD : FONT).fontSize(8.5).fillColor(INK)
      .text(label, COLS.item.x + 6, y + 4, { width: COLS.item.w - 12 });
    const col = COLS[a.answer];
    if (col) {
      doc.font(FONT_BOLD).fontSize(10).fillColor(a.answer === "falla" ? RED : INK)
        .text("X", col.x, y + rowH / 2 - 5, { width: col.w, align: "center" });
    }
    if (a.comment) {
      doc.font(FONT).fontSize(8.5).fillColor(INK)
        .text(a.comment, COLS.detalle.x + 6, y + 4, { width: COLS.detalle.w - 12 });
    }
    doc.moveTo(MARGIN, y + rowH).lineTo(PAGE_W - MARGIN, y + rowH).lineWidth(0.4).strokeColor(LINE).stroke();
    for (const c of [COLS.ok, COLS.falla, COLS.na, COLS.detalle]) {
      doc.moveTo(c.x, y).lineTo(c.x, y + rowH).lineWidth(0.4).strokeColor(LINE).stroke();
    }
    y += rowH;
  }
  return y;
}

function drawClosing(doc, registro, startY, state) {
  let y = startY + 14;
  const obs = registro.observations || "Sin observaciones.";
  doc.font(FONT).fontSize(9);
  const obsH = doc.heightOfString(obs, { width: CONTENT_W - 16 });
  const needed = 14 + obsH + 16 + 110;
  if (y + needed > BOTTOM) {
    drawFooter(doc, registro, state.page);
    doc.addPage();
    state.page += 1;
    y = drawHeader(doc, registro);
  }

  doc.font(FONT_BOLD).fontSize(7.5).fillColor(MUTED).text("OBSERVACIONES", MARGIN, y, { characterSpacing: 0.4 });
  y += 12;
  doc.font(FONT).fontSize(9).fillColor(INK).text(obs, MARGIN + 8, y, { width: CONTENT_W - 16 });
  y += obsH + 14;

  doc.font(FONT).fontSize(8.5).fillColor(MUTED).text(
    `Registrado en la intranet por ${registro.created_by_name} el ${fmtDateTime(registro.created_at)}, quien declaró haber revisado el vehículo.`,
    MARGIN, y, { width: CONTENT_W },
  );
  y += 54;

  const sigW = (CONTENT_W - 40) / 2;
  [["Firma del conductor", registro.driver_name], ["Firma de quien revisó", registro.created_by_name]].forEach(([titulo, nombre], i) => {
    const x = MARGIN + i * (sigW + 40);
    doc.moveTo(x, y).lineTo(x + sigW, y).lineWidth(0.8).strokeColor(INK).stroke();
    doc.font(FONT_BOLD).fontSize(8.5).fillColor(INK).text(nombre || "", x, y + 5, { width: sigW, align: "center" });
    doc.font(FONT).fontSize(7.5).fillColor(MUTED).text(titulo, x, y + 17, { width: sigW, align: "center" });
  });
  return y + 30;
}

function drawVoidStamp(doc, registro) {
  doc.save();
  doc.rotate(-30, { origin: [PAGE_W / 2, PAGE_H / 2] });
  doc.font(FONT_BOLD).fontSize(90).fillColor(RED).fillOpacity(0.12)
    .text("ANULADO", 0, PAGE_H / 2 - 50, { width: PAGE_W, align: "center", lineBreak: false });
  doc.restore();
  doc.fillOpacity(1);
  return registro;
}

function drawChecklist(doc, registro) {
  const state = { page: 1 };
  doc.addPage();
  let y = drawHeader(doc, registro);
  const anulado = registro.status === "voided";
  const result = RESULTS[registro.result] || { label: registro.result };

  if (anulado) {
    const texto = `ANULADO el ${fmtDateTime(registro.voided_at)}${registro.voided_by_name ? ` por ${registro.voided_by_name}` : ""}. Motivo: ${registro.void_reason || "—"}`;
    doc.font(FONT_BOLD).fontSize(9);
    const h = doc.heightOfString(texto, { width: CONTENT_W - 16 });
    doc.rect(MARGIN, y, CONTENT_W, h + 12).lineWidth(1).strokeColor(RED).stroke();
    doc.fillColor(RED).text(texto, MARGIN + 8, y + 6, { width: CONTENT_W - 16 });
    y += h + 22;
  }

  y = drawFacts(doc, y, [
    { label: "Fecha de revisión", value: fmtDate(registro.inspection_date) },
    { label: "Momento", value: labelFrom(INSPECTION_KINDS, registro.inspection_kind) },
    { label: "Patente", value: registro.vehicle_plate, bold: true },
    { label: "Vehículo", value: registro.vehicle_label },
    { label: "Kilometraje", value: formatKm(registro.odometer_km) },
    { label: "Combustible", value: registro.fuel_level },
    { label: "Conductor", value: registro.driver_name },
    {
      label: "Resultado",
      value: anulado ? "Anulado" : result.label,
      bold: true,
      color: anulado ? MUTED : RESULT_COLORS[registro.result],
    },
  ]);

  y = drawItems(doc, registro, y + 16, state);
  drawClosing(doc, registro, y, state);
  drawFooter(doc, registro, state.page);

  if (anulado) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      drawVoidStamp(doc, registro);
    }
  }
}

/** Buffer del PDF de un checklist (fila de getChecklist, con `answers`). */
function renderChecklistPdf(registro) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      autoFirstPage: false,
      bufferPages: true,
      info: { Title: `Checklist ${registro.number}`, Creator: "Intranet Transworld" },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawChecklist(doc, registro);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderChecklistPdf };
