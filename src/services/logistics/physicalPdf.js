const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const { getCountryConfig } = require("../../config/country");
const { VEHICLE_KINDS, labelFrom, formatKm } = require("../../constants/vehicleChecklist");
const { CAPTURE_VIEWS, damageTypeLabel, reasonLabel } = require("../../constants/vehiclePhysical");
const { GROUPS } = require("../../constants/vehicleZones");
const { formatDisplay } = require("../../utils/vacationDateUtils");

/**
 * PDF de la revisión física (RF-00001-2026). A4 vertical:
 *
 *   encabezado y datos de la revisión
 *   el modelo 3D desde los cuatro lados, con las zonas dañadas en rojo
 *   los daños nuevos, cada uno con su zona, tipo, observación y fotos
 *   los daños que ya estaban abiertos ese día
 *   observaciones y firmas
 *
 * `images` trae el contenido de cada imagen: { captures: { vista: Buffer },
 * photos: Map(id de foto → Buffer) }. Lo que falte (Storage no respondió) se
 * deja como recuadro vacío con un aviso: el PDF sale igual.
 */

const LOGO_PATH = path.join(__dirname, "..", "..", "public", "img", "logotw_blue.png");

const BLUE = "#26388f";
const INK = "#111111";
const MUTED = "#5b6270";
const LINE = "#c9ced8";
const SOFT = "#eef1f7";
const RED = "#c62828";
const GREEN = "#1f7a3a";

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";

const MARGIN = 32;
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const BOTTOM = PAGE_H - MARGIN - 18;
const GUTTER = 10;
const SIGN_GAP = 30;

const CAPTURE_W = (CONTENT_W - GUTTER) / 2;
const CAPTURE_H = 142;
const PHOTO_GAP = 8;
const PHOTO_W = (CONTENT_W - 16 - 3 * PHOTO_GAP) / 4;
const PHOTO_H = PHOTO_W * 0.75;

const groupLabel = (value) => (GROUPS.find((g) => g.value === value) || { label: "" }).label;

function fmtDate(value) {
  return value ? formatDisplay(value).replace(/-/g, "/") : "—";
}

function fmtDateTime(value) {
  if (!value) return "—";
  const { locale, timezone } = getCountryConfig();
  return new Date(value).toLocaleString(locale, { dateStyle: "short", timeStyle: "short", timeZone: timezone });
}

function drawHeader(doc, review) {
  if (fs.existsSync(LOGO_PATH)) doc.image(LOGO_PATH, MARGIN, MARGIN + 2, { height: 24 });
  doc.font(FONT_BOLD).fontSize(14).fillColor(BLUE)
    .text("REVISIÓN FÍSICA", MARGIN, MARGIN, { width: CONTENT_W, align: "right" });
  doc.font(FONT_BOLD).fontSize(10).fillColor(INK)
    .text(review.number, MARGIN, MARGIN + 18, { width: CONTENT_W, align: "right" });
  doc.moveTo(MARGIN, MARGIN + 36).lineTo(PAGE_W - MARGIN, MARGIN + 36).lineWidth(1).strokeColor(BLUE).stroke();
  return MARGIN + 44;
}

function drawFooter(doc, review, page) {
  doc.font(FONT).fontSize(7).fillColor(MUTED).text(
    `${review.number} · Generado desde la intranet el ${fmtDateTime(new Date())} · Página ${page}`,
    MARGIN,
    PAGE_H - MARGIN - 8,
    { width: CONTENT_W, align: "center", lineBreak: false },
  );
}

/** Si no cabe `needed`, cierra la hoja y abre otra. Devuelve la y para seguir. */
function ensure(doc, review, state, y, needed) {
  if (y + needed <= BOTTOM) return y;
  drawFooter(doc, review, state.page);
  doc.addPage();
  state.page += 1;
  return drawHeader(doc, review);
}

function drawFacts(doc, y, facts) {
  const colW = CONTENT_W / 4;
  const rowH = 26;
  facts.forEach((fact, i) => {
    const x = MARGIN + (i % 4) * colW;
    const top = y + Math.floor(i / 4) * rowH;
    doc.font(FONT_BOLD).fontSize(6.5).fillColor(fact.alert ? RED : MUTED)
      .text(fact.label.toUpperCase(), x + 7, top + 5, { width: colW - 14, characterSpacing: 0.3, lineBreak: false });
    doc.font(fact.bold ? FONT_BOLD : FONT).fontSize(9).fillColor(fact.alert ? RED : INK)
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

function drawBand(doc, y, text) {
  doc.rect(MARGIN, y, CONTENT_W, 16).fill(BLUE);
  doc.font(FONT_BOLD).fontSize(8).fillColor("#ffffff")
    .text(text, MARGIN, y + 5, { width: CONTENT_W, align: "center", lineBreak: false });
  return y + 22;
}

/** Imagen ajustada a la caja, o un recuadro con el aviso si no hay. */
function drawImage(doc, buffer, x, y, w, h, missing = "Imagen no disponible") {
  let ok = false;
  if (buffer) {
    try {
      doc.image(buffer, x, y, { fit: [w, h], align: "center", valign: "center" });
      ok = true;
    } catch {
      ok = false;
    }
  }
  if (!ok) {
    doc.rect(x, y, w, h).fill(SOFT);
    doc.font(FONT).fontSize(7.5).fillColor(MUTED).text(missing, x + 6, y + h / 2 - 4, { width: w - 12, align: "center", lineBreak: false });
  }
  doc.rect(x, y, w, h).lineWidth(0.5).strokeColor(LINE).stroke();
}

function drawCaptures(doc, review, images, y, state) {
  const hayAlguna = CAPTURE_VIEWS.some((v) => images.captures && images.captures[v.value]);
  y = ensure(doc, review, state, y, 22 + (hayAlguna ? 2 * (CAPTURE_H + 16) + 12 : 30));
  y = drawBand(doc, y, "MODELO DEL VEHÍCULO");
  if (!hayAlguna) {
    doc.font(FONT).fontSize(8.5).fillColor(MUTED)
      .text("La revisión se registró sin capturas del modelo (el navegador no pudo mostrar el 3D).", MARGIN, y, { width: CONTENT_W });
    return y + 18;
  }
  CAPTURE_VIEWS.forEach((v, i) => {
    const x = MARGIN + (i % 2) * (CAPTURE_W + GUTTER);
    const top = y + Math.floor(i / 2) * (CAPTURE_H + 16);
    doc.font(FONT_BOLD).fontSize(7).fillColor(MUTED)
      .text(v.label.toUpperCase(), x, top, { width: CAPTURE_W, characterSpacing: 0.3, lineBreak: false });
    drawImage(doc, images.captures[v.value], x, top + 10, CAPTURE_W, CAPTURE_H - 6, "Sin captura de este lado");
  });
  y += 2 * (CAPTURE_H + 16);
  // Leyenda de colores del modelo.
  const items = [[RED, "Daño abierto"], [GREEN, "Reparado"]];
  let lx = MARGIN;
  items.forEach(([color, text]) => {
    doc.rect(lx, y + 1, 7, 7).fill(color);
    doc.font(FONT).fontSize(7.5).fillColor(MUTED).text(text, lx + 11, y, { lineBreak: false });
    lx += 11 + doc.widthOfString(text) + 16;
  });
  return y + 14;
}

function damageTitle(d) {
  const grupo = groupLabel(d.zone_group);
  return `${d.zone_label}${grupo ? ` · ${grupo}` : ""}`;
}

function drawDamage(doc, review, images, d, index, y, state) {
  const fotos = d.damage_photos || [];
  doc.font(FONT).fontSize(8.5);
  const descH = doc.heightOfString(d.description || "", { width: CONTENT_W - 16 });
  const repairText = d.status === "reparado"
    ? `Reparado el ${fmtDate(d.repaired_on)}${d.repaired_by_name ? ` (registró ${d.repaired_by_name})` : ""}: ${d.repair_note || ""}`
    : d.status === "anulado" ? "Anulado junto con la revisión." : "";
  const repairH = repairText ? doc.heightOfString(repairText, { width: CONTENT_W - 16 }) + 4 : 0;
  const blockH = 8 + 12 + 4 + descH + 6 + (fotos.length ? PHOTO_H + 8 : 0) + repairH + 6;
  y = ensure(doc, review, state, y, blockH);

  doc.rect(MARGIN, y, CONTENT_W, blockH).lineWidth(0.6).strokeColor(LINE).stroke();
  doc.rect(MARGIN, y, 3, blockH).fill(d.status === "reparado" ? GREEN : d.status === "anulado" ? MUTED : RED);
  let cy = y + 8;
  doc.font(FONT_BOLD).fontSize(9.5).fillColor(INK)
    .text(`${index}. ${damageTitle(d)}`, MARGIN + 8, cy, { width: CONTENT_W - 120, lineBreak: false, ellipsis: true });
  doc.font(FONT_BOLD).fontSize(8).fillColor(RED)
    .text(damageTypeLabel(d.damage_type).toUpperCase(), MARGIN + 8, cy + 1, { width: CONTENT_W - 16, align: "right", lineBreak: false });
  cy += 16;
  doc.font(FONT).fontSize(8.5).fillColor(INK).text(d.description || "", MARGIN + 8, cy, { width: CONTENT_W - 16 });
  cy += descH + 6;
  fotos.slice(0, 4).forEach((p, j) => {
    const x = MARGIN + 8 + j * (PHOTO_W + PHOTO_GAP);
    drawImage(doc, images.photos.get(String(p.id)), x, cy, PHOTO_W, PHOTO_H, "Foto no disponible");
  });
  if (fotos.length) cy += PHOTO_H + 8;
  if (repairText) {
    doc.font(FONT_BOLD).fontSize(8).fillColor(d.status === "reparado" ? GREEN : MUTED)
      .text(repairText, MARGIN + 8, cy, { width: CONTENT_W - 16 });
  }
  return y + blockH + 6;
}

function drawNewDamages(doc, review, images, y, state) {
  y = ensure(doc, review, state, y, 22 + 40);
  y = drawBand(doc, y, "DAÑOS ENCONTRADOS EN ESTA REVISIÓN");
  const list = review.damages || [];
  if (!list.length) {
    doc.font(FONT).fontSize(8.5).fillColor(INK).text("Sin daños nuevos.", MARGIN + 6, y, { width: CONTENT_W - 12 });
    return y + 18;
  }
  list.forEach((d, i) => { y = drawDamage(doc, review, images, d, i + 1, y, state); });
  return y;
}

function drawPrevious(doc, review, y, state) {
  const list = review.previous || [];
  y = ensure(doc, review, state, y, 22 + 30);
  y = drawBand(doc, y, "DAÑOS QUE YA ESTABAN ABIERTOS");
  if (!list.length) {
    doc.font(FONT).fontSize(8.5).fillColor(INK).text("Ninguno: el vehículo no tenía daños abiertos.", MARGIN + 6, y, { width: CONTENT_W - 12 });
    return y + 18;
  }
  const cols = [
    { title: "ZONA", w: 150 },
    { title: "TIPO", w: 70 },
    { title: "DESDE", w: 100 },
    { title: "OBSERVACIÓN", w: CONTENT_W - 320 },
  ];
  const headerH = 15;
  const drawHead = (top) => {
    doc.rect(MARGIN, top, CONTENT_W, headerH).fill(SOFT);
    let x = MARGIN;
    cols.forEach((c) => {
      doc.font(FONT_BOLD).fontSize(7).fillColor(BLUE).text(c.title, x + 5, top + 4.5, { width: c.w - 10, lineBreak: false });
      x += c.w;
    });
    return top + headerH;
  };
  y = drawHead(y);
  list.forEach((d) => {
    const cells = [damageTitle(d), damageTypeLabel(d.damage_type), `${d.review_number} · ${fmtDate(d.review_date)}`, d.description || ""];
    doc.font(FONT).fontSize(8);
    const h = Math.max(15, ...cells.map((t, i) => doc.heightOfString(t, { width: cols[i].w - 10 }) + 6));
    if (y + h > BOTTOM) {
      y = ensure(doc, review, state, y, BOTTOM);
      y = drawHead(y);
    }
    let x = MARGIN;
    cells.forEach((t, i) => {
      doc.font(i === 0 ? FONT_BOLD : FONT).fontSize(8).fillColor(INK).text(t, x + 5, y + 3, { width: cols[i].w - 10 });
      x += cols[i].w;
    });
    doc.moveTo(MARGIN, y + h).lineTo(PAGE_W - MARGIN, y + h).lineWidth(0.4).strokeColor(LINE).stroke();
    y += h;
  });
  return y + 8;
}

function drawClosing(doc, review, y, state) {
  const texto = review.observations || "Sin observaciones.";
  doc.font(FONT).fontSize(8.5);
  const needed = 14 + doc.heightOfString(texto, { width: CONTENT_W - 12 }) + 8 + 12 + SIGN_GAP + 26;
  y = ensure(doc, review, state, y + 4, needed);
  doc.font(FONT_BOLD).fontSize(7.5).fillColor(BLUE).text("OBSERVACIONES", MARGIN, y, { characterSpacing: 0.4 });
  y += 12;
  doc.font(FONT).fontSize(8.5).fillColor(INK).text(texto, MARGIN + 6, y, { width: CONTENT_W - 12 });
  y = doc.y + 8;
  doc.font(FONT).fontSize(7.5).fillColor(MUTED).text(
    `Registrado en la intranet por ${review.created_by_name} el ${fmtDateTime(review.created_at)}, quien declaró haber revisado el vehículo por fuera.`,
    MARGIN, y, { width: CONTENT_W },
  );
  y += 12 + SIGN_GAP;
  const sigW = (CONTENT_W - 40) / 2;
  [["Firma del conductor", review.driver_name], ["Firma de quien revisó", review.created_by_name]].forEach(([titulo, nombre], i) => {
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
    .text("ANULADA", 0, PAGE_H / 2 - 50, { width: PAGE_W, align: "center", lineBreak: false });
  doc.restore();
  doc.fillOpacity(1);
}

function drawReview(doc, review, images) {
  const state = { page: 1 };
  doc.addPage();
  let y = drawHeader(doc, review);
  const anulada = review.status === "voided";
  if (anulada) {
    const texto = `ANULADA el ${fmtDateTime(review.voided_at)}${review.voided_by_name ? ` por ${review.voided_by_name}` : ""}. Motivo: ${review.void_reason || "—"}`;
    doc.font(FONT_BOLD).fontSize(8.5);
    const h = doc.heightOfString(texto, { width: CONTENT_W - 16 });
    doc.rect(MARGIN, y, CONTENT_W, h + 10).lineWidth(1).strokeColor(RED).stroke();
    doc.fillColor(RED).text(texto, MARGIN + 8, y + 5, { width: CONTENT_W - 16 });
    y += h + 16;
  }
  const nuevos = (review.damages || []).length;
  const abiertos = (review.previous || []).length;
  y = drawFacts(doc, y, [
    { label: "Fecha", value: fmtDate(review.review_date) },
    { label: "Patente", value: review.vehicle_plate, bold: true },
    { label: "Conductor", value: review.driver_name },
    { label: "Motivo", value: reasonLabel(review.reason) },
    { label: "Modelo", value: review.vehicle_label },
    { label: "Tipo", value: labelFrom(VEHICLE_KINDS, review.vehicle_kind) },
    { label: "Kilometraje", value: formatKm(review.odometer_km) },
    { label: "Daños", value: `${nuevos} ${nuevos === 1 ? "nuevo" : "nuevos"} · ${abiertos} de antes`, alert: nuevos > 0 },
  ]);
  y = drawCaptures(doc, review, images, y + 10, state);
  y = drawNewDamages(doc, review, images, y + 4, state);
  y = drawPrevious(doc, review, y + 4, state);
  drawClosing(doc, review, y, state);
  drawFooter(doc, review, state.page);
  if (anulada) {
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      drawVoidStamp(doc);
    }
  }
}

/** Buffer del PDF de una revisión física (fila de getPhysicalReview). */
function renderPhysicalPdf(review, images = {}) {
  const imgs = { captures: images.captures || {}, photos: images.photos || new Map() };
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: "A4",
      margin: 0,
      autoFirstPage: false,
      bufferPages: true,
      info: { Title: `Revisión física ${review.number}`, Creator: "Intranet Transworld" },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      drawReview(doc, review, imgs);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderPhysicalPdf };
