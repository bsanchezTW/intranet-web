const db = require("../../db");
const balanceService = require("./vacationBalanceService");
const { getCurrentCountry } = require("../../config/country");
const { VACATION_MESSAGES } = require("../../constants/vacationMessages");
const {
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

/**
 * Normaliza y valida los datos de un registro histórico.
 *
 * @returns {{ valid: boolean, errors: string[], warnings: string[], value?: object }}
 */
function normalizeHistoryInput(input, context = {}) {
  const errors = [];
  const warnings = [];
  const { hireDate = null, cutoffDate = null, referenceYear = null } = context;

  const year = Number.parseInt(input.periodYear ?? input.period_year, 10);
  const month = parseMonth(input.periodMonth ?? input.period_month);
  const startDate = toDateOnly(input.startDate ?? input.start_date);
  const endDate = toDateOnly(input.endDate ?? input.end_date);
  const days = Number(input.daysUsed ?? input.days_used);
  const maxYear =
    referenceYear || Number((todayInCountry() || "").slice(0, 4)) || year;

  if (!Number.isInteger(year)) {
    errors.push(VACATION_MESSAGES.historyNeedYear);
  } else if (year < MIN_HISTORY_YEAR || year > maxYear) {
    errors.push(VACATION_MESSAGES.historyInvalidYear(MIN_HISTORY_YEAR));
  }

  const rawMonth = input.periodMonth ?? input.period_month;
  if (rawMonth != null && String(rawMonth).trim() !== "" && month == null) {
    errors.push(VACATION_MESSAGES.historyInvalidMonth);
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
      ORDER BY h.period_year DESC, COALESCE(h.period_month, 0) DESC, h.id DESC`,
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

/** Registro manual desde la ficha del colaborador. */
async function createHistory({ userId, input, actorId, cutoffDate = null }) {
  const employee = await balanceService.getUserVacationProfile(userId);
  if (!employee) {
    return { ok: false, errors: [VACATION_MESSAGES.collaboratorNotFound] };
  }

  const normalized = normalizeHistoryInput(
    { ...input, origin: input.origin || HISTORY_ORIGIN.MANUAL },
    { hireDate: employee.hire_date, cutoffDate },
  );
  if (!normalized.valid) {
    return { ok: false, errors: normalized.errors, warnings: normalized.warnings };
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const row = await insertHistoryRow(client, {
      userId,
      employee,
      value: normalized.value,
      actorId,
    });
    await writeAudit(client, {
      historyId: row.id,
      userId,
      action: "CREATE",
      actorId,
      oldValue: null,
      newValue: auditSnapshot(row),
      source: normalized.value.source,
    });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  const imputation = await balanceService.reimputeHistoricalDays(userId);
  return { ok: true, warnings: normalized.warnings, imputation };
}

async function updateHistory({ historyId, input, actorId, cutoffDate = null }) {
  const current = await getById(historyId);
  if (!current || current.deleted_at) {
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
      action: "UPDATE",
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
async function deleteHistory({ historyId, actorId }) {
  const current = await getById(historyId);
  if (!current || current.deleted_at) {
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
      action: "DELETE",
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
  createHistory,
  updateHistory,
  deleteHistory,
  listAudit,
};
