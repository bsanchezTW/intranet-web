const { VEHICLE_KINDS, labelFrom, formatKm } = require("../../constants/vehicleChecklist");
const { CAPTURE_VIEWS, damageTypeLabel, reasonLabel } = require("../../constants/vehiclePhysical");
const { GROUPS } = require("../../constants/vehicleZones");
const K = require("./reviewPdfKit");

const { C, FONT, FONT_BOLD, MARGIN, CONTENT_W, PAGE_W, BOTTOM } = K;

/**
 * PDF de la revisión física (RF-00001-2026), con el lenguaje de los PDF de
 * Gestión de flota (reviewPdfKit). A4 vertical:
 *
 *   la franja con la patente y los daños nuevos, y los datos de la revisión
 *   el modelo 3D desde los cuatro lados, con las zonas dañadas en rojo
 *   los daños nuevos, cada uno con su zona, tipo, observación y fotos
 *   los daños que ya estaban abiertos ese día
 *   observaciones y firmas
 *
 * `images` trae el contenido de cada imagen: { captures: { vista: Buffer },
 * photos: Map(id de foto → Buffer) }. Lo que falte (Storage no respondió) se
 * deja como recuadro vacío con un aviso: el PDF sale igual.
 */

const TITLE = "Revisión física";
const GUTTER = 10;

const CAPTURE_W = (CONTENT_W - GUTTER) / 2;
// Las capturas miden 1200 × 720: el recuadro guarda esa proporción.
const CAPTURE_H = Math.round(CAPTURE_W * 0.6);
const PHOTO_GAP = 8;
const PHOTO_W = (CONTENT_W - 28 - 3 * PHOTO_GAP) / 4;
const PHOTO_H = PHOTO_W * 0.75;

const STATUS_COLORS = { abierto: C.red, reparado: C.green, anulado: C.faint };

const groupLabel = (value) => (GROUPS.find((g) => g.value === value) || { label: "" }).label;

function drawCaptures(doc, ctx, review, images, y) {
  const hayAlguna = CAPTURE_VIEWS.some((v) => images.captures && images.captures[v.value]);
  y = K.ensure(doc, ctx, y, 22 + (hayAlguna ? 2 * (CAPTURE_H + GUTTER) + 16 : 30));
  y = K.drawSection(doc, y, "Modelo del vehículo", hayAlguna ? "Vista desde los cuatro lados" : null);
  if (!hayAlguna) {
    doc.font(FONT).fontSize(8.5).fillColor(C.muted)
      .text("La revisión se registró sin capturas del modelo (el navegador no pudo mostrar el 3D).", MARGIN, y, { width: CONTENT_W });
    return y + 20;
  }
  CAPTURE_VIEWS.forEach((v, i) => {
    const x = MARGIN + (i % 2) * (CAPTURE_W + GUTTER);
    const top = y + Math.floor(i / 2) * (CAPTURE_H + GUTTER);
    K.drawImage(doc, images.captures[v.value], x, top, CAPTURE_W, CAPTURE_H, "Sin captura de este lado", { radius: 8, background: C.white });
    K.drawPill(doc, x + 8, top + 8, v.label.toUpperCase(), "brand", { size: 6.5, h: 14, padX: 6 });
  });
  y += 2 * CAPTURE_H + GUTTER + 8;
  // Leyenda de colores del modelo.
  let lx = MARGIN;
  [[C.red, "Daño abierto"], [C.green, "Reparado"]].forEach(([color, text]) => {
    doc.circle(lx + 3.5, y + 4, 3.5).fill(color);
    doc.font(FONT).fontSize(7.5).fillColor(C.muted).text(text, lx + 11, y + 0.5, { lineBreak: false });
    lx += 11 + doc.widthOfString(text) + 16;
  });
  return y + 16;
}

function damageTitle(d) {
  return d.zone_label || "Zona";
}

function drawDamage(doc, ctx, images, d, index, y) {
  const fotos = (d.damage_photos || []).slice(0, 4);
  const anchoTexto = CONTENT_W - 28;
  doc.font(FONT).fontSize(8.5);
  const descH = d.description ? doc.heightOfString(d.description, { width: anchoTexto }) : 0;
  const repairText = d.status === "reparado"
    ? `Reparado el ${K.fmtDate(d.repaired_on)}${d.repaired_by_name ? ` (registró ${d.repaired_by_name})` : ""}: ${d.repair_note || ""}`
    : d.status === "anulado" ? "Anulado junto con la revisión." : "";
  doc.font(FONT_BOLD).fontSize(8);
  const repairH = repairText ? doc.heightOfString(repairText, { width: anchoTexto }) + 6 : 0;
  const blockH = 12 + 16 + (descH ? descH + 6 : 0) + (fotos.length ? PHOTO_H + 8 : 0) + repairH + 6;
  y = K.ensure(doc, ctx, y, blockH);

  const color = STATUS_COLORS[d.status] || C.red;
  doc.save();
  doc.roundedRect(MARGIN, y, CONTENT_W, blockH, 8).clip();
  doc.rect(MARGIN, y, CONTENT_W, blockH).fill(C.white);
  doc.rect(MARGIN, y, 4, blockH).fill(color);
  doc.restore();
  doc.roundedRect(MARGIN, y, CONTENT_W, blockH, 8).lineWidth(0.7).strokeColor(C.line).stroke();

  let cy = y + 12;
  // Número en círculo, zona y grupo; el tipo como etiqueta a la derecha.
  doc.circle(MARGIN + 21, cy + 5, 7).fill(color);
  doc.font(FONT_BOLD).fontSize(7.5).fillColor(C.white).text(String(index), MARGIN + 14, cy + 2, { width: 14, align: "center", lineBreak: false });
  const tipoW = K.drawPill(doc, PAGE_W - MARGIN - 12, cy - 2, damageTypeLabel(d.damage_type).toUpperCase(), d.status === "reparado" ? "ok" : d.status === "anulado" ? "neutral" : "bad", { size: 6.8, h: 14, align: "right" });
  const grupo = groupLabel(d.zone_group);
  const tituloMax = CONTENT_W - 60 - tipoW;
  doc.font(FONT_BOLD).fontSize(9.5);
  const tituloW = Math.min(doc.widthOfString(damageTitle(d)), tituloMax);
  doc.fillColor(C.ink).text(damageTitle(d), MARGIN + 34, cy + 0.5, { width: tituloMax, lineBreak: false, ellipsis: true });
  if (grupo && tituloW + 60 < tituloMax) {
    doc.font(FONT).fontSize(8).fillColor(C.muted)
      .text(grupo, MARGIN + 34 + tituloW + 8, cy + 1.5, { width: tituloMax - tituloW - 8, lineBreak: false, ellipsis: true });
  }
  cy += 16;
  if (d.description) {
    doc.font(FONT).fontSize(8.5).fillColor(C.text).text(d.description, MARGIN + 14, cy, { width: anchoTexto });
    cy += descH + 6;
  }
  fotos.forEach((p, j) => {
    const x = MARGIN + 14 + j * (PHOTO_W + PHOTO_GAP);
    K.drawImage(doc, images.photos.get(String(p.id)), x, cy, PHOTO_W, PHOTO_H, "Foto no disponible");
  });
  if (fotos.length) cy += PHOTO_H + 8;
  if (repairText) {
    doc.font(FONT_BOLD).fontSize(8).fillColor(d.status === "reparado" ? C.green : C.muted)
      .text(repairText, MARGIN + 14, cy, { width: anchoTexto });
  }
  return y + blockH + 8;
}

function drawNewDamages(doc, ctx, review, images, y) {
  const list = review.damages || [];
  y = K.ensure(doc, ctx, y, 22 + 40);
  y = K.drawSection(doc, y, "Daños encontrados en esta revisión", list.length ? `${list.length} ${list.length === 1 ? "daño" : "daños"}` : null);
  if (!list.length) {
    doc.roundedRect(MARGIN, y, CONTENT_W, 26, 8).fill(C.greenSoft);
    doc.font(FONT_BOLD).fontSize(8.5).fillColor(C.green).text("Sin daños nuevos.", MARGIN + 14, y + 9, { width: CONTENT_W - 28, lineBreak: false });
    return y + 34;
  }
  list.forEach((d, i) => { y = drawDamage(doc, ctx, images, d, i + 1, y); });
  return y;
}

function drawPrevious(doc, ctx, review, y) {
  const list = review.previous || [];
  y = K.ensure(doc, ctx, y + 4, 22 + 40);
  y = K.drawSection(doc, y, "Daños que ya estaban abiertos", list.length ? `${list.length} de revisiones anteriores` : null);
  if (!list.length) {
    doc.roundedRect(MARGIN, y, CONTENT_W, 26, 8).fill(C.soft);
    doc.font(FONT).fontSize(8.5).fillColor(C.muted).text("Ninguno: el vehículo no tenía daños abiertos.", MARGIN + 14, y + 9, { width: CONTENT_W - 28, lineBreak: false });
    return y + 34;
  }
  const cols = [
    { title: "ZONA", w: 150 },
    { title: "TIPO", w: 72 },
    { title: "DESDE", w: 104 },
    { title: "OBSERVACIÓN", w: CONTENT_W - 326 },
  ];
  const headerH = 18;
  const drawHead = (top) => {
    doc.roundedRect(MARGIN, top, CONTENT_W, headerH, 6).fill(C.soft);
    let x = MARGIN;
    cols.forEach((c) => {
      doc.font(FONT_BOLD).fontSize(6.5).fillColor(C.muted).text(c.title, x + 8, top + 6, { width: c.w - 12, characterSpacing: 0.4, lineBreak: false });
      x += c.w;
    });
    return top + headerH;
  };
  y = drawHead(y);
  list.forEach((d, n) => {
    const cells = [damageTitle(d), damageTypeLabel(d.damage_type), `${d.review_number} · ${K.fmtDate(d.review_date)}`, d.description || ""];
    doc.font(FONT).fontSize(8);
    const h = Math.max(18, ...cells.map((t, i) => doc.heightOfString(t, { width: cols[i].w - 12 }) + 8));
    if (y + h > BOTTOM) {
      doc.addPage();
      y = drawHead(K.drawHeader(doc, ctx));
    }
    let x = MARGIN;
    cells.forEach((t, i) => {
      doc.font(i === 0 ? FONT_BOLD : FONT).fontSize(8).fillColor(i === 0 ? C.ink : C.text).text(t, x + 8, y + 4, { width: cols[i].w - 12 });
      x += cols[i].w;
    });
    if (n < list.length - 1) doc.moveTo(MARGIN + 8, y + h).lineTo(PAGE_W - MARGIN - 8, y + h).lineWidth(0.4).strokeColor(C.line).stroke();
    y += h;
  });
  return y + 10;
}

function drawReview(doc, review, images) {
  const ctx = { title: TITLE, number: review.number };
  let y = K.startDoc(doc, ctx);
  const anulada = review.status === "voided";
  if (anulada) {
    y = K.drawVoidNotice(doc, y,
      `Revisión anulada el ${K.fmtDateTime(review.voided_at)}${review.voided_by_name ? ` por ${review.voided_by_name}` : ""}. Motivo: ${review.void_reason || "—"}`);
  }
  const nuevos = (review.damages || []).length;
  const abiertos = (review.previous || []).length;
  y = K.drawHero(doc, y, {
    plate: review.vehicle_plate,
    vehicle: review.vehicle_label,
    subtitle: `${K.fmtDate(review.review_date)} · ${reasonLabel(review.reason)}`,
    status: anulada
      ? { text: "ANULADA", tone: "neutral" }
      : nuevos
        ? { text: `${nuevos} ${nuevos === 1 ? "DAÑO NUEVO" : "DAÑOS NUEVOS"}`, tone: "bad" }
        : { text: "SIN DAÑOS NUEVOS", tone: "ok" },
    summary: `${abiertos} ${abiertos === 1 ? "daño abierto" : "daños abiertos"} de antes`,
  });
  y = K.drawFacts(doc, y + 10, [
    { label: "Conductor", value: review.driver_name },
    { label: "Motivo", value: reasonLabel(review.reason) },
    { label: "Tipo de vehículo", value: labelFrom(VEHICLE_KINDS, review.vehicle_kind) },
    { label: "Kilometraje", value: formatKm(review.odometer_km) },
  ]);
  y = drawCaptures(doc, ctx, review, images, y + 16);
  y = drawNewDamages(doc, ctx, review, images, y + 8);
  y = drawPrevious(doc, ctx, review, y + 4);
  K.drawClosing(doc, ctx, y, {
    notes: review.observations ? [{ title: "", text: review.observations }] : [],
    registered: `Registrada en la intranet por ${review.created_by_name} el ${K.fmtDateTime(review.created_at)}, quien declaró haber revisado el vehículo por fuera.`,
    signers: [["Firma del conductor", review.driver_name], ["Firma de quien revisó", review.created_by_name]],
  });
  K.finishDoc(doc, ctx, { voidStamp: anulada ? "ANULADA" : null });
}

/** Buffer del PDF de una revisión física (fila de getPhysicalReview). */
function renderPhysicalPdf(review, images = {}) {
  const imgs = { captures: images.captures || {}, photos: images.photos || new Map() };
  return K.renderPdf(`${TITLE} ${review.number}`, (doc) => drawReview(doc, review, imgs));
}

module.exports = { renderPhysicalPdf };
