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
const { documentsFor } = require("./vehicleService");
const { formatDisplay } = require("../../utils/vacationDateUtils");

/**
 * PDF del checklist de vehículos, con la diagramación del «Check list diario»
 * en papel: encabezado con los datos del vehículo, "Estado mecánico del
 * vehículo" en dos columnas por categoría (Descripción · Sí · No · N/A) y al
 * pie las observaciones y las firmas. A4 vertical, en hoja blanca.
 *
 * Las marcas se dibujan (✓, ✗, –): Helvetica no trae esos glifos. Si los
 * ítems no caben en una hoja, las columnas siguen en la próxima con el
 * encabezado de la categoría repetido.
 */

const LOGO_PATH = path.join(__dirname, "..", "..", "public", "img", "logotw_blue.png");

const BLUE = "#26388f";
const INK = "#111111";
const MUTED = "#5b6270";
const LINE = "#c9ced8";
const SOFT = "#eef1f7";
const RED = "#c62828";
const GREEN = "#1f7a3a";
const RESULT_COLORS = { apto: GREEN, observado: "#a16207", no_apto: RED };

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

const MARGIN = 32;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const BOTTOM = PAGE_H - MARGIN - 18;

// Dos columnas de ítems, cada una con Descripción y tres marcas.
const GUTTER = 12;
const COL_W = (CONTENT_W - GUTTER) / 2;
const MARK_W = 26;
const LABEL_W = COL_W - 3 * MARK_W;
const GROUP_H = 15;
const ITEM_FONT = 8;
const MIN_ITEM_H = 13;
/** Espacio para firmar a mano sobre la línea. */
const SIGN_GAP = 30;

function fmtDate(value) {
  return value ? formatDisplay(value).replace(/-/g, "/") : "—";
}

function fmtDateTime(value) {
  if (!value) return "—";
  const { locale, timezone } = getCountryConfig();
  return new Date(value).toLocaleString(locale, { dateStyle: "short", timeStyle: "short", timeZone: timezone });
}

function drawHeader(doc, registro) {
  if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, MARGIN, MARGIN + 2, { height: 24 });
  doc.font(FONT_BOLD).fontSize(14).fillColor(BLUE)
    .text("CHECK LIST DIARIO", MARGIN, MARGIN, { width: CONTENT_W, align: "right" });
  doc.font(FONT_BOLD).fontSize(10).fillColor(INK)
    .text(registro.number, MARGIN, MARGIN + 18, { width: CONTENT_W, align: "right" });
  doc.moveTo(MARGIN, MARGIN + 36).lineTo(PAGE_W - MARGIN, MARGIN + 36).lineWidth(1).strokeColor(BLUE).stroke();
  return MARGIN + 44;
}

function drawFooter(doc, registro, page) {
  doc.font(FONT).fontSize(7).fillColor(MUTED).text(
    `${registro.number} · Generado desde la intranet el ${fmtDateTime(new Date())} · Página ${page}`,
    MARGIN,
    PAGE_H - MARGIN - 8,
    { width: CONTENT_W, align: "center", lineBreak: false },
  );
}

/** Rejilla del encabezado: pares etiqueta / valor en 4 columnas. */
function drawFacts(doc, y, facts) {
  const colW = CONTENT_W / 4;
  const rowH = 26;
  facts.forEach((fact, i) => {
    const x = MARGIN + (i % 4) * colW;
    const top = y + Math.floor(i / 4) * rowH;
    doc.font(FONT_BOLD).fontSize(6.5).fillColor(fact.alert ? RED : MUTED)
      .text(fact.label.toUpperCase(), x + 7, top + 5, { width: colW - 14, characterSpacing: 0.3, lineBreak: false });
    doc.font(fact.bold ? FONT_BOLD : FONT).fontSize(9).fillColor(fact.color || (fact.alert ? RED : INK))
      .text(fact.value || "—", x + 7, top + 14, { width: colW - 14, height: 11, ellipsis: true, lineBreak: false });
  });
  const rows = Math.ceil(facts.length / 4);
  doc.rect(MARGIN, y, CONTENT_W, rows * rowH).lineWidth(0.6).strokeColor(LINE).stroke();
  for (let r = 1; r < rows; r += 1) {
    doc.moveTo(MARGIN, y + r * rowH).lineTo(PAGE_W - MARGIN, y + r * rowH).strokeColor(LINE).stroke();
  }
  for (let c = 1; c < 4; c += 1) {
    doc.moveTo(MARGIN + c * colW, y).lineTo(MARGIN + c * colW, y + rows * rowH).strokeColor(LINE).stroke();
  }
  return y + rows * rowH;
}

function drawResult(doc, y, registro) {
  const anulado = registro.status === "voided";
  const result = RESULTS[registro.result] || { label: registro.result };
  const color = anulado ? MUTED : RESULT_COLORS[registro.result] || INK;
  const texto = anulado ? "ANULADO" : result.label.toUpperCase();
  doc.rect(MARGIN, y, CONTENT_W, 20).fill(color);
  doc.font(FONT_BOLD).fontSize(9.5).fillColor("#ffffff")
    .text(`RESULTADO: ${texto}`, MARGIN + 8, y + 6, { width: CONTENT_W - 16, lineBreak: false });
  const noes = (registro.answers || []).filter((a) => a.answer === "falla").length;
  doc.font(FONT).fontSize(8).fillColor("#ffffff").text(
    `${(registro.answers || []).length} ítems · ${noes} no ${noes === 1 ? "operativo" : "operativos"}`,
    MARGIN + 8, y + 6.5, { width: CONTENT_W - 16, align: "right", lineBreak: false },
  );
  return y + 20;
}

// --- Marcas -------------------------------------------------------------------

function drawCheck(doc, cx, cy) {
  doc.save().lineWidth(1.4).strokeColor(GREEN).lineCap("round").lineJoin("round")
    .moveTo(cx - 3.5, cy).lineTo(cx - 1, cy + 2.8).lineTo(cx + 4, cy - 3).stroke().restore();
}

function drawCross(doc, cx, cy) {
  doc.save().lineWidth(1.4).strokeColor(RED).lineCap("round")
    .moveTo(cx - 3, cy - 3).lineTo(cx + 3, cy + 3).moveTo(cx + 3, cy - 3).lineTo(cx - 3, cy + 3).stroke().restore();
}

function drawDash(doc, cx, cy) {
  doc.save().lineWidth(1.2).strokeColor(MUTED).moveTo(cx - 3, cy).lineTo(cx + 3, cy).stroke().restore();
}

// --- Ítems en dos columnas ----------------------------------------------------

/** Filas a dibujar: encabezado de cada categoría y sus ítems, con su alto. */
function buildRows(doc, answers) {
  const rows = [];
  let categoria = null;
  doc.font(FONT).fontSize(ITEM_FONT);
  for (const a of answers || []) {
    if (a.category !== categoria) {
      categoria = a.category;
      rows.push({ type: "group", category: categoria, h: GROUP_H });
    }
    const label = a.critical ? `${a.label} *` : a.label;
    const h = Math.max(MIN_ITEM_H, doc.heightOfString(label, { width: LABEL_W - 8 }) + 4);
    rows.push({ type: "item", answer: a, label, category: categoria, h });
  }
  return rows;
}

function drawGroupRow(doc, x, y, category, cont) {
  doc.rect(x, y, COL_W, GROUP_H).fill(SOFT);
  doc.font(FONT_BOLD).fontSize(7).fillColor(BLUE)
    .text(`${String(category).toUpperCase()}${cont ? " (CONT.)" : ""}`, x + 5, y + 4.5, { width: LABEL_W - 8, lineBreak: false, ellipsis: true });
  ["SÍ", "NO", "N/A"].forEach((t, i) => {
    doc.text(t, x + LABEL_W + i * MARK_W, y + 4.5, { width: MARK_W, align: "center", lineBreak: false });
  });
}

function drawItemRow(doc, x, y, row) {
  const a = row.answer;
  if (a.answer === "falla") doc.rect(x, y, COL_W, row.h).fill("#fdf1f1");
  doc.font(a.critical ? FONT_BOLD : FONT).fontSize(ITEM_FONT).fillColor(INK)
    .text(row.label, x + 5, y + 3, { width: LABEL_W - 8 });
  const cy = y + row.h / 2;
  const col = { ok: 0, falla: 1, na: 2 }[a.answer];
  if (col != null) {
    const cx = x + LABEL_W + col * MARK_W + MARK_W / 2;
    if (a.answer === "ok") drawCheck(doc, cx, cy);
    else if (a.answer === "falla") drawCross(doc, cx, cy);
    else drawDash(doc, cx, cy);
  }
  doc.lineWidth(0.4).strokeColor(LINE);
  doc.moveTo(x, y + row.h).lineTo(x + COL_W, y + row.h).stroke();
  for (let i = 0; i < 3; i += 1) {
    const lx = x + LABEL_W + i * MARK_W;
    doc.moveTo(lx, y).lineTo(lx, y + row.h).stroke();
  }
}

/**
 * Reparte las filas en dos columnas. Si todo lo que queda cabe en esta hoja,
 * corta en la categoría más cercana a la mitad para que las columnas queden
 * parejas; si no, llena la izquierda, luego la derecha, y sigue en otra hoja.
 */
function splitIndex(rows, available, { balance = true } = {}) {
  const total = rows.reduce((s, r) => s + r.h, 0);
  if (balance && total <= 2 * available) {
    let best = null;
    let acc = 0;
    rows.forEach((r, i) => {
      if (i > 0 && r.type === "group") {
        const left = acc;
        const right = total - acc;
        if (left <= available && right <= available) {
          const diff = Math.abs(left - right);
          if (!best || diff < best.diff) best = { i, diff };
        }
      }
      acc += r.h;
    });
    if (best) return best.i;
  }
  let acc = 0;
  for (let i = 0; i < rows.length; i += 1) {
    if (acc + rows[i].h > available) return i;
    acc += rows[i].h;
  }
  return rows.length;
}

function drawColumn(doc, x, y, rows) {
  let cy = y;
  rows.forEach((r, i) => {
    if (r.type === "group") drawGroupRow(doc, x, cy, r.category, false);
    else {
      // La columna empieza a mitad de una categoría: se repite su encabezado.
      if (i === 0) {
        drawGroupRow(doc, x, cy, r.category, true);
        cy += GROUP_H;
      }
      drawItemRow(doc, x, cy, r);
    }
    cy += r.h;
  });
  doc.rect(x, y, COL_W, cy - y).lineWidth(0.6).strokeColor(LINE).stroke();
  return cy;
}

function drawItems(doc, registro, startY, state) {
  let rows = buildRows(doc, registro.answers);
  let y = startY;
  doc.rect(MARGIN, y, CONTENT_W, 16).fill(BLUE);
  doc.font(FONT_BOLD).fontSize(8).fillColor("#ffffff")
    .text("ESTADO MECÁNICO DEL VEHÍCULO", MARGIN, y + 5, { width: CONTENT_W, align: "center", lineBreak: false });
  y += 22;

  let bottom = y;
  while (rows.length) {
    const available = BOTTOM - y - GROUP_H;
    const cut = Math.max(1, splitIndex(rows, available));
    const left = rows.slice(0, cut);
    const rest = rows.slice(cut);
    const cut2 = rest.length ? Math.max(1, splitIndex(rest, available, { balance: false })) : 0;
    const right = rest.slice(0, cut2);
    const endL = drawColumn(doc, MARGIN, y, left);
    const endR = right.length ? drawColumn(doc, MARGIN + COL_W + GUTTER, y, right) : y;
    bottom = Math.max(endL, endR);
    rows = rest.slice(cut2);
    if (rows.length) {
      drawFooter(doc, registro, state.page);
      doc.addPage();
      state.page += 1;
      y = drawHeader(doc, registro);
    }
  }

  doc.font(FONT).fontSize(6.5).fillColor(MUTED)
    .text("* Ítem crítico: si no está operativo, el vehículo no debe salir.", MARGIN, bottom + 4, { width: CONTENT_W, lineBreak: false });
  return bottom + 14;
}

// --- Cierre -------------------------------------------------------------------

function drawClosing(doc, registro, startY, state) {
  let y = startY + 6;
  const notas = (registro.answers || []).filter((a) => a.comment);
  const general = registro.observations || "";
  const lineas = [
    ...notas.map((a) => ({ titulo: `${a.label}${a.answer === "falla" ? " (no operativo)" : ""}: `, texto: a.comment })),
    ...(general ? [{ titulo: "Generales: ", texto: general }] : []),
  ];
  if (!lineas.length) lineas.push({ titulo: "", texto: "Sin observaciones." });

  doc.font(FONT).fontSize(8.5);
  const altoNotas = lineas.reduce((s, l) => s + doc.heightOfString(`${l.titulo}${l.texto}`, { width: CONTENT_W - 12 }) + 2, 0);
  // Título, notas, la línea de registro y las firmas.
  const needed = 12 + altoNotas + 8 + 12 + SIGN_GAP + 26;
  if (y + needed > BOTTOM) {
    drawFooter(doc, registro, state.page);
    doc.addPage();
    state.page += 1;
    y = drawHeader(doc, registro);
  }

  doc.font(FONT_BOLD).fontSize(7.5).fillColor(BLUE).text("OBSERVACIONES", MARGIN, y, { characterSpacing: 0.4 });
  y += 12;
  for (const l of lineas) {
    doc.font(FONT_BOLD).fontSize(8.5).fillColor(INK).text(l.titulo, MARGIN + 6, y, { continued: Boolean(l.titulo), width: CONTENT_W - 12 });
    doc.font(FONT).text(l.texto, { width: CONTENT_W - 12 });
    y = doc.y + 2;
  }
  y += 8;

  doc.font(FONT).fontSize(7.5).fillColor(MUTED).text(
    `Registrado en la intranet por ${registro.created_by_name} el ${fmtDateTime(registro.created_at)}, quien declaró haber revisado el vehículo.`,
    MARGIN, y, { width: CONTENT_W },
  );
  y += 12 + SIGN_GAP;

  const sigW = (CONTENT_W - 40) / 2;
  [["Firma del conductor", registro.driver_name], ["Firma de quien revisó", registro.created_by_name]].forEach(([titulo, nombre], i) => {
    const x = MARGIN + i * (sigW + 40);
    doc.moveTo(x, y).lineTo(x + sigW, y).lineWidth(0.8).strokeColor(INK).stroke();
    doc.font(FONT_BOLD).fontSize(8.5).fillColor(INK).text(nombre || "", x, y + 4, { width: sigW, align: "center" });
    doc.font(FONT).fontSize(7).fillColor(MUTED).text(titulo, x, y + 15, { width: sigW, align: "center" });
  });
  return y + 26;
}

function drawVoidStamp(doc) {
  doc.save();
  doc.rotate(-30, { origin: [PAGE_W / 2, PAGE_H / 2] });
  doc.font(FONT_BOLD).fontSize(90).fillColor(RED).fillOpacity(0.12)
    .text("ANULADO", 0, PAGE_H / 2 - 50, { width: PAGE_W, align: "center", lineBreak: false });
  doc.restore();
  doc.fillOpacity(1);
}

function drawChecklist(doc, registro) {
  const state = { page: 1 };
  const { code } = getCountryConfig();
  doc.addPage();
  let y = drawHeader(doc, registro);
  const anulado = registro.status === "voided";

  if (anulado) {
    const texto = `ANULADO el ${fmtDateTime(registro.voided_at)}${registro.voided_by_name ? ` por ${registro.voided_by_name}` : ""}. Motivo: ${registro.void_reason || "—"}`;
    doc.font(FONT_BOLD).fontSize(8.5);
    const h = doc.heightOfString(texto, { width: CONTENT_W - 16 });
    doc.rect(MARGIN, y, CONTENT_W, h + 10).lineWidth(1).strokeColor(RED).stroke();
    doc.fillColor(RED).text(texto, MARGIN + 8, y + 5, { width: CONTENT_W - 16 });
    y += h + 16;
  }

  // Un documento vencido el día de la revisión se marca en rojo.
  const vencido = (iso) => Boolean(iso) && iso < registro.inspection_date;
  const documentos = documentsFor(code).map((d) => ({
    label: d.label,
    value: fmtDate(registro[d.field]),
    alert: vencido(registro[d.field]),
  }));
  const mantencion = registro.next_maintenance_km;
  y = drawFacts(doc, y, [
    { label: "Fecha", value: fmtDate(registro.inspection_date) },
    { label: "Patente", value: registro.vehicle_plate, bold: true },
    { label: "Conductor", value: registro.driver_name },
    { label: "Momento", value: labelFrom(INSPECTION_KINDS, registro.inspection_kind) },
    { label: "Modelo", value: registro.vehicle_label },
    { label: "Kilometraje", value: formatKm(registro.odometer_km) },
    {
      label: "Próx. mantención",
      value: mantencion == null ? "—" : formatKm(mantencion),
      alert: mantencion != null && Number(registro.odometer_km) >= Number(mantencion),
    },
    { label: "Combustible", value: registro.fuel_level },
    ...documentos,
  ]);
  y = drawResult(doc, y + 8, registro);

  y = drawItems(doc, registro, y + 8, state);
  drawClosing(doc, registro, y, state);
  drawFooter(doc, registro, state.page);

  if (anulado) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      drawVoidStamp(doc);
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
      info: { Title: `Revisión mecánica ${registro.number}`, Creator: "Intranet Transworld" },
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
