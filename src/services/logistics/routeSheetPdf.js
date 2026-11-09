const { formatKm } = require("../../constants/vehicleChecklist");
const { localityLabel, formatTime, statusLabel } = require("../../constants/routeSheet");
const K = require("./reviewPdfKit");
const { signatureSlots, contentHash } = require("./routeSheetService");

const { C, FONT, FONT_BOLD, MARGIN, CONTENT_W, BOTTOM } = K;

/**
 * PDF de la hoja de ruta (HR-00001-2026), con el lenguaje de los PDF de
 * Logística (reviewPdfKit): la franja con la patente y el estado, los datos
 * de la salida y la tabla de paradas con las columnas de la hoja en papel
 * (Cliente · Comuna · GD · Nota de venta · Observaciones), con la hora de
 * inicio y la de llegada a destino en 24 horas.
 * A4 vertical.
 *
 * Al pie, las firmas electrónicas (conductor, peoneta y Logística) con su
 * código y la huella del contenido; no hay líneas para firmar a mano.
 *
 * Una hoja abierta se imprime con filas en blanco hasta completar las 10 del
 * papel, para llevarla en el vehículo y anotar a mano lo que falte. Si las
 * paradas no caben en una hoja, la tabla sigue en la próxima con su
 * encabezado.
 */

const TITLE = "Hoja de ruta";
const AREA = "LOGÍSTICA · HOJAS DE RUTA";
const STATUS_TONES = { open: "brand", closed: "ok", voided: "neutral" };
const PAPER_ROWS = 10;

const FONT_SIZE = 7.6;
const HEAD_H = 18;
const MIN_ROW_H = 17;
const PAD_X = 5;
const RADIUS = 7;

/** Columnas: `w` fijo; Cliente y Observaciones se reparten el resto. */
function columns() {
  const fijas = [
    { key: "position", title: "N°", w: 20, align: "center" },
    { key: "client_name", title: "Cliente", flex: 0.45 },
    { key: "locality", title: localityLabel(), w: 72 },
    { key: "dispatch_guide", title: "GD", w: 44 },
    { key: "sales_note", title: "Nota venta", w: 56 },
    { key: "departed_at", title: "Inicio", w: 44, align: "center", time: true },
    { key: "arrived_at", title: "Llegada", w: 44, align: "center", time: true },
    { key: "observations", title: "Observaciones", flex: 0.55 },
  ];
  const libre = CONTENT_W - fijas.reduce((s, c) => s + (c.w || 0), 0);
  let x = MARGIN;
  return fijas.map((c) => {
    const w = c.w || libre * c.flex;
    const col = { ...c, w, x };
    x += w;
    return col;
  });
}

function cellText(col, stop) {
  if (!stop) return "";
  const value = stop[col.key];
  if (col.time) return value ? formatTime(value) : "";
  return value == null ? "" : String(value);
}

/** Filas con su alto: las paradas y, si está abierta, las vacías del papel. */
function buildRows(doc, sheet, cols) {
  const stops = Array.isArray(sheet.stops) ? sheet.stops : [];
  const rows = stops.map((stop) => {
    doc.font(FONT).fontSize(FONT_SIZE);
    const h = Math.max(
      MIN_ROW_H,
      ...cols.map((c) => doc.heightOfString(cellText(c, stop) || " ", { width: c.w - 2 * PAD_X }) + 8),
    );
    return { stop, h };
  });
  if (sheet.status === "open") {
    for (let n = stops.length + 1; n <= Math.max(PAPER_ROWS, stops.length); n += 1) {
      rows.push({ stop: null, position: n, h: MIN_ROW_H + 4 });
    }
  }
  return rows;
}

function drawHeadRow(doc, y, cols) {
  doc.rect(MARGIN, y, CONTENT_W, HEAD_H).fill(C.soft);
  doc.font(FONT_BOLD).fontSize(6.4).fillColor(C.muted);
  for (const c of cols) {
    doc.text(c.title.toUpperCase(), c.x + PAD_X, y + 6, {
      width: c.w - 2 * PAD_X, align: c.align || "left", characterSpacing: 0.4, lineBreak: false, ellipsis: true,
    });
  }
}

function drawRow(doc, y, cols, row, last) {
  for (const c of cols) {
    const text = c.key === "position" ? String(row.stop ? row.stop.position : row.position) : cellText(c, row.stop);
    if (!text) continue;
    const bold = c.key === "position" || c.key === "client_name";
    doc.font(bold ? FONT_BOLD : FONT).fontSize(FONT_SIZE)
      .fillColor(c.key === "position" || c.key === "observations" ? C.muted : C.ink)
      .text(text, c.x + PAD_X, y + 4.5, { width: c.w - 2 * PAD_X, align: c.align || "left" });
  }
  // Líneas verticales suaves, como las de la planilla, y la de cada fila.
  for (const c of cols.slice(1)) {
    doc.moveTo(c.x, y).lineTo(c.x, y + row.h).lineWidth(0.3).strokeColor(C.line).stroke();
  }
  if (!last) doc.moveTo(MARGIN, y + row.h).lineTo(MARGIN + CONTENT_W, y + row.h).lineWidth(0.4).strokeColor(C.line).stroke();
}

/** Un tramo de la tabla en su marco redondeado. */
function drawTable(doc, y, cols, rows) {
  const h = HEAD_H + rows.reduce((s, r) => s + r.h, 0);
  doc.save();
  doc.roundedRect(MARGIN, y, CONTENT_W, h, RADIUS).clip();
  drawHeadRow(doc, y, cols);
  let cy = y + HEAD_H;
  rows.forEach((r, i) => {
    drawRow(doc, cy, cols, r, i === rows.length - 1);
    cy += r.h;
  });
  doc.restore();
  doc.roundedRect(MARGIN, y, CONTENT_W, h, RADIUS).lineWidth(0.7).strokeColor(C.line).stroke();
  return y + h;
}

function drawStops(doc, ctx, sheet, startY) {
  const cols = columns();
  let rows = buildRows(doc, sheet, cols);
  const n = (sheet.stops || []).length;
  let y = K.ensure(doc, ctx, startY, 19 + HEAD_H + MIN_ROW_H * 2);
  y = K.drawSection(doc, y, "Paradas", n === 1 ? "1 parada" : `${n} paradas`);

  if (!rows.length) {
    doc.roundedRect(MARGIN, y, CONTENT_W, 30, RADIUS).fill(C.soft);
    doc.font(FONT).fontSize(8.5).fillColor(C.muted).text("La hoja no tiene paradas.", MARGIN, y + 11, { width: CONTENT_W, align: "center" });
    return y + 30;
  }

  let bottom = y;
  while (rows.length) {
    const available = BOTTOM - y - HEAD_H;
    let cut = 0;
    let acc = 0;
    while (cut < rows.length && acc + rows[cut].h <= available) acc += rows[cut++].h;
    cut = Math.max(1, cut);
    bottom = drawTable(doc, y, cols, rows.slice(0, cut));
    rows = rows.slice(cut);
    if (rows.length) {
      doc.addPage();
      y = K.drawHeader(doc, ctx);
    }
  }
  return bottom;
}

// --- Firmas electrónicas ------------------------------------------------------

const SIGN_H = 76;
const SIGN_GAP = 10;

/**
 * Un sello por firma: quién firmó, cuándo y el código de la huella; si
 * falta, «Pendiente de firma». Abajo, la huella completa del contenido para
 * comprobarla contra la intranet.
 */
function drawSignatures(doc, ctx, startY, sheet) {
  const slots = signatureSlots(sheet);
  const huella = contentHash(sheet);
  const firmadas = slots.filter((s) => s.signature).length;
  let y = K.ensure(doc, ctx, startY, 19 + SIGN_H + 30);
  y = K.drawSection(doc, y, "Firmas electrónicas", `${firmadas} de ${slots.length}`);

  const w = (CONTENT_W - SIGN_GAP * (slots.length - 1)) / slots.length;
  slots.forEach((slot, i) => {
    const x = MARGIN + i * (w + SIGN_GAP);
    const g = slot.signature;
    const intacta = g && g.content_hash === huella;
    const [tinta, fondo] = !g ? [C.muted, C.soft] : intacta ? [C.green, C.greenSoft] : [C.red, C.redSoft];
    doc.roundedRect(x, y, w, SIGN_H, 8).fill(fondo);
    if (!g) doc.roundedRect(x, y, w, SIGN_H, 8).dash(3, { space: 2 }).lineWidth(0.7).strokeColor(C.line).stroke().undash();

    const tx = x + 11;
    const tw = w - 22;
    doc.font(FONT_BOLD).fontSize(6.3).fillColor(C.muted)
      .text(slot.label.toUpperCase(), tx, y + 9, { width: tw, characterSpacing: 0.5, lineBreak: false, ellipsis: true });
    const nombre = g ? g.signer_name : slot.role === "logistica" ? "Logística" : slot.expectedName;
    doc.font(FONT_BOLD).fontSize(9.5).fillColor(g ? tinta : C.ink)
      .text(nombre || "—", tx, y + 20, { width: tw, lineBreak: false, ellipsis: true });
    const lineas = g
      ? ["Firmado electrónicamente", `el ${K.fmtDateTime(g.signed_at)}`, `Código ${g.code}${intacta ? "" : " · el contenido cambió"}`]
      : slot.blocked
        ? ["Sin cuenta en la intranet:", "no firma electrónicamente."]
        : ["Pendiente de firma"];
    doc.font(FONT).fontSize(7.3).fillColor(g ? C.text : C.muted);
    lineas.forEach((t, n) => doc.text(t, tx, y + 35 + n * 11, { width: tw, lineBreak: false, ellipsis: true }));
  });
  y += SIGN_H + 8;

  doc.font(FONT).fontSize(6.5).fillColor(C.faint)
    .text(`Firma electrónica simple con la cuenta de cada persona en la intranet. Huella SHA-256 del contenido: ${huella}`,
      MARGIN, y, { width: CONTENT_W });
  return doc.y;
}

function drawRouteSheet(doc, sheet) {
  const ctx = { title: TITLE, number: sheet.number, area: AREA };
  let y = K.startDoc(doc, ctx);
  const anulada = sheet.status === "voided";
  const abierta = sheet.status === "open";
  const recorrido = sheet.km_end != null ? Number(sheet.km_end) - Number(sheet.km_start) : null;
  const n = (sheet.stops || []).length;

  if (anulada) {
    y = K.drawVoidNotice(doc, y,
      `Hoja anulada el ${K.fmtDateTime(sheet.voided_at)}${sheet.voided_by_name ? ` por ${sheet.voided_by_name}` : ""}. Motivo: ${sheet.void_reason || "—"}`);
  }

  y = K.drawHero(doc, y, {
    plate: sheet.vehicle_plate,
    vehicle: sheet.vehicle_label,
    subtitle: `${K.fmtDate(sheet.route_date)} · ${sheet.driver_name}`,
    status: { text: statusLabel(sheet.status).toUpperCase(), tone: STATUS_TONES[sheet.status] || "neutral" },
    summary: `${n === 1 ? "1 parada" : `${n} paradas`}${recorrido == null ? "" : ` · ${formatKm(recorrido)}`}`,
  });

  y = K.drawFacts(doc, y + 8, [
    { label: "Fecha", value: K.fmtDate(sheet.route_date) },
    { label: "Conductor", value: sheet.driver_name },
    { label: "Peoneta", value: sheet.helper_name || "—" },
    { label: "Km inicial", value: formatKm(sheet.km_start) },
    // Abierta, quedan en blanco para anotarlos a mano (un espacio: vacío sería «—»).
    { label: "Km final", value: sheet.km_end == null ? " " : formatKm(sheet.km_end) },
    { label: "Recorrido", value: recorrido == null ? " " : formatKm(recorrido) },
  ], { cols: 3 });

  y = drawStops(doc, ctx, sheet, y + 12);

  const registro = [`Abierta en la intranet por ${sheet.created_by_name} el ${K.fmtDateTime(sheet.created_at)}`];
  if (sheet.closed_at) registro.push(`cerrada por ${sheet.closed_by_name || "—"} el ${K.fmtDateTime(sheet.closed_at)}`);
  y = K.drawClosing(doc, ctx, y + 4, {
    notes: sheet.observations ? [{ title: "", text: sheet.observations }] : [],
    // La fecha termina en «p. m.»: no se le suma otro punto.
    registered: `${registro.join("; ").replace(/\.?$/, ".")}${abierta ? " Sin cerrar: el km final y las paradas que falten se anotan a mano." : ""}`,
    signers: [],
  });
  drawSignatures(doc, ctx, y + 10, sheet);

  K.finishDoc(doc, ctx, { voidStamp: anulada ? "ANULADA" : null });
}

/** Buffer del PDF de una hoja de ruta (fila de getRouteSheet, con `stops`). */
function renderRouteSheetPdf(sheet) {
  return K.renderPdf(`${TITLE} ${sheet.number}`, (doc) => drawRouteSheet(doc, sheet));
}

module.exports = { renderRouteSheetPdf, PAPER_ROWS };
