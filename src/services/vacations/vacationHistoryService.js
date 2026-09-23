const db = require("../../db");
const balanceService = require("./vacationBalanceService");
const { getCurrentCountry } = require("../../config/country");
const { getStrategy, resolveCountryForUser } = require("./VacationEngine");
const { periodShortLabel } = require("../../utils/schemaMappers");
const { VACATION_MESSAGES } = require("../../constants/vacationMessages");
const {
  HISTORY_AUDIT_ACTION,
  HISTORY_ORIGIN,
  ALL_HISTORY_ORIGINS,
  MIN_HISTORY_YEAR,
  parseMonth,
} = require("../../constants/vacationHistory");
const {
  toDateOnly,
  countCalendarDays,
  todayInCountry,
} = require("../../utils/vacationDateUtils");

/**
 * Historial de vacaciones anteriores a la intranet.
 *
 * Cada fila es un hecho: "en marzo de 2019 se tomó 15 días". No es una
 * solicitud y no tiene estados. El saldo NO se guarda como un total: sale de
 * imputar estas filas a los períodos de devengo (ver
 * vacationBalanceService.reimputeHistoricalDays), de forma que se pueda
 * corregir un registro y recalcular todo sin perder trazabilidad.
 *
 * Fechas: se aceptan registros sin fechas exactas, que es como llega el Excel
 * de RR.HH. Nunca se inventa un rango para rellenar el esquema.
 */

const SELECT_HISTORY = `
  SELECT h.*,
         COALESCE(u.first_name, h.employee_first_name) AS first_name,
         COALESCE(u.last_name,  h.employee_last_name)  AS last_name,
         COALESCE(u.national_id, h.employee_national_id) AS national_id,
         (h.user_id IS NULL) AS employee_deleted,
         cb.first_name AS created_by_first_name,
         cb.last_name  AS created_by_last_name
    FROM vacation_history h
    LEFT JOIN users u  ON u.id = h.user_id
    LEFT JOIN users cb ON cb.id = h.created_by`;

// ===========================================================================
// Validación (pura: sin base de datos, para poder probarla sola)
// ===========================================================================

/** «2024-03» → { year: 2024, month: 3 }; cualquier otra cosa → null. */
function parseYearMonth(value) {
  const m = String(value ?? "").trim().match(/^(\d{4})-(\d{1,2})$/);
  if (!m) return null;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return null;
  return { year: Number(m[1]), month };
}

/**
 * Normaliza y valida los datos de un registro histórico.
 *
 * @returns {{ valid: boolean, errors: string[], warnings: string[], value?: object }}
 */
function normalizeHistoryInput(input, context = {}) {
  const errors = [];
  const warnings = [];
  const { hireDate = null, cutoffDate = null, referenceYear = null } = context;
  // Hasta qué mes se puede registrar historial: el en curso. Lo que viene
  // después se pide como solicitud.
  const referenceDate =
    toDateOnly(context.referenceDate) ||
    (referenceYear ? `${referenceYear}-12-31` : todayInCountry());

  // «2024-03», como lo entrega <input type="month">, trae año y mes juntos.
  const yearMonth = parseYearMonth(input.yearMonth ?? input.year_month);
  const year = yearMonth
    ? yearMonth.year
    : Number.parseInt(input.periodYear ?? input.period_year, 10);
  const month = yearMonth
    ? yearMonth.month
    : parseMonth(input.periodMonth ?? input.period_month);
  const startDate = toDateOnly(input.startDate ?? input.start_date);
  const endDate = toDateOnly(input.endDate ?? input.end_date);
  const days = Number(input.daysUsed ?? input.days_used);
  const maxYear = Number((referenceDate || "").slice(0, 4)) || year;

  if (!Number.isInteger(year)) {
    errors.push(VACATION_MESSAGES.historyNeedYear);
  } else if (year < MIN_HISTORY_YEAR || year > maxYear) {
    errors.push(VACATION_MESSAGES.historyInvalidYear(MIN_HISTORY_YEAR));
  }

  const rawMonth = yearMonth ? yearMonth.month : input.periodMonth ?? input.period_month;
  if (rawMonth != null && String(rawMonth).trim() !== "" && month == null) {
    errors.push(VACATION_MESSAGES.historyInvalidMonth);
  }

  if (
    Number.isInteger(year) &&
    month != null &&
    `${year}-${String(month).padStart(2, "0")}` > String(referenceDate).slice(0, 7)
  ) {
    errors.push(VACATION_MESSAGES.historyFutureMonth);
  }

  if (!Number.isFinite(days) || days <= 0) {
    errors.push(VACATION_MESSAGES.historyNeedDays);
  }

  if (month == null && !startDate) {
    errors.push(VACATION_MESSAGES.historyNeedMonthOrDates);
  }

  if (startDate && endDate && endDate < startDate) {
    errors.push(VACATION_MESSAGES.historyEndBeforeStart);
  }

  // Con fechas exactas, los días declarados tienen que cuadrar con el rango:
  // si no cuadran es un error de carga, no una regla de negocio que adivinar.
  if (startDate && endDate && endDate >= startDate && Number.isFinite(days)) {
    const dateDays = countCalendarDays(startDate, endDate);
    if (Math.abs(dateDays - days) > 0.001) {
      errors.push(VACATION_MESSAGES.historyDaysMismatch(dateDays, days));
    }
  }

  const hire = toDateOnly(hireDate);
  if (hire && Number.isInteger(year)) {
    const periodRef = `${year}-${String(month || 12).padStart(2, "0")}-28`;
    if (periodRef < hire.slice(0, 10)) {
      errors.push(VACATION_MESSAGES.historyBeforeHire);
    }
  }

  const cutoff = toDateOnly(cutoffDate);
  if (cutoff && Number.isInteger(year)) {
    const periodStart = `${year}-${String(month || 1).padStart(2, "0")}-01`;
    if (periodStart > cutoff) {
      warnings.push(VACATION_MESSAGES.historyAfterCutoff(cutoff));
    }
  }

  const origin = ALL_HISTORY_ORIGINS.includes(input.origin)
    ? input.origin
    : HISTORY_ORIGIN.MANUAL;

  if (errors.length > 0) return { valid: false, errors, warnings };

  return {
    valid: true,
    errors,
    warnings,
    value: {
      periodYear: year,
      periodMonth: month,
      startDate,
      endDate,
      daysUsed: Math.round(days * 100) / 100,
      origin,
      source: input.source ? String(input.source).trim().slice(0, 255) : null,
      observation: input.observation ? String(input.observation).trim() : null,
      cutoffDate: cutoff,
    },
  };
}

/**
 * Clave lógica de duplicado: mismo trabajador, mismo período, misma cantidad
 * y mismas fechas. Nunca se borra nada en silencio: se avisa y decide RR.HH.
 */
function duplicateKey({ userId, periodYear, periodMonth, daysUsed, startDate, endDate }) {
  return [
    String(userId),
    String(periodYear),
    periodMonth == null ? "-" : String(periodMonth),
    String(Math.round(Number(daysUsed) * 100) / 100),
    toDateOnly(startDate) || "-",
    toDateOnly(endDate) || "-",
  ].join("|");
}

// ===========================================================================
// Lectura
// ===========================================================================

async function listForUser(userId, { includeDeleted = false } = {}) {
  const { rows } = await db.query(
    `${SELECT_HISTORY}
      WHERE h.user_id = $1
        ${includeDeleted ? "" : "AND h.deleted_at IS NULL"}
      ORDER BY h.period_year ASC, COALESCE(h.period_month, 0) ASC, h.id ASC`,
    [userId],
  );
  return rows;
}

async function getById(id) {
  const { rows } = await db.query(`${SELECT_HISTORY} WHERE h.id = $1`, [id]);
  return rows[0] || null;
}

/** Totales del historial de un colaborador (para la ficha y los reportes). */
async function getUserTotals(userId) {
  const { rows } = await db.query(
    `SELECT COALESCE(SUM(days_used), 0) AS days, COUNT(*) AS records
       FROM vacation_history
      WHERE user_id = $1 AND deleted_at IS NULL`,
    [userId],
  );
  const row = rows[0] || {};
  return {
    days: Math.round(Number(row.days || 0) * 100) / 100,
    records: Number(row.records || 0),
  };
}

/** Claves lógicas ya existentes, para detectar duplicados al importar. */
async function existingKeysFor(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return new Set();
  const { rows } = await db.query(
    `SELECT user_id, period_year, period_month, days_used, start_date, end_date
       FROM vacation_history
      WHERE user_id = ANY($1::int[]) AND deleted_at IS NULL`,
    [userIds],
  );
  return new Set(
    rows.map((r) =>
      duplicateKey({
        userId: r.user_id,
        periodYear: r.period_year,
        periodMonth: r.period_month,
        daysUsed: r.days_used,
        startDate: r.start_date,
        endDate: r.end_date,
      }),
    ),
  );
}

// ===========================================================================
// Escritura
// ===========================================================================

/** Instantánea auditable de una fila (lo que se guarda en old/new_value). */
function auditSnapshot(row) {
  if (!row) return null;
  return {
    id: row.id,
    user_id: row.user_id,
    period_year: row.period_year,
    period_month: row.period_month,
    start_date: toDateOnly(row.start_date),
    end_date: toDateOnly(row.end_date),
    days_used: Number(row.days_used),
    origin: row.origin,
    source: row.source,
    observation: row.observation,
    cutoff_date: toDateOnly(row.cutoff_date),
  };
}

async function writeAudit(client, { historyId, userId, action, actorId, oldValue, newValue, source }) {
  await client.query(
    `INSERT INTO vacation_history_audit
       (vacation_history_id, user_id, action, actor_user_id, old_value, new_value, source)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      historyId || null,
      userId || null,
      action,
      actorId || null,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null,
      source || null,
    ],
  );
}

/**
 * Inserta una fila de historial dentro de una transacción ya abierta.
 * No reimputa: quien abre la transacción decide cuándo hacerlo (al importar
 * conviene una sola reimputación por colaborador, no una por fila).
 */
async function insertHistoryRow(client, { userId, employee, value, actorId, importBatchId = null }) {
  const country = getCurrentCountry();
  const { rows } = await client.query(
    `INSERT INTO vacation_history
       (user_id, country_code, period_year, period_month, start_date, end_date,
        days_used, origin, source, observation, cutoff_date, import_batch_id,
        employee_first_name, employee_last_name, employee_national_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     RETURNING *`,
    [
      userId,
      country,
      value.periodYear,
      value.periodMonth,
      value.startDate,
      value.endDate,
      value.daysUsed,
      value.origin,
      value.source,
      value.observation,
      value.cutoffDate,
      importBatchId,
      employee?.first_name || null,
      employee?.last_name || null,
      employee?.national_id || null,
      actorId || null,
    ],
  );
  return rows[0];
}

// ===========================================================================
// Carga manual por lotes
// ===========================================================================

const BATCH_SOURCE = "Carga manual";
const MAX_BATCH_ROWS = 200;

/** Fila del formulario de carga → entrada de normalizeHistoryInput. */
function batchRowInput(row = {}) {
  return {
    yearMonth: row.month,
    startDate: row.start || null,
    endDate: row.end || null,
    daysUsed: row.days,
    observation: row.observation,
    origin: HISTORY_ORIGIN.MANUAL,
    source: BATCH_SOURCE,
  };
}

/** Sin mes, días, fechas ni observación es una fila vacía: se ignora. */
function isBlankBatchRow(row = {}) {
  return ["month", "days", "start", "end", "observation"].every(
    (key) => row[key] == null || String(row[key]).trim() === "",
  );
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Valida un lote y calcula cómo quedaría el saldo, sin escribir nada.
 *
 * Función pura: recibe todo lo que necesita. Los duplicados son avisos y no
 * errores porque dos salidas iguales en el mismo mes existen de verdad (en el
 * Excel de RR.HH. hay «08-2024, 7 días» dos veces para la misma persona).
 *
 * `before`/`after` resumen el saldo con el historial actual y con el lote.
 */
function previewBatch({
  rows,
  employee,
  existingHistory,
  periods,
  approvedBlocks = new Map(),
  strategy,
  country,
  cutoffDate = null,
  referenceDate = null,
  periodLabels = new Map(),
}) {
  const today = toDateOnly(referenceDate) || todayInCountry();
  const existingKeys = new Set(
    existingHistory.map((h) =>
      duplicateKey({
        userId: employee.id,
        periodYear: h.period_year,
        periodMonth: h.period_month,
        daysUsed: h.days_used,
        startDate: h.start_date,
        endDate: h.end_date,
      }),
    ),
  );
  const seenInBatch = new Set();

  const checked = (rows || []).map((row, index) => {
    if (isBlankBatchRow(row)) return { index, blank: true, errors: [], warnings: [] };
    const normalized = normalizeHistoryInput(batchRowInput(row), {
      hireDate: employee.hire_date,
      cutoffDate,
      referenceDate: today,
    });
    const warnings = [...normalized.warnings];
    if (normalized.valid) {
      const key = duplicateKey({ userId: employee.id, ...normalized.value });
      if (existingKeys.has(key)) warnings.push(VACATION_MESSAGES.historyDuplicateWarning);
      else if (seenInBatch.has(key)) warnings.push(VACATION_MESSAGES.historyDuplicateInBatch);
      seenInBatch.add(key);
    }
    return {
      index,
      blank: false,
      errors: normalized.errors,
      warnings,
      value: normalized.valid ? normalized.value : null,
    };
  });

  const entries = checked.filter((r) => !r.blank);
  const existingRecords = existingHistory.map((h) => ({
    id: h.id,
    period_year: h.period_year,
    period_month: h.period_month,
    days_used: h.days_used,
  }));
  const newRecords = entries
    .filter((r) => r.value)
    .map((r) => ({
      index: r.index,
      period_year: r.value.periodYear,
      period_month: r.value.periodMonth,
      days_used: r.value.daysUsed,
    }));

  const simulate = (records) =>
    balanceService.simulateHistoryImputation({ periods, records, strategy, approvedBlocks });
  const summarize = (simulation) => {
    const s = balanceService.summarizePeriods({
      periods: simulation.periods,
      country,
      referenceDate: today,
    });
    return {
      availableDays: s.availableDays,
      historicalUsedDays: s.historicalUsedDays,
      unimputedDays: simulation.overflow,
    };
  };

  const before = simulate(existingRecords);
  const after = simulate([...existingRecords, ...newRecords]);
  const imputedByIndex = new Map(
    after.results
      .filter((r) => r.record.index != null)
      .map((r) => [r.record.index, r]),
  );

  return {
    rows: checked.map((r) => {
      const imputed = imputedByIndex.get(r.index);
      return {
        index: r.index,
        blank: r.blank,
        errors: r.errors,
        warnings: r.warnings,
        allocations: imputed
          ? imputed.allocations.map((a) => ({
              label: periodLabels.get(a.periodId) || "—",
              days: a.days,
            }))
          : [],
        unallocated: imputed ? imputed.overflow : 0,
      };
    }),
    entries: entries.length,
    errorCount: entries.filter((r) => r.errors.length > 0).length,
    valid: entries.length > 0 && entries.every((r) => r.errors.length === 0),
    addedDays: round2(newRecords.reduce((sum, r) => sum + Number(r.days_used), 0)),
    before: summarize(before),
    after: summarize(after),
    values: entries.filter((r) => r.value).map((r) => r.value),
  };
}

/** Junta de la base lo que previewBatch necesita para un colaborador. */
async function loadBatchContext(userId, { cutoffDate = null } = {}) {
  const employee = await balanceService.getUserVacationProfile(userId);
  if (!employee) return null;
  const country = resolveCountryForUser(employee);
  const [existingHistory, periods, approvedBlocks] = await Promise.all([
    listForUser(userId),
    balanceService.listPeriods(userId),
    balanceService.approvedBlocksByPeriod(db, userId),
  ]);
  return {
    employee,
    existingHistory,
    periods,
    approvedBlocks,
    strategy: getStrategy(country),
    country,
    cutoffDate,
    periodLabels: new Map(periods.map((p) => [p.id, periodShortLabel(p)])),
  };
}

async function previewHistoryBatch({ userId, rows, cutoffDate = null }) {
  if (!Array.isArray(rows) || rows.length > MAX_BATCH_ROWS) {
    return { ok: false, errors: [VACATION_MESSAGES.historyBatchTooLarge(MAX_BATCH_ROWS)] };
  }
  const context = await loadBatchContext(userId, { cutoffDate });
  if (!context) return { ok: false, errors: [VACATION_MESSAGES.collaboratorNotFound] };
  if (!context.employee.hire_date) {
    return { ok: false, errors: [VACATION_MESSAGES.historyNeedHireDate] };
  }
  return { ok: true, preview: previewBatch({ rows, ...context }) };
}

/**
 * Guarda un lote completo o nada: si una sola fila tiene errores no se
 * inserta ninguna y la respuesta trae la vista previa con el detalle.
 */
async function createHistoryBatch({ userId, rows, actorId, cutoffDate = null }) {
  const result = await previewHistoryBatch({ userId, rows, cutoffDate });
  if (!result.ok) return result;
  const { preview } = result;
  if (preview.entries === 0) {
    return { ok: false, errors: [VACATION_MESSAGES.historyBatchEmpty], preview };
  }
  if (!preview.valid) {
    return { ok: false, errors: [VACATION_MESSAGES.historyBatchHasErrors], preview };
  }

  const employee = await balanceService.getUserVacationProfile(userId);
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    for (const value of preview.values) {
      const row = await insertHistoryRow(client, { userId, employee, value, actorId });
      await writeAudit(client, {
        historyId: row.id,
        userId,
        action: HISTORY_AUDIT_ACTION.CREATE,
        actorId,
        oldValue: null,
        newValue: auditSnapshot(row),
        source: BATCH_SOURCE,
      });
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  const imputation = await balanceService.reimputeHistoricalDays(userId);
  return { ok: true, created: preview.values.length, imputation };
}

/** ¿El registro existe, está vivo y es del colaborador indicado? */
function belongsTo(record, userId) {
  if (!record || record.deleted_at) return false;
  return userId == null || String(record.user_id) === String(userId);
}

async function updateHistory({ historyId, userId = null, input, actorId, cutoffDate = null }) {
  const current = await getById(historyId);
  if (!belongsTo(current, userId)) {
    return { ok: false, errors: [VACATION_MESSAGES.historyNotFound] };
  }

  const employee = current.user_id
    ? await balanceService.getUserVacationProfile(current.user_id)
    : null;

  const normalized = normalizeHistoryInput(
    { ...input, origin: input.origin || current.origin },
    { hireDate: employee?.hire_date || null, cutoffDate },
  );
  if (!normalized.valid) {
    return { ok: false, errors: normalized.errors, warnings: normalized.warnings };
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE vacation_history
          SET period_year = $1, period_month = $2, start_date = $3, end_date = $4,
              days_used = $5, origin = $6, observation = $7,
              updated_by = $8, updated_at = NOW()
        WHERE id = $9 AND deleted_at IS NULL
        RETURNING *`,
      [
        normalized.value.periodYear,
        normalized.value.periodMonth,
        normalized.value.startDate,
        normalized.value.endDate,
        normalized.value.daysUsed,
        normalized.value.origin,
        normalized.value.observation,
        actorId || null,
        historyId,
      ],
    );
    await writeAudit(client, {
      historyId,
      userId: current.user_id,
      action: HISTORY_AUDIT_ACTION.UPDATE,
      actorId,
      oldValue: auditSnapshot(current),
      newValue: auditSnapshot(rows[0]),
      source: current.source,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  const imputation = current.user_id
    ? await balanceService.reimputeHistoricalDays(current.user_id)
    : null;
  return { ok: true, warnings: normalized.warnings, imputation };
}

/**
 * Borrado lógico: el saldo deja de contar el registro, pero la fila y su
 * auditoría siguen ahí. Un historial de RR.HH. no se borra físicamente.
 */
async function deleteHistory({ historyId, userId = null, actorId }) {
  const current = await getById(historyId);
  if (!belongsTo(current, userId)) {
    return { ok: false, error: VACATION_MESSAGES.historyNotFound };
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE vacation_history
          SET deleted_at = NOW(), deleted_by = $1, updated_at = NOW()
        WHERE id = $2`,
      [actorId || null, historyId],
    );
    await writeAudit(client, {
      historyId,
      userId: current.user_id,
      action: HISTORY_AUDIT_ACTION.DELETE,
      actorId,
      oldValue: auditSnapshot(current),
      newValue: null,
      source: current.source,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  const imputation = current.user_id
    ? await balanceService.reimputeHistoricalDays(current.user_id)
    : null;
  return { ok: true, imputation };
}

/** Bitácora de un colaborador, para la pantalla de RR.HH. */
async function listAudit(userId, limit = 50) {
  const { rows } = await db.query(
    `SELECT a.*, act.first_name AS actor_first_name, act.last_name AS actor_last_name
       FROM vacation_history_audit a
       LEFT JOIN users act ON act.id = a.actor_user_id
      WHERE a.user_id = $1
      ORDER BY a.created_at DESC
      LIMIT $2`,
    [userId, limit],
  );
  return rows;
}

module.exports = {
  normalizeHistoryInput,
  duplicateKey,
  auditSnapshot,
  writeAudit,
  insertHistoryRow,
  listForUser,
  getById,
  getUserTotals,
  existingKeysFor,
  parseYearMonth,
  previewBatch,
  previewHistoryBatch,
  createHistoryBatch,
  updateHistory,
  deleteHistory,
  listAudit,
};
