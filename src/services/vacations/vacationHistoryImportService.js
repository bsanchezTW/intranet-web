const db = require("../../db");
const balanceService = require("./vacationBalanceService");
const historyService = require("./vacationHistoryService");
const { getCurrentCountry, getDocumentConfig } = require("../../config/country");
const { buildWorkbook, readSheetRows } = require("../exports/excelWorkbook");
const { VACATION_MESSAGES } = require("../../constants/vacationMessages");
const {
  HISTORY_ORIGIN,
  MONTH_NAMES,
  parseMonth,
} = require("../../constants/vacationHistory");
const { toStorageNationalId } = require("../../utils/nationalId");
const { toDateOnly, todayInCountry } = require("../../utils/vacationDateUtils");

/**
 * Importación del historial de vacaciones desde el Excel de RR.HH.
 *
 * El flujo es siempre: plantilla → archivo → validación → vista previa →
 * confirmación. Nunca se inserta nada al subir el archivo: RR.HH. ve cuántas
 * filas están bien, cuáles no y por qué, y recién entonces confirma.
 *
 * La importación queda agrupada en un lote (vacation_history_imports) para
 * poder revertirla completa si se cargó el archivo equivocado.
 */

/** Columnas de la plantilla. `key` es la cabecera ya normalizada. */
const TEMPLATE_COLUMNS = [
  { key: "documento", header: "documento", width: 16, required: true },
  { key: "nombre", header: "nombre", width: 30 },
  { key: "anio", header: "anio", width: 10, required: true },
  { key: "mes", header: "mes", width: 14 },
  { key: "dias", header: "dias", width: 10, required: true },
  { key: "desde", header: "desde", width: 14 },
  { key: "hasta", header: "hasta", width: 14 },
  { key: "observacion", header: "observacion", width: 36 },
];

/** Sinónimos admitidos por columna: el Excel lo llena una persona. */
const COLUMN_ALIASES = {
  documento: ["documento", "dni", "employee_identifier", "identificador", "rut", "documento_identidad"],
  nombre: ["nombre", "employee_name", "trabajador", "colaborador", "nombre_completo"],
  anio: ["anio", "ano", "year", "periodo", "ejercicio"],
  mes: ["mes", "month"],
  dias: ["dias", "dias_usados", "days_used", "dias_tomados", "cantidad_de_dias", "cantidad"],
  desde: ["desde", "start_date", "fecha_inicio", "inicio"],
  hasta: ["hasta", "end_date", "fecha_termino", "fecha_fin", "termino"],
  observacion: ["observacion", "observaciones", "observation", "comentario", "detalle"],
};

function pick(data, column) {
  for (const alias of COLUMN_ALIASES[column] || [column]) {
    if (data[alias] != null && data[alias] !== "") return data[alias];
  }
  return null;
}

// ===========================================================================
// Plantilla
// ===========================================================================

/** Genera la plantilla .xlsx que RR.HH. descarga y rellena. */
async function buildTemplate() {
  const docLabel = getDocumentConfig().label;
  const year = Number((todayInCountry() || "").slice(0, 4)) || 2026;

  return buildWorkbook([
    {
      name: "Historial",
      columns: TEMPLATE_COLUMNS.map((c) => ({
        header: c.header,
        key: c.key,
        width: c.width,
      })),
      rows: [
        {
          documento: "00000001",
          nombre: "Ejemplo — borrar esta fila",
          anio: year - 2,
          mes: "Marzo",
          dias: 15,
          desde: "",
          hasta: "",
          observacion: "Vacaciones registradas en Excel",
        },
        {
          documento: "00000001",
          nombre: "Ejemplo — borrar esta fila",
          anio: year - 2,
          mes: "Octubre",
          dias: 10,
          desde: "",
          hasta: "",
          observacion: "",
        },
      ],
    },
    {
      name: "Instrucciones",
      columns: [
        { header: "Columna", key: "columna", width: 16 },
        { header: "Obligatoria", key: "obligatoria", width: 14 },
        { header: "Qué poner", key: "detalle", width: 80 },
      ],
      rows: [
        {
          columna: "documento",
          obligatoria: "Sí",
          detalle: `${docLabel} del trabajador, tal como está en su ficha de la intranet. Es lo que se usa para identificarlo; el nombre es solo referencia.`,
        },
        {
          columna: "nombre",
          obligatoria: "No",
          detalle: "Nombre del trabajador. Sirve para revisar la vista previa; no se usa para buscar.",
        },
        { columna: "anio", obligatoria: "Sí", detalle: "Año en que se tomó las vacaciones. Ej: 2019." },
        {
          columna: "mes",
          obligatoria: "Recomendada",
          detalle: "Mes en que salió de vacaciones. Se acepta el nombre (Marzo, Setiembre) o el número (3, 9). Si no lo tienes, deja la celda vacía y completa desde/hasta.",
        },
        { columna: "dias", obligatoria: "Sí", detalle: "Cantidad de días calendario que se tomó. Mayor que 0." },
        {
          columna: "desde / hasta",
          obligatoria: "No",
          detalle: "Solo si conoces las fechas exactas. Si las pones, tienen que cuadrar con la cantidad de días. Si no las tienes, déjalas vacías: la intranet no inventa fechas.",
        },
        { columna: "observacion", obligatoria: "No", detalle: "Nota interna de RR.HH. El colaborador no la ve." },
        { columna: "", obligatoria: "", detalle: "" },
        {
          columna: "Una fila por salida",
          obligatoria: "",
          detalle: "Si una persona salió tres veces, van tres filas. No sumes los días en una sola fila: el detalle es lo que permite revisar y corregir después.",
        },
      ],
    },
  ]);
}

// ===========================================================================
// Validación
// ===========================================================================

/** Normaliza el documento del Excel (Excel se come los ceros a la izquierda). */
function normalizeDocument(raw) {
  if (raw == null) return null;
  let clean = String(raw).trim().replace(/[.\s-]/g, "");
  if (!clean) return null;
  const cfg = getDocumentConfig();
  if (cfg.kind === "dni" && /^\d{1,8}$/.test(clean)) {
    clean = clean.padStart(8, "0");
  }
  return toStorageNationalId(clean) || clean.toUpperCase();
}

/** Busca por documento a los trabajadores que aparecen en el archivo. */
async function resolveEmployees(documents) {
  if (documents.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, email, national_id, hire_date
       FROM users
      WHERE national_id = ANY($1::varchar[])`,
    [documents],
  );
  const byDocument = new Map();
  for (const row of rows) {
    byDocument.set(normalizeDocument(row.national_id), row);
  }
  return byDocument;
}

/** Fecha de una celda que puede venir como Date o como texto. */
function cellDate(value) {
  if (value == null || value === "") return null;
  if (value instanceof Date) return toDateOnly(value);
  const raw = String(value).trim();
  const iso = toDateOnly(raw);
  if (iso) return iso;
  const dmy = raw.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return null;
}

/**
 * Valida el archivo completo sin tocar la base.
 *
 * @returns {{ ok: boolean, error?: string, preview?: object }}
 */
async function validateFile(buffer, { fileName = null, cutoffDate = null } = {}) {
  const parsed = await readSheetRows(buffer);
  if (!parsed.ok) {
    return {
      ok: false,
      error:
        parsed.error === "empty"
          ? VACATION_MESSAGES.importEmpty
          : VACATION_MESSAGES.importBadFormat,
    };
  }
  if (parsed.rows.length === 0) {
    return { ok: false, error: VACATION_MESSAGES.importEmpty };
  }

  // Resolución de trabajadores en un solo viaje a la base.
  const documents = [
    ...new Set(
      parsed.rows.map((r) => normalizeDocument(pick(r.data, "documento"))).filter(Boolean),
    ),
  ];
  const employees = await resolveEmployees(documents);
  const existingKeys = await historyService.existingKeysFor(
    [...employees.values()].map((e) => e.id),
  );

  const valid = [];
  const errors = [];
  const warnings = [];
  const seenInFile = new Set();
  const referenceYear = Number((todayInCountry() || "").slice(0, 4)) || null;

  for (const { rowNumber, data } of parsed.rows) {
    const rawDocument = pick(data, "documento");
    const document = normalizeDocument(rawDocument);
    const displayName = pick(data, "nombre") || "";
    const rowRef = { row: rowNumber, document: rawDocument ? String(rawDocument) : "", name: String(displayName) };

    if (!document) {
      errors.push({ ...rowRef, error: VACATION_MESSAGES.rowEmployeeIdMissing });
      continue;
    }

    const employee = employees.get(document);
    if (!employee) {
      errors.push({ ...rowRef, error: VACATION_MESSAGES.rowEmployeeNotFound });
      continue;
    }
    if (!employee.hire_date) {
      errors.push({ ...rowRef, error: VACATION_MESSAGES.rowNoHireDate });
      continue;
    }

    const normalized = historyService.normalizeHistoryInput(
      {
        periodYear: pick(data, "anio"),
        periodMonth: pick(data, "mes"),
        startDate: cellDate(pick(data, "desde")),
        endDate: cellDate(pick(data, "hasta")),
        daysUsed: pick(data, "dias"),
        observation: pick(data, "observacion"),
        origin: HISTORY_ORIGIN.IMPORTED,
        source: fileName,
      },
      { hireDate: employee.hire_date, cutoffDate, referenceYear },
    );

    if (!normalized.valid) {
      errors.push({ ...rowRef, error: normalized.errors.join(" ") });
      continue;
    }

    const key = historyService.duplicateKey({
      userId: employee.id,
      ...normalized.value,
    });

    if (seenInFile.has(key)) {
      warnings.push({ ...rowRef, warning: VACATION_MESSAGES.rowDuplicateInFile });
    } else if (existingKeys.has(key)) {
      warnings.push({ ...rowRef, warning: VACATION_MESSAGES.rowDuplicateInDb });
    }
    seenInFile.add(key);

    for (const w of normalized.warnings) {
      warnings.push({ ...rowRef, warning: w });
    }

    valid.push({
      row: rowNumber,
      userId: employee.id,
      employeeName:
        [employee.first_name, employee.last_name].filter(Boolean).join(" ") ||
        String(displayName),
      document,
      duplicate: existingKeys.has(key),
      value: normalized.value,
    });
  }

  const totalDays = valid.reduce((sum, r) => sum + r.value.daysUsed, 0);
  const employeeIds = [...new Set(valid.map((r) => r.userId))];

  return {
    ok: true,
    preview: {
      fileName,
      cutoffDate: toDateOnly(cutoffDate),
      totalRows: parsed.rows.length,
      validRows: valid.length,
      errorRows: errors.length,
      warningRows: warnings.length,
      duplicateRows: valid.filter((r) => r.duplicate).length,
      employeeCount: employeeIds.length,
      totalDays: Math.round(totalDays * 100) / 100,
      valid,
      errors,
      warnings,
      createdAt: Date.now(),
    },
  };
}

// ===========================================================================
// Confirmación y reverso
// ===========================================================================

/**
 * Inserta las filas válidas de una vista previa ya revisada.
 * Todo o nada: una transacción para el lote completo.
 */
async function confirmImport({ preview, actorId, skipDuplicates = true }) {
  const rows = (preview?.valid || []).filter(
    (r) => !(skipDuplicates && r.duplicate),
  );
  if (rows.length === 0) {
    return { ok: false, error: VACATION_MESSAGES.importNoValidRows };
  }

  const country = getCurrentCountry();
  const client = await db.getClient();
  let batchId = null;
  try {
    await client.query("BEGIN");

    const { rows: batchRows } = await client.query(
      `INSERT INTO vacation_history_imports
         (country_code, file_name, cutoff_date, total_rows, valid_rows,
          imported_rows, error_rows, status, summary, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'confirmed',$8::jsonb,$9)
       RETURNING id`,
      [
        country,
        preview.fileName,
        preview.cutoffDate,
        preview.totalRows,
        preview.validRows,
        rows.length,
        preview.errorRows,
        JSON.stringify({
          errors: preview.errors,
          warnings: preview.warnings,
          skippedDuplicates: preview.validRows - rows.length,
        }),
        actorId || null,
      ],
    );
    batchId = batchRows[0].id;

    for (const row of rows) {
      const employee = { national_id: row.document };
      const [firstName, ...rest] = String(row.employeeName || "").split(" ");
      employee.first_name = firstName || null;
      employee.last_name = rest.join(" ") || null;

      const inserted = await historyService.insertHistoryRow(client, {
        userId: row.userId,
        employee,
        value: { ...row.value, cutoffDate: preview.cutoffDate },
        actorId,
        importBatchId: batchId,
      });
      await historyService.writeAudit(client, {
        historyId: inserted.id,
        userId: row.userId,
        action: "IMPORT",
        actorId,
        oldValue: null,
        newValue: historyService.auditSnapshot(inserted),
        source: preview.fileName,
      });
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  // Una sola reimputación por colaborador, no una por fila.
  const userIds = [...new Set(rows.map((r) => r.userId))];
  for (const userId of userIds) {
    await balanceService.reimputeHistoricalDays(userId);
  }

  return {
    ok: true,
    batchId,
    imported: rows.length,
    skipped: preview.validRows - rows.length,
    employees: userIds.length,
  };
}

/** Deshace un lote completo (borrado lógico) y recalcula los saldos. */
async function revertImport({ batchId, actorId }) {
  const { rows: batchRows } = await db.query(
    `SELECT * FROM vacation_history_imports WHERE id = $1 AND country_code = $2`,
    [batchId, getCurrentCountry()],
  );
  const batch = batchRows[0];
  if (!batch) return { ok: false, error: VACATION_MESSAGES.importBatchNotFound };
  if (batch.status === "reverted") {
    return { ok: false, error: VACATION_MESSAGES.importAlreadyReverted };
  }

  const client = await db.getClient();
  let affected = [];
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE vacation_history
          SET deleted_at = NOW(), deleted_by = $1, updated_at = NOW()
        WHERE import_batch_id = $2 AND deleted_at IS NULL
        RETURNING id, user_id`,
      [actorId || null, batchId],
    );
    affected = rows;

    for (const row of rows) {
      await historyService.writeAudit(client, {
        historyId: row.id,
        userId: row.user_id,
        action: "REVERT",
        actorId,
        oldValue: null,
        newValue: { import_batch_id: batchId },
        source: batch.file_name,
      });
    }

    await client.query(
      `UPDATE vacation_history_imports
          SET status = 'reverted', reverted_by = $1, reverted_at = NOW()
        WHERE id = $2`,
      [actorId || null, batchId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  for (const userId of [...new Set(affected.map((r) => r.user_id).filter(Boolean))]) {
    await balanceService.reimputeHistoricalDays(userId);
  }

  return { ok: true, reverted: affected.length };
}

/** Lotes importados, para la pantalla de importación. */
async function listImports(limit = 20) {
  const { rows } = await db.query(
    `SELECT i.*, u.first_name, u.last_name
       FROM vacation_history_imports i
       LEFT JOIN users u ON u.id = i.created_by
      WHERE i.country_code = $1
      ORDER BY i.created_at DESC
      LIMIT $2`,
    [getCurrentCountry(), limit],
  );
  return rows;
}

module.exports = {
  TEMPLATE_COLUMNS,
  MONTH_NAMES,
  parseMonth,
  buildTemplate,
  normalizeDocument,
  cellDate,
  validateFile,
  confirmImport,
  revertImport,
  listImports,
};
