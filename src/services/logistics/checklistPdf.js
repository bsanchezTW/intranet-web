const { getCountryConfig } = require("../../config/country");
const {
  INSPECTION_KINDS,
  RESULTS,
  labelFrom,
  formatKm,
} = require("../../constants/vehicleChecklist");
const { documentsFor } = require("./vehicleService");
const K = require("./reviewPdfKit");

const { C, FONT, FONT_BOLD, MARGIN, CONTENT_W, BOTTOM } = K;

/**
 * PDF de la revisión mecánica (CV-00001-2026), con el lenguaje de los PDF de
 * Gestión de flota (reviewPdfKit): la franja con la patente y el resultado,
 * los datos y documentos del vehículo, el estado mecánico en dos columnas
 * por categoría (Descripción · Sí · No · N/A, como en la planilla de papel)
 * y al pie las observaciones y las firmas. A4 vertical.
 *
 * Las marcas se dibujan: Helvetica no trae ✓ ni ✗. Si los ítems no caben en
 * una hoja, las columnas siguen en la próxima con el encabezado de la
 * categoría repetido.
 */

const TITLE = "Revisión mecánica";
const RESULT_TONES = { apto: "ok", observado: "warn", no_apto: "bad" };

// Dos columnas de ítems, cada una con Descripción y tres marcas.
const GUTTER = 12;
const COL_W = (CONTENT_W - GUTTER) / 2;
const MARK_W = 24;
const LABEL_W = COL_W - 3 * MARK_W;
const GROUP_H = 15;
const ITEM_FONT = 7.8;
const MIN_ITEM_H = 11.5;
const RADIUS = 7;

// --- Marcas -------------------------------------------------------------------

const MARK_R = 4.3;

function drawEmptyMark(doc, cx, cy) {
  doc.circle(cx, cy, MARK_R).lineWidth(0.6).strokeColor(C.line).stroke();
}

function drawCheck(doc, cx, cy) {
  doc.circle(cx, cy, MARK_R).fill(C.green);
  doc.save().lineWidth(1.2).strokeColor(C.white).lineCap("round").lineJoin("round")
    .moveTo(cx - 2.2, cy + 0.1).lineTo(cx - 0.6, cy + 1.8).lineTo(cx + 2.4, cy - 1.7).stroke().restore();
}

function drawCross(doc, cx, cy) {
  doc.circle(cx, cy, MARK_R).fill(C.red);
  doc.save().lineWidth(1.2).strokeColor(C.white).lineCap("round")
    .moveTo(cx - 1.7, cy - 1.7).lineTo(cx + 1.7, cy + 1.7).moveTo(cx + 1.7, cy - 1.7).lineTo(cx - 1.7, cy + 1.7).stroke().restore();
}

function drawDash(doc, cx, cy) {
  doc.circle(cx, cy, MARK_R).fill(C.graySoft);
  doc.save().lineWidth(1.1).strokeColor(C.muted).lineCap("round").moveTo(cx - 1.8, cy).lineTo(cx + 1.8, cy).stroke().restore();
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
    doc.font(a.critical ? FONT_BOLD : FONT);
    const h = Math.max(MIN_ITEM_H, doc.heightOfString(label, { width: LABEL_W - 10 }) + 4);
    rows.push({ type: "item", answer: a, label, category: categoria, h });
  }
  return rows;
}

function drawGroupRow(doc, x, y, category, cont) {
  doc.rect(x, y, COL_W, GROUP_H).fill(C.soft);
  doc.font(FONT_BOLD).fontSize(6.8).fillColor(C.brand)
    .text(`${String(category).toUpperCase()}${cont ? " (CONT.)" : ""}`, x + 8, y + 4.5, { width: LABEL_W - 10, characterSpacing: 0.4, lineBreak: false, ellipsis: true });
  doc.font(FONT_BOLD).fontSize(6.3).fillColor(C.muted);
  ["SÍ", "NO", "N/A"].forEach((t, i) => {
    doc.text(t, x + LABEL_W + i * MARK_W, y + 4.9, { width: MARK_W, align: "center", lineBreak: false });
  });
}

function drawItemRow(doc, x, y, row, last) {
  const a = row.answer;
  if (a.answer === "falla") doc.rect(x, y, COL_W, row.h).fill(C.redSoft);
  doc.font(a.critical ? FONT_BOLD : FONT).fontSize(ITEM_FONT).fillColor(a.answer === "na" ? C.muted : C.ink)
    .text(row.label, x + 8, y + 2.5, { width: LABEL_W - 10 });
  const cy = y + row.h / 2;
  const col = { ok: 0, falla: 1, na: 2 }[a.answer];
  for (let i = 0; i < 3; i += 1) {
    const cx = x + LABEL_W + i * MARK_W + MARK_W / 2;
    if (i !== col) drawEmptyMark(doc, cx, cy);
    else if (a.answer === "ok") drawCheck(doc, cx, cy);
    else if (a.answer === "falla") drawCross(doc, cx, cy);
    else drawDash(doc, cx, cy);
  }
  if (!last) doc.moveTo(x + 8, y + row.h).lineTo(x + COL_W - 8, y + row.h).lineWidth(0.4).strokeColor(C.line).stroke();
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

/** Una columna en su marco redondeado. */
function drawColumn(doc, x, y, rows) {
  // La columna empieza a mitad de una categoría: se repite su encabezado.
  const repite = rows[0] && rows[0].type === "item";
  const h = (repite ? GROUP_H : 0) + rows.reduce((s, r) => s + r.h, 0);
  doc.save();
  doc.roundedRect(x, y, COL_W, h, RADIUS).clip();
  let cy = y;
  if (repite) {
    drawGroupRow(doc, x, cy, rows[0].category, true);
    cy += GROUP_H;
  }
  rows.forEach((r, i) => {
    const siguiente = rows[i + 1];
    if (r.type === "group") drawGroupRow(doc, x, cy, r.category, false);
    else drawItemRow(doc, x, cy, r, !siguiente || siguiente.type === "group");
    cy += r.h;
  });
  doc.restore();
  doc.roundedRect(x, y, COL_W, h, RADIUS).lineWidth(0.7).strokeColor(C.line).stroke();
  return y + h;
}

function drawItems(doc, ctx, registro, startY) {
  let rows = buildRows(doc, registro.answers);
  const total = (registro.answers || []).length;
  const noes = (registro.answers || []).filter((a) => a.answer === "falla").length;
  let y = K.drawSection(doc, startY, "Estado mecánico del vehículo",
    `${total} ítems · ${noes ? `${noes} no ${noes === 1 ? "operativo" : "operativos"}` : "todos operativos o no aplican"}`);

  let bottom = y;
  while (rows.length) {
    const available = BOTTOM - y - GROUP_H - 14;
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
      doc.addPage();
      y = K.drawHeader(doc, ctx);
    }
  }

  doc.font(FONT).fontSize(6.8).fillColor(C.muted)
    .text("* Ítem crítico: si no está operativo, el vehículo no debe salir.", MARGIN, bottom + 5, { width: CONTENT_W, lineBreak: false });
  return bottom + 11;
}

function drawChecklist(doc, registro) {
  const ctx = { title: TITLE, number: registro.number };
  const { code } = getCountryConfig();
  let y = K.startDoc(doc, ctx);
  const anulado = registro.status === "voided";

  if (anulado) {
    y = K.drawVoidNotice(doc, y,
      `Revisión anulada el ${K.fmtDateTime(registro.voided_at)}${registro.voided_by_name ? ` por ${registro.voided_by_name}` : ""}. Motivo: ${registro.void_reason || "—"}`);
  }

  const result = RESULTS[registro.result] || { label: registro.result || "—" };
  y = K.drawHero(doc, y, {
    plate: registro.vehicle_plate,
    vehicle: registro.vehicle_label,
    subtitle: `${K.fmtDate(registro.inspection_date)} · ${labelFrom(INSPECTION_KINDS, registro.inspection_kind)}`,
    status: anulado ? { text: "ANULADA", tone: "neutral" } : { text: result.label.toUpperCase(), tone: RESULT_TONES[registro.result] || "neutral" },
  });

  // Un documento vencido el día de la revisión se marca en rojo.
  const vencido = (iso) => Boolean(iso) && iso < registro.inspection_date;
  const documentos = documentsFor(code).map((d) => ({
    label: d.label,
    value: K.fmtDate(registro[d.field]),
    alert: vencido(registro[d.field]),
  }));
  const mantencion = registro.next_maintenance_km;
  y = K.drawFacts(doc, y + 8, [
    { label: "Conductor", value: registro.driver_name },
    { label: "Kilometraje", value: formatKm(registro.odometer_km) },
    {
      label: "Próx. mantención",
      value: mantencion == null ? "—" : formatKm(mantencion),
      alert: mantencion != null && Number(registro.odometer_km) >= Number(mantencion),
    },
    { label: "Combustible", value: registro.fuel_level },
    ...documentos,
  ]);

  y = drawItems(doc, ctx, registro, y + 12);

  const notas = (registro.answers || []).filter((a) => a.comment);
  K.drawClosing(doc, ctx, y, {
    notes: [
      ...notas.map((a) => ({ title: `${a.label}${a.answer === "falla" ? " (no operativo)" : ""}: `, text: a.comment })),
      ...(registro.observations ? [{ title: "Generales: ", text: registro.observations }] : []),
    ],
    registered: `Registrada en la intranet por ${registro.created_by_name} el ${K.fmtDateTime(registro.created_at)}, quien declaró haber revisado el vehículo.`,
    signers: [["Firma del conductor", registro.driver_name], ["Firma de quien revisó", registro.created_by_name]],
  });

  K.finishDoc(doc, ctx, { voidStamp: anulado ? "ANULADA" : null });
}

/** Buffer del PDF de una revisión mecánica (fila de getChecklist, con `answers`). */
function renderChecklistPdf(registro) {
  return K.renderPdf(`${TITLE} ${registro.number}`, (doc) => drawChecklist(doc, registro));
}

module.exports = { renderChecklistPdf };
