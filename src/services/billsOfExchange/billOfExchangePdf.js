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
 * PDF de letras de cambio: una letra por hoja carta horizontal, en hoja blanca.
 *
 * Dibuja el formulario completo del talonario de Transworld (no sólo los
 * datos), siguiendo la distribución de la letra física: cláusulas especiales
 * en vertical a la izquierda, dos columnas de firma del aceptante, tabla de
 * número / fechas / importe, monto en letras, recuadros de aceptante, aval y
 * cuenta de cargo, y el recuadro de firma del girador.
 *
 * La letra mide exactamente 22 × 11 cm: un recuadro azul prepicado marca sus
 * bordes y parte de la esquina superior izquierda de la hoja, así que basta
 * cortar por la derecha y por abajo. Como 22 cm no caben a lo ancho de una
 * hoja vertical, la hoja es horizontal. La página es carta, la que más se usa;
 * en A4 u oficio la letra cabe igual. El PDF pide imprimirse a tamaño real
 * (PrintScaling /None) para que "ajustar a la página" no la achique: sea cual
 * sea el papel, mide 22 × 11 cm.
 *
 * El diseño se dibuja en unidades lógicas (las del talonario apaisado
 * original, 794 de ancho) y se lleva al tamaño real con una escala uniforme
 * DESIGN_SCALE. Las posiciones verticales se ajustan con SY (Y() y V()) para
 * que el contenido llene justo el alto del recuadro; los textos no se
 * deforman.
 */

// Copia a 800 px de public/img/logotw_blue.png (4000 × 1098), mismas
// proporciones. pdfkit decodifica el PNG completo en memoria: el original
// suma unos 80 MB y en cPanel el proceso muere al imprimir.
const LOGO_PATH = path.join(__dirname, "logotw_blue_print.png");

const BLUE = "#26388f";
const INK = "#111111";
const VOID_RED = "#c62828";

const PAGE = { size: "LETTER", layout: "landscape" };

// --- Tamaño real (puntos PDF) ------------------------------------------------
const CM = 72 / 2.54;
/** Recuadro prepicado de la letra: 22 × 11 cm exactos, desde la esquina (0, 0). */
const FORM_WIDTH = 22 * CM;
const FORM_HEIGHT = 11 * CM;
/**
 * Aire entre el recuadro y el contenido. Arriba y a la izquierda el recuadro
 * coincide con el borde del papel, donde las impresoras no alcanzan a
 * imprimir (unos 4-5 mm): el contenido empieza después de ese margen.
 */
const FORM_PADDING = 0.5 * CM;

// --- Diseño (unidades lógicas) ----------------------------------------------
const W = 794;
/** El contenido va de X0 + 8 a X0 + W - 8. */
const CONTENT_INSET = 8;
const DESIGN_SCALE = (FORM_WIDTH - 2 * FORM_PADDING) / (W - 2 * CONTENT_INSET);
const X0 = FORM_PADDING / DESIGN_SCALE - CONTENT_INSET;
/** El contenido empieza en la cota 6 del diseño y termina en la regla del pie. */
const CONTENT_TOP = 6;
const FOOTER_RULE = 332;
/** Lo que baja el texto del pie bajo su regla: 4 de aire + una línea de 7. */
const FOOTER_TEXT_DEPTH = 4 + 7 * 0.925;
/** Escala de las posiciones verticales (no de los textos): llena el alto útil. */
const SY = ((FORM_HEIGHT - 2 * FORM_PADDING) / DESIGN_SCALE - FOOTER_TEXT_DEPTH)
  / (FOOTER_RULE - CONTENT_TOP);
const Y0 = FORM_PADDING / DESIGN_SCALE - CONTENT_TOP * SY;

/** Cota vertical del diseño → posición en la hoja (unidades lógicas). */
function Y(n) {
  return Y0 + n * SY;
}

/** Alto del diseño → alto en la hoja. */
function V(n) {
  return n * SY;
}

// Zona principal (a la derecha de las cláusulas y las firmas del aceptante).
const MX = X0 + 168;
const MR = X0 + W - CONTENT_INSET;
const MW = MR - MX;

// Columna derecha (cuenta de cargo y firma del girador).
const RX = MX + 370;
const RW = MR - RX;

const FONT = "Helvetica";
const FONT_BOLD = "Helvetica-Bold";
const FONT_ITALIC = "Helvetica-Oblique";

// En Helvetica las mayúsculas miden 0,718 del cuerpo y pdfkit las apoya en
// la `y` que recibe: el alto visible de una línea es size × CAP.
const CAP = 0.718;

function upper(value) {
  return String(value ?? "").toLocaleUpperCase("es-PE");
}

/** `y` para que un texto de `size` quede centrado en una franja. */
function middle(top, height, size) {
  return top + (height - size * CAP) / 2;
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

/**
 * Una línea con tramos de distinta fuente, uno tras otro. Si no cabe en
 * `width`, achica todos los tramos por igual.
 */
function richLine(doc, segments, x, y, width, { size = 8, minSize = 6, color = BLUE } = {}) {
  const measure = (s) => segments.reduce((sum, [font, text]) => sum + doc.font(font).fontSize(s).widthOfString(text), 0);
  let s = size;
  while (s > minSize && measure(s) > width) s -= 0.25;
  let cx = x;
  for (const [font, text] of segments) {
    doc.font(font).fontSize(s).fillColor(color).text(text, cx, y, { lineBreak: false });
    cx += doc.widthOfString(text);
  }
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

/**
 * Recuadro azul prepicado de 22 × 11 cm desde la esquina superior izquierda,
 * en puntos reales (fuera de la escala del diseño). El eje del trazo cae justo
 * sobre la medida; los lados de arriba y de la izquierda coinciden con el
 * borde del papel.
 */
function drawPerforation(doc) {
  doc.save()
    .lineWidth(0.8)
    .strokeColor(BLUE)
    .dash(2.5, { space: 2 })
    .rect(0, 0, FORM_WIDTH, FORM_HEIGHT)
    .stroke()
    .undash()
    .restore();
  doc.font(FONT).fontSize(6).fillColor("#9e9e9e")
    .text("Cortar por el recuadro prepicado · letra de 22 × 11 cm · imprimir a tamaño real (100 %)",
      FORM_PADDING, FORM_HEIGHT + 5, { lineBreak: false });
}

function drawClauses(doc) {
  const bottom = Y(322);
  verticalText(doc, X0 + 10, bottom, V(314), (x, y, width) => {
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
    [Y(8), Y(160)],
    [Y(170), Y(322)],
  ];
  const pad = V(18);
  for (const [top, bottom] of blocks) {
    const length = bottom - top;
    line(doc, X0 + 104, top + pad, X0 + 104, bottom - pad, 0.7);
    verticalText(doc, X0 + 107, bottom - pad, length - 2 * pad, (x, y, width) => {
      fitText(doc, "ACEPTANTE", x, y, width, { font: FONT_BOLD, size: 7.5, color: BLUE, align: "center" });
    });
    verticalText(doc, X0 + 124, bottom - V(4), length - V(8), (x, y, width) => {
      fitText(doc, "Nombre / Representante:", x, y, width, { size: 6.5, color: BLUE });
    });
    verticalText(doc, X0 + 136, bottom - V(4), length - V(8), (x, y, width) => {
      fitText(doc, "D.O.I.:", x, y, width, { size: 6.5, color: BLUE });
    });
  }
  line(doc, X0 + 158, Y(8), X0 + 158, Y(322), 0.6);
}

// Proporciones de logotw_blue.png (4000 × 1098): el dibujo ocupa del 12,1 %
// al 87,8 % del alto y está centrado a lo ancho; el resto es aire. Se centra
// por lo visible, no por la caja de la imagen, para que quede a la par del
// texto de la derecha.
const LOGO_RATIO = 1098 / 4000;
const LOGO_INK_TOP = 0.121;
const LOGO_INK_BOTTOM = 0.878;
const LOGO_NAVY = "#2c3e66";

/** Texto de una línea centrado en `cx`, con espaciado entre letras. */
function centeredSpaced(doc, text, cx, y, { font = FONT, size, color, spacing = 0 }) {
  doc.font(font).fontSize(size);
  const w = doc.widthOfString(text, { characterSpacing: spacing }) - spacing;
  doc.fillColor(color).text(text, cx - w / 2, y, { lineBreak: false, characterSpacing: spacing });
}

/**
 * Encabezado: logo a la izquierda (centrado sobre NUMERO y REF. DEL GIRADOR)
 * y razón social + RUC a la derecha (sobre las otras cuatro columnas). Los dos
 * bloques comparten el mismo eje horizontal, a media altura de la franja que
 * queda sobre la tabla.
 */
function drawHeader(doc) {
  const axis = Y(27);

  // --- Logo + bajada --------------------------------------------------------
  const logoW = 136;
  const logoH = logoW * LOGO_RATIO;
  const inkH = logoH * (LOGO_INK_BOTTOM - LOGO_INK_TOP);
  const tagSize = 7.5;
  const tagGap = 4;
  const leftTop = axis - (inkH + tagGap + tagSize * CAP) / 2;
  const leftCx = MX + (TABLE_COLUMNS[0].width + TABLE_COLUMNS[1].width) / 2;
  if (fs.existsSync(LOGO_PATH)) {
    doc.image(LOGO_PATH, leftCx - logoW / 2, leftTop - logoH * LOGO_INK_TOP, { width: logoW });
  }
  centeredSpaced(doc, "Power and Telecom", leftCx, leftTop + inkH + tagGap, {
    size: tagSize, color: LOGO_NAVY, spacing: 0.8,
  });

  // --- Razón social + RUC ---------------------------------------------------
  const titleX = MX + TABLE_COLUMNS[0].width + TABLE_COLUMNS[1].width;
  const titleW = MR - titleX;
  const nameSize = 12.5;
  const rucSize = 10;
  const rucGap = 6;
  const rightTop = axis - (nameSize * CAP + rucGap + rucSize * CAP) / 2;
  fitText(doc, BILL_DRAWER.name, titleX, rightTop, titleW, { font: FONT_BOLD, size: nameSize, color: BLUE, align: "center" });
  fitText(doc, `R.U.C.: ${BILL_DRAWER.ruc}`, titleX, rightTop + nameSize * CAP + rucGap, titleW, {
    size: rucSize, color: BLUE, align: "center",
  });
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
  const top = Y(52);
  const height = V(50);
  const headerH = V(14);
  const subH = V(10);
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
    fitText(doc, col.title, x + 3, middle(top, headerH, 6.8), col.width - 6, { size: 6.8, color: BLUE, align: "center" });
    if (col.date) {
      const valueTop = top + headerH + subH;
      line(doc, x, valueTop, x + col.width, valueTop, 0.6);
      fitText(doc, "DÍA / MES / AÑO", x + 3, middle(top + headerH, subH, 5.8), col.width - 6, { size: 5.8, color: BLUE, align: "center" });
      fitText(doc, values[col.key], x + 4, middle(valueTop, top + height - valueTop, 10), col.width - 8, {
        font: FONT_BOLD, size: 10, align: "center",
      });
    } else {
      const size = col.key === "amount" ? 11 : 10;
      fitText(doc, values[col.key], x + 4, middle(top + headerH, height - headerH, size), col.width - 8, {
        font: FONT_BOLD, size, align: "center",
      });
    }
    x += col.width;
  });
}

function drawOrderAndAmount(doc, bill) {
  richLine(doc, [
    [FONT, "Por esta "],
    [FONT_BOLD, "LETRA DE CAMBIO"],
    [FONT, " se servirá(n) pagar incondicionalmente a la Orden de: "],
    [FONT_BOLD, BILL_DRAWER.name],
  ], MX, Y(108), MW);

  const boxY = Y(120);
  const boxH = V(20);
  box(doc, MX, boxY, MW, boxH, 6);
  label(doc, "La cantidad de:", MX + 8, middle(boxY, boxH, 7.5));
  fitText(doc, bill.amountWords, MX + 72, middle(boxY, boxH, 10), MW - 80, { font: FONT_BOLD, size: 10, minSize: 6.5 });

  label(doc, "En el siguiente lugar de pago, o con cargo en la cuenta del Banco:", MX, Y(146));
}

/** Cinco renglones subrayados dentro de un recuadro, como en el talonario. */
const ROW_TOPS = [6, 20, 34, 48, 62];

function rowTops(y) {
  return ROW_TOPS.map((t) => y + V(t));
}

function drawAcceptor(doc, bill) {
  const x = MX;
  const y = Y(156);
  const w = 362;
  box(doc, x, y, w, V(80), 8);
  const right = x + w - 8;
  const [r1, r2, r3, r4, r5] = rowTops(y);
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
  fitText(doc, "Importe a debitar en la siguiente cuenta del BANCO que se indica", RX, Y(158), RW, {
    size: 7, color: BLUE,
  });
  const top = Y(168);
  const headerH = V(13);
  const height = V(31);
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
    fitText(doc, title, x + 2, middle(top, headerH, 6.8), width - 4, { size: 6.8, color: BLUE, align: "center" });
    fitText(doc, upper(value), x + 3, middle(top + headerH, height - headerH, 8), width - 6, { size: 8, minSize: 5.5, align: "center" });
    x += width;
  });
}

function drawGuarantor(doc, bill) {
  const x = MX;
  const y = Y(242);
  const w = 362;
  box(doc, x, y, w, V(80), 8);
  const right = x + w - 8;
  const [r1, r2, r3, r4, r5] = rowTops(y);
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

/**
 * Rótulo seguido de un renglón hasta el borde derecho; si hay `value`, se
 * imprime sobre el renglón.
 */
function labelledLine(doc, text, x, y, right, value = "") {
  label(doc, text, x, y, 7);
  const end = x + doc.font(FONT).fontSize(7).widthOfString(text) + 4;
  underline(doc, end, right, y + 8.5);
  if (value) fitText(doc, value, end + 2, y - 0.5, right - end - 4, { font: FONT_BOLD, size: 8 });
}

/**
 * Recuadro del girador, como en el talonario: la razón social la pone el
 * sello de la empresa (cae en el espacio libre del medio), y la firma, el
 * nombre y el D.O.I. del representante legal van a mano en sus renglones.
 */
function drawDrawerSignature(doc) {
  const y = Y(206);
  const height = Y(322) - y;
  const left = RX + 8;
  const right = RX + RW - 8;
  box(doc, RX, y, RW, height, 8);

  labelledLine(doc, "Nombre o Razón Social del Girador", left, y + V(10), right);

  // Los renglones del representante se apoyan en el borde inferior.
  const repY = y + height - 37;
  const signY = repY - 21;
  line(doc, left, signY, right, signY, 0.6);
  fitText(doc, "Firma", left, signY + 3, right - left, { size: 6.5, color: BLUE, align: "center" });

  label(doc, "Nombre del Representante Legal:", left, repY, 7);
  underline(doc, left, right, repY + 18);
  labelledLine(doc, "D.O.I.", left, repY + 22, right);
}

function drawFooterRule(doc) {
  line(doc, X0 + CONTENT_INSET, Y(332), X0 + W - CONTENT_INSET, Y(332), 0.9);
  doc.font(FONT_ITALIC).fontSize(7).fillColor(BLUE)
    .text("No escribir ni firmar debajo de esta línea", X0 + 40, Y(332) + 4, { lineBreak: false });
}

function drawVoidStamp(doc) {
  const cx = X0 + W / 2;
  const cy = Y(176);
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
  drawPerforation(doc);
  doc.save();
  doc.scale(DESIGN_SCALE);
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
  doc.restore();
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
    // Que el visor imprima a tamaño real y no "ajuste a la página", y que la
    // impresora tome la bandeja del tamaño de la página si puede elegir.
    doc._root.data.ViewerPreferences = doc.ref({ PrintScaling: "None", PickTrayByPDFSize: true });
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

module.exports = { renderBillsPdf, FORM_WIDTH, FORM_HEIGHT };
