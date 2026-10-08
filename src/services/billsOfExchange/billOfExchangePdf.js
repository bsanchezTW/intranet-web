const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
const {
  BILL_DRAWER,
  BILL_CLAUSES,
  formatBillMoney,
} = require("../../constants/billOfExchange");
const { formatDisplay } = require("../../utils/vacationDateUtils");

/**
 * PDF de letras de cambio: una letra por hoja A4 horizontal, en hoja blanca.
 *
 * Dibuja el formulario completo del talonario de Transworld (no sólo los
 * datos), siguiendo la distribución de la letra física: cláusulas especiales
 * en vertical a la izquierda, dos columnas de firma del aceptante, tabla de
 * número / fechas / importe, monto en letras, recuadros de aceptante, aval y
 * cuenta de cargo, y el recuadro de firma del representante legal.
 *
 * Todas las medidas están en puntos (1/72"). El formulario mide 794 × 372 y va
 * centrado arriba; la línea punteada que lo rodea es la guía de corte.
 */

const LOGO_PATH = path.join(__dirname, "..", "..", "public", "img", "logotw_blue.png");

const BLUE = "#26388f";
const INK = "#111111";
const VOID_RED = "#c62828";

const PAGE = { size: "A4", layout: "landscape" };
const X0 = 24;
const Y0 = 44;
const W = 794;
const H = 372;

// Zona principal (a la derecha de las cláusulas y las firmas del aceptante).
const MX = X0 + 168;
const MR = X0 + W - 8;
const MW = MR - MX;

// Columna derecha (cuenta de cargo y firma del girador).
const RX = MX + 370;
const RW = MR - RX;

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_ITALIC = "Helvetica-Oblique";

function upper(value) {
  return String(value ?? "").toLocaleUpperCase("es-PE");
}

/** Recorta con "…" hasta que quepa en `width` con la fuente y tamaño actuales. */
function truncateToWidth(doc, text, width) {
  if (doc.widthOfString(text) <= width) return text;
  let out = text;
  while (out.length > 1 && doc.widthOfString(`${out}…`) > width) out = out.slice(0, -1);
  return `${out.trimEnd()}…`;
}

/**
 * Texto de una línea que nunca se desborda: achica la fuente hasta `minSize`
 * y, si aún no cabe, recorta. La alineación se calcula a mano para no
 * depender del wrapper de pdfkit (que puede saltar de página).
 */
function fitText(doc, text, x, y, width, opts = {}) {
  const { font = FONT, size = 9, minSize = 6, color = INK, align = "left" } = opts;
  const value = String(text ?? "").trim();
  if (!value) return;
  doc.font(font);
  let s = size;
  doc.fontSize(s);
  while (s > minSize && doc.widthOfString(value) > width) {
    s -= 0.25;
    doc.fontSize(s);
  }
  const shown = truncateToWidth(doc, value, width);
  const w = doc.widthOfString(shown);
  let dx = 0;
  if (align === "center") dx = (width - w) / 2;
  else if (align === "right") dx = width - w;
  doc.fillColor(color).text(shown, x + dx, y, { lineBreak: false });
}

/** Parte un texto en líneas de `width` como máximo; la última se recorta. */
function wrapLines(doc, text, width, maxLines) {
  const words = String(text ?? "").trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (let i = 0; i < words.length; i += 1) {
    const candidate = current ? `${current} ${words[i]}` : words[i];
    if (doc.widthOfString(candidate) <= width || !current) {
      current = candidate;
      continue;
    }
    lines.push(current);
    current = words[i];
    if (lines.length === maxLines - 1) {
      current = words.slice(i).join(" ");
      break;
    }
  }
  if (current) lines.push(current);
  return lines.slice(0, maxLines).map((line, i, all) =>
    i === all.length - 1 ? truncateToWidth(doc, line, width) : line,
  );
}

function label(doc, text, x, y, size = 7.5) {
  doc.font(FONT).fontSize(size).fillColor(BLUE).text(text, x, y, { lineBreak: false });
}

function underline(doc, x1, x2, y) {
  doc.save().lineWidth(0.5).strokeColor(BLUE).moveTo(x1, y).lineTo(x2, y).stroke().restore();
}

function box(doc, x, y, w, h, radius = 0) {
  doc.save().lineWidth(0.9).strokeColor(BLUE);
  if (radius) doc.roundedRect(x, y, w, h, radius).stroke();
  else doc.rect(x, y, w, h).stroke();
  doc.restore();
}

function line(doc, x1, y1, x2, y2, width = 0.9) {
  doc.save().lineWidth(width).strokeColor(BLUE).moveTo(x1, y1).lineTo(x2, y2).stroke().restore();
}

/**
 * Texto que se lee de abajo hacia arriba, con su esquina inferior izquierda
 * en (x, y). Las líneas siguientes avanzan hacia la derecha.
 */
function verticalText(doc, x, y, length, draw) {
  doc.save();
  doc.rotate(-90, { origin: [x, y] });
  draw(x, y, length);
  doc.restore();
}

// ---------------------------------------------------------------------------
// Bloques del formulario
// ---------------------------------------------------------------------------

function drawCutGuide(doc) {
  doc.save()
    .lineWidth(0.4)
    .strokeColor("#b5b5b5")
    .dash(3, { space: 3 })
    .rect(X0 - 6, Y0 - 12, W + 12, H + 12)
    .stroke()
    .undash()
    .restore();
}

function drawClauses(doc) {
  const bottom = Y0 + 322;
  verticalText(doc, X0 + 10, bottom, 314, (x, y, width) => {
    doc.font(FONT_BOLD).fontSize(6.8).fillColor(BLUE)
      .text("CLÁUSULAS ESPECIALES", x, y, { width, lineGap: 1.5 });
    doc.font(FONT).fontSize(6.1);
    BILL_CLAUSES.forEach((clause, i) => {
      doc.text(`(${i + 1}) ${clause}`, { width, lineGap: 0.6, paragraphGap: 1.2 });
    });
  });
}

/** Las dos columnas donde firma el aceptante (arriba y abajo). */
function drawAcceptorSignatures(doc) {
  const blocks = [
    [Y0 + 8, Y0 + 160],
    [Y0 + 170, Y0 + 322],
  ];
  for (const [top, bottom] of blocks) {
    const length = bottom - top;
    line(doc, X0 + 104, top + 18, X0 + 104, bottom - 18, 0.7);
    verticalText(doc, X0 + 107, bottom - 18, length - 36, (x, y, width) => {
      fitText(doc, "ACEPTANTE", x, y, width, { font: FONT_BOLD, size: 7.5, color: BLUE, align: "center" });
    });
    verticalText(doc, X0 + 124, bottom - 4, length - 8, (x, y, width) => {
      fitText(doc, "Nombre / Representante:", x, y, width, { size: 6.5, color: BLUE });
    });
    verticalText(doc, X0 + 136, bottom - 4, length - 8, (x, y, width) => {
      fitText(doc, "D.O.I.:", x, y, width, { size: 6.5, color: BLUE });
    });
  }
  line(doc, X0 + 158, Y0 + 8, X0 + 158, Y0 + 322, 0.6);
}

function drawHeader(doc) {
  const logoWidth = 130;
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, MX + 36, Y0 + 1, { width: logoWidth });
  }
  fitText(doc, "Power and Telecom", MX + 36, Y0 + 37, logoWidth, { size: 8, color: BLUE, align: "center" });

  const titleX = MX + 250;
  const titleW = MR - titleX;
  fitText(doc, BILL_DRAWER.name, titleX, Y0 + 10, titleW, { font: FONT_BOLD, size: 12.5, color: BLUE, align: "center" });
  fitText(doc, `R.U.C.: ${BILL_DRAWER.ruc}`, titleX, Y0 + 27, titleW, { size: 10, color: BLUE, align: "center" });
}

const TABLE_COLUMNS = [
  { key: "number", title: "NUMERO", width: 100 },
  { key: "invoiceRef", title: "REF. DEL GIRADOR", width: 100 },
  { key: "issueDate", title: "FECHA DE GIRO", width: 100, date: true },
  { key: "issuePlace", title: "LUGAR DE GIRO", width: 100 },
  { key: "dueDate", title: "FECHA DE VENCIMIENTO", width: 108, date: true },
  { key: "amount", title: "MONEDA E IMPORTE", width: 110 },
];

function drawTopTable(doc, bill) {
  const top = Y0 + 52;
  const height = 50;
  const headerH = 14;
  const subH = 10;
  box(doc, MX, top, MW, height, 6);
  line(doc, MX, top + headerH, MR, top + headerH);

  const values = {
    number: bill.number,
    invoiceRef: bill.invoiceRef,
    issueDate: formatDisplay(bill.issueDate).replace(/-/g, "/"),
    issuePlace: upper(bill.issuePlace),
    dueDate: formatDisplay(bill.dueDate).replace(/-/g, "/"),
    amount: formatBillMoney(bill.amount),
  };

  let x = MX;
  TABLE_COLUMNS.forEach((col, i) => {
    if (i > 0) line(doc, x, top, x, top + height);
    fitText(doc, col.title, x + 3, top + 4, col.width - 6, { size: 6.8, color: BLUE, align: "center" });
    if (col.date) {
      line(doc, x, top + headerH + subH, x + col.width, top + headerH + subH, 0.6);
      fitText(doc, "DÍA / MES / AÑO", x + 3, top + headerH + 2.5, col.width - 6, { size: 5.8, color: BLUE, align: "center" });
      fitText(doc, values[col.key], x + 4, top + headerH + subH + 8, col.width - 8, { font: FONT_BOLD, size: 10, align: "center" });
    } else {
      const size = col.key === "amount" ? 11 : 10;
      fitText(doc, values[col.key], x + 4, top + headerH + (height - headerH - size) / 2 + 1, col.width - 8, {
        font: FONT_BOLD, size, align: "center",
      });
    }
    x += col.width;
  });
}

function drawOrderAndAmount(doc, bill) {
  const y = Y0 + 108;
  doc.font(FONT).fontSize(8).fillColor(BLUE)
    .text("Por esta ", MX, y, { continued: true, lineBreak: false })
    .font(FONT_BOLD).text("LETRA DE CAMBIO", { continued: true })
    .font(FONT).text(" se servirá(n) pagar incondicionalmente a la Orden de: ", { continued: true })
    .font(FONT_BOLD).text(BILL_DRAWER.name, { continued: false });

  const boxY = Y0 + 120;
  box(doc, MX, boxY, MW, 20, 6);
  label(doc, "La cantidad de:", MX + 8, boxY + 6.5);
  fitText(doc, bill.amountWords, MX + 72, boxY + 5.5, MW - 80, { font: FONT_BOLD, size: 10, minSize: 6.5 });

  label(doc, "En el siguiente lugar de pago, o con cargo en la cuenta del Banco:", MX, Y0 + 146);
}

/** Cinco renglones subrayados dentro de un recuadro, como en el talonario. */
const ROW_TOPS = [6, 20, 34, 48, 62];

function drawAcceptor(doc, bill) {
  const x = MX;
  const y = Y0 + 156;
  const w = 362;
  box(doc, x, y, w, 80, 8);
  const right = x + w - 8;
  const [r1, r2, r3, r4, r5] = ROW_TOPS.map((t) => y + t);
  const { acceptor } = bill;

  label(doc, "Aceptante", x + 8, r1 + 1.5);
  underline(doc, x + 50, right, r1 + 10.5);
  underline(doc, x + 8, right, r2 + 10.5);
  doc.font(FONT_BOLD).fontSize(8.5);
  const nameLines = wrapLines(doc, upper(acceptor.name), right - (x + 52), 2);
  nameLines.forEach((text, i) => {
    fitText(doc, text, i === 0 ? x + 52 : x + 10, (i === 0 ? r1 : r2) + 1, right - (i === 0 ? x + 52 : x + 10), {
      font: FONT_BOLD, size: 8.5,
    });
  });

  label(doc, "Domicilio", x + 8, r3 + 1.5);
  underline(doc, x + 50, right, r3 + 10.5);
  underline(doc, x + 8, x + 196, r4 + 10.5);
  doc.font(FONT).fontSize(8);
  const addressFirstW = right - (x + 52);
  const addressLines = wrapLines(doc, upper(acceptor.address), addressFirstW, 2);
  if (addressLines[0]) fitText(doc, addressLines[0], x + 52, r3 + 1, addressFirstW, { size: 8 });
  if (addressLines[1]) fitText(doc, addressLines[1], x + 10, r4 + 1, 184, { size: 8, minSize: 5.5 });

  label(doc, "Localidad", x + 202, r4 + 1.5);
  underline(doc, x + 240, right, r4 + 10.5);
  fitText(doc, upper(acceptor.locality), x + 242, r4 + 1, right - (x + 242), { size: 8 });

  label(doc, "D.O.I.", x + 8, r5 + 1.5);
  underline(doc, x + 50, x + 190, r5 + 10.5);
  fitText(doc, acceptor.doc, x + 52, r5 + 1, 136, { font: FONT_BOLD, size: 8.5 });
  label(doc, "Teléfono", x + 202, r5 + 1.5);
  underline(doc, x + 240, right, r5 + 10.5);
  fitText(doc, acceptor.phone, x + 242, r5 + 1, right - (x + 242), { size: 8 });
}

function drawBankAccount(doc, bill) {
  fitText(doc, "Importe a debitar en la siguiente cuenta del BANCO que se indica", RX, Y0 + 158, RW, {
    size: 7, color: BLUE,
  });
  const top = Y0 + 168;
  const headerH = 13;
  const height = 31;
  const cols = [
    ["BANCO", bill.bank.name, 62],
    ["OFICINA", bill.bank.office, 52],
    ["NÚMERO DE CUENTA", bill.bank.account, RW - 62 - 52 - 30],
    ["DC", bill.bank.dc, 30],
  ];
  box(doc, RX, top, RW, height);
  line(doc, RX, top + headerH, RX + RW, top + headerH, 0.7);
  let x = RX;
  cols.forEach(([title, value, width], i) => {
    if (i > 0) line(doc, x, top, x, top + height, 0.7);
    fitText(doc, title, x + 2, top + 3.5, width - 4, { size: 6.8, color: BLUE, align: "center" });
    fitText(doc, upper(value), x + 3, top + headerH + 5, width - 6, { size: 8, minSize: 5.5, align: "center" });
    x += width;
  });
}

function drawGuarantor(doc, bill) {
  const x = MX;
  const y = Y0 + 242;
  const w = 362;
  box(doc, x, y, w, 80, 8);
  const right = x + w - 8;
  const [r1, r2, r3, r4, r5] = ROW_TOPS.map((t) => y + t);
  const { guarantor } = bill;

  label(doc, "Aval Permanente", x + 8, r1 + 1.5);
  underline(doc, x + 72, right, r1 + 10.5);
  underline(doc, x + 8, right, r2 + 10.5);
  doc.font(FONT_BOLD).fontSize(8.5);
  const nameLines = wrapLines(doc, upper(guarantor.name), right - (x + 74), 2);
  nameLines.forEach((text, i) => {
    const tx = i === 0 ? x + 74 : x + 10;
    fitText(doc, text, tx, (i === 0 ? r1 : r2) + 1, right - tx, { font: FONT_BOLD, size: 8.5 });
  });

  label(doc, "Domicilio", x + 8, r3 + 1.5);
  underline(doc, x + 50, right, r3 + 10.5);
  fitText(doc, upper(guarantor.address), x + 52, r3 + 1, right - (x + 52), { size: 8, minSize: 5.5 });

  label(doc, "Localidad", x + 8, r4 + 1.5);
  underline(doc, x + 50, x + 196, r4 + 10.5);
  fitText(doc, upper(guarantor.locality), x + 52, r4 + 1, 142, { size: 8 });
  label(doc, "Teléfono", x + 202, r4 + 1.5);
  underline(doc, x + 240, right, r4 + 10.5);
  fitText(doc, guarantor.phone, x + 242, r4 + 1, right - (x + 242), { size: 8 });

  label(doc, "D.O.I.", x + 8, r5 + 1.5);
  underline(doc, x + 50, x + 196, r5 + 10.5);
  fitText(doc, guarantor.doc, x + 52, r5 + 1, 142, { font: FONT_BOLD, size: 8.5 });
  label(doc, "Firma", x + 202, r5 + 1.5);
  underline(doc, x + 240, right, r5 + 10.5);
}

/** Rótulo seguido de un renglón en blanco hasta el borde derecho. */
function labelledBlank(doc, text, x, y, right) {
  label(doc, text, x, y, 7);
  const end = x + doc.font(FONT).fontSize(7).widthOfString(text) + 4;
  underline(doc, end, right, y + 8.5);
}

/**
 * Recuadro del girador, como en el talonario: la razón social la pone el
 * sello de la empresa (cae en el espacio libre del medio) y la firma va a
 * mano. Sólo el nombre del representante legal sale impreso.
 */
function drawDrawerSignature(doc) {
  const y = Y0 + 206;
  const left = RX + 8;
  const right = RX + RW - 8;
  box(doc, RX, y, RW, 116, 8);

  labelledBlank(doc, "Nombre o Razón Social del Girador", left, y + 10, right);

  line(doc, left, y + 70, right, y + 70, 0.6);
  fitText(doc, "Firma", left, y + 73, right - left, { size: 6.5, color: BLUE, align: "center" });

  label(doc, "Nombre del Representante Legal:", left, y + 84, 7);
  fitText(doc, BILL_DRAWER.representative, left + 2, y + 93.5, right - left - 4, { font: FONT_BOLD, size: 8 });
  underline(doc, left, right, y + 102);
  labelledBlank(doc, "D.O.I.", left, y + 105, right);
}

function drawFooterRule(doc) {
  line(doc, X0 + 8, Y0 + 332, X0 + W - 8, Y0 + 332, 0.9);
  doc.font(FONT_ITALIC).fontSize(7).fillColor(BLUE)
    .text("No escribir ni firmar debajo de esta línea", X0 + 40, Y0 + 336, { lineBreak: false });
}

function drawVoidStamp(doc) {
  const cx = X0 + W / 2;
  const cy = Y0 + H / 2 - 10;
  doc.save();
  doc.rotate(-14, { origin: [cx, cy] });
  doc.fillOpacity(0.18).fillColor(VOID_RED).font(FONT_BOLD).fontSize(96);
  const text = "ANULADA";
  const w = doc.widthOfString(text);
  doc.text(text, cx - w / 2, cy - 48, { lineBreak: false });
  doc.restore();
}

function drawBill(doc, bill) {
  doc.addPage({ ...PAGE, margin: 0 });
  drawCutGuide(doc);
  drawClauses(doc);
  drawAcceptorSignatures(doc);
  drawHeader(doc);
  drawTopTable(doc, bill);
  drawOrderAndAmount(doc, bill);
  drawAcceptor(doc, bill);
  drawBankAccount(doc, bill);
  drawGuarantor(doc, bill);
  drawDrawerSignature(doc);
  drawFooterRule(doc);
  if (bill.voided) drawVoidStamp(doc);
}

/**
 * Arma el PDF y lo devuelve como Buffer. `bills` son objetos de
 * billOfExchangeService.toPrintable.
 */
function renderBillsPdf(bills, { title = "Letras de cambio" } = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      ...PAGE,
      margin: 0,
      autoFirstPage: false,
      info: { Title: title, Author: BILL_DRAWER.name, Creator: "Intranet Transworld" },
    });
    const chunks = [];
    doc.on("data", (chunk) => chunks.push(chunk));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    try {
      for (const bill of bills) drawBill(doc, bill);
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = { renderBillsPdf };
