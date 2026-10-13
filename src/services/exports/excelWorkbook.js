const ExcelJS = require("exceljs");

/**
 * Exportación e importación de Excel para la intranet.
 *
 * Primer exportador del proyecto: vive fuera de vacaciones a propósito, para
 * que el siguiente módulo que necesite "descargar en Excel" lo reutilice en
 * vez de inventar el suyo.
 *
 * Se usa exceljs (ya en package.json) y no la librería `xlsx`: exceljs escribe
 * formatos, anchos y cabeceras fijas, y está mantenida.
 */

// Azul corporativo de la intranet en el formato ARGB que pide exceljs.
const HEADER_FILL = "FF14427C";
const HEADER_FONT = "FFFFFFFF";

/**
 * Crea un libro con una hoja por bloque.
 *
 * @param {Array<{name: string, columns: Array<{header,key,width,numFmt}>, rows: object[], note?: string}>} sheets
 * @returns {Promise<Buffer>}
 */
async function buildWorkbook(sheets, { creator = "Intranet Transworld" } = {}) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = creator;
  workbook.created = new Date();

  for (const sheet of sheets) {
    const ws = workbook.addWorksheet(sheet.name.slice(0, 31));
    ws.columns = sheet.columns.map((c) => ({
      header: c.header,
      key: c.key,
      width: c.width || Math.max(12, String(c.header || "").length + 4),
      style: c.numFmt ? { numFmt: c.numFmt } : undefined,
    }));

    const headerRow = ws.getRow(1);
    headerRow.font = { bold: true, color: { argb: HEADER_FONT } };
    headerRow.fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: HEADER_FILL },
    };
    headerRow.alignment = { vertical: "middle" };
    headerRow.height = 22;

    for (const row of sheet.rows || []) {
      ws.addRow(row);
    }

    // La cabecera queda fija al desplazarse y con autofiltro, que es lo que
    // RR.HH. espera de una planilla.
    ws.views = [{ state: "frozen", ySplit: 1 }];
    if ((sheet.rows || []).length > 0) {
      ws.autoFilter = {
        from: { row: 1, column: 1 },
        to: { row: 1, column: sheet.columns.length },
      };
    }

    if (sheet.note) {
      const noteRow = ws.addRow({});
      noteRow.getCell(1).value = sheet.note;
      noteRow.getCell(1).font = { italic: true, size: 9 };
    }
  }

  return workbook.xlsx.writeBuffer().then((buf) => Buffer.from(buf));
}

/** Nombre de archivo seguro y fechado: "vacaciones-resumen-2026-09-22.xlsx". */
function excelFileName(base) {
  const stamp = new Date().toISOString().slice(0, 10);
  const safe = String(base)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9-_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `${safe}-${stamp}.xlsx`;
}

/** Cabeceras para que el navegador descargue el libro. */
function sendWorkbook(res, buffer, fileName) {
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="${fileName}"`,
  );
  res.setHeader("Content-Length", buffer.length);
  return res.end(buffer);
}

/**
 * Lee la primera hoja de un .xlsx y devuelve un objeto por fila, usando la
 * primera fila como cabecera.
 *
 * Las claves se normalizan (sin tildes, sin espacios, minúsculas) para que
 * "Días usados", "dias_usados" y "DIAS USADOS" lleguen igual al validador:
 * el Excel lo llena una persona, no un sistema.
 *
 * @returns {{ ok: boolean, rows?: Array<{rowNumber:number, data:object}>, headers?: string[], error?: string }}
 */
async function readSheetRows(buffer, { maxRows = 5000 } = {}) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    return { ok: false, error: "unreadable" };
  }

  const ws = workbook.worksheets[0];
  if (!ws) return { ok: false, error: "empty" };

  const headerRow = ws.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, colNumber) => {
    headers[colNumber] = normalizeHeader(cellText(cell));
  });

  if (!headers.some(Boolean)) return { ok: false, error: "empty" };

  const rows = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1 || rows.length >= maxRows) return;
    const data = {};
    let hasValue = false;
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      const key = headers[colNumber];
      if (!key) return;
      const value = cellValue(cell);
      data[key] = value;
      if (value !== null && value !== "") hasValue = true;
    });
    if (hasValue) rows.push({ rowNumber, data });
  });

  return { ok: true, rows, headers: headers.filter(Boolean) };
}

function normalizeHeader(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

function cellText(cell) {
  const value = cellValue(cell);
  return value == null ? "" : String(value);
}

/** Valor plano de una celda: exceljs devuelve objetos para fórmulas y links. */
function cellValue(cell) {
  const raw = cell?.value;
  if (raw == null) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw === "object") {
    if ("result" in raw) return raw.result ?? null;
    if ("text" in raw) return raw.text ?? null;
    if ("richText" in raw) {
      return raw.richText.map((part) => part.text).join("");
    }
    return null;
  }
  if (typeof raw === "string") return raw.trim();
  return raw;
}

module.exports = {
  buildWorkbook,
  excelFileName,
  sendWorkbook,
  readSheetRows,
  normalizeHeader,
  cellValue,
};
