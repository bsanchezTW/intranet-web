const db = require("../../db");
const balanceService = require("./vacationBalanceService");
const { writeAudit } = require("./vacationHistoryService");
const { getCurrentCountry } = require("../../config/country");
const { VACATION_MESSAGES } = require("../../constants/vacationMessages");
const { HISTORY_AUDIT_ACTION } = require("../../constants/vacationHistory");
const { toDateOnly, todayInCountry } = require("../../utils/vacationDateUtils");

/**
 * Saldo de referencia: lo que RR.HH. tenía anotado en su Excel para un
 * colaborador a una fecha («al 16-09-2026 le quedan 7 días»).
 *
 * No mueve el saldo. Sirve para conciliar: la intranet calcula el saldo a esa
 * misma fecha con balanceAt() y muestra si cuadra o cuánto difiere. Así un
 * error de carga (una salida repetida, una fecha de ingreso mal puesta) salta
 * a la vista en vez de quedar escondido en un total.
 */

/** Estados que consumen días (los mismos que descuentan saldo). */
const CONSUMING_STATUSES = ["approved", "in_progress", "completed"];

/** Diferencia bajo la cual se considera que cuadra (redondeos de medio día). */
const MATCH_TOLERANCE = 0.01;

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Compara una referencia con el saldo que calcula la intranet a su fecha.
 * Función pura.
 */
function compareReference({ reference, periods, history, requests }) {
  const computed = balanceService.balanceAt({
    periods,
    history,
    requests,
    asOf: reference.as_of_date,
  });
  const expected = Number(reference.expected_days);
  const difference = round2(computed - expected);
  return {
    computed,
    expected,
    difference,
    matches: Math.abs(difference) <= MATCH_TOLERANCE,
  };
}

async function listForUser(userId) {
  const { rows } = await db.query(
    `SELECT r.*, u.first_name AS created_by_first_name, u.last_name AS created_by_last_name
       FROM vacation_reference_balances r
       LEFT JOIN users u ON u.id = r.created_by
      WHERE r.user_id = $1 AND r.deleted_at IS NULL
      ORDER BY r.as_of_date DESC, r.id DESC`,
    [userId],
  );
  return rows;
}

/** La referencia más reciente de cada colaborador (para el resumen). */
async function latestByUser(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT DISTINCT ON (user_id) *
       FROM vacation_reference_balances
      WHERE user_id = ANY($1::int[]) AND deleted_at IS NULL
      ORDER BY user_id, as_of_date DESC, id DESC`,
    [userIds],
  );
  return new Map(rows.map((r) => [r.user_id, r]));
}

/** Solicitudes de la intranet que descuentan días, por colaborador. */
async function consumingRequestsByUser(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return new Map();
  const { rows } = await db.query(
    `SELECT user_id, start_date, calendar_days
       FROM vacation_requests
      WHERE user_id = ANY($1::int[]) AND status = ANY($2)`,
    [userIds, CONSUMING_STATUSES],
  );
  const byUser = new Map();
  for (const r of rows) {
    if (!byUser.has(r.user_id)) byUser.set(r.user_id, []);
    byUser.get(r.user_id).push(r);
  }
  return byUser;
}

function auditValue(row) {
  return {
    id: row.id,
    as_of_date: toDateOnly(row.as_of_date),
    expected_days: Number(row.expected_days),
    note: row.note || null,
  };
}

async function createReference({ userId, asOfDate, expectedDays, note, actorId }) {
  const asOf = toDateOnly(asOfDate);
  const expected = Number(String(expectedDays ?? "").replace(",", "."));
  const errors = [];
  if (!asOf) errors.push(VACATION_MESSAGES.referenceNeedDate);
  else if (asOf > todayInCountry()) errors.push(VACATION_MESSAGES.referenceFutureDate);
  if (String(expectedDays ?? "").trim() === "" || !Number.isFinite(expected) || Math.abs(expected) > 999) {
    errors.push(VACATION_MESSAGES.referenceNeedDays);
  }
  if (errors.length) return { ok: false, errors };

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO vacation_reference_balances
         (user_id, country_code, as_of_date, expected_days, note, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        userId,
        getCurrentCountry(),
        asOf,
        round2(expected),
        note && String(note).trim() ? String(note).trim() : null,
        actorId || null,
      ],
    );
    await writeAudit(client, {
      historyId: null,
      userId,
      action: HISTORY_AUDIT_ACTION.REFERENCE,
      actorId,
      oldValue: null,
      newValue: auditValue(rows[0]),
      source: rows[0].note,
    });
    await client.query("COMMIT");
    return { ok: true, reference: rows[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/** Borrado lógico, como el historial: la bitácora conserva el valor. */
async function deleteReference({ userId, referenceId, actorId }) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE vacation_reference_balances
          SET deleted_at = NOW(), deleted_by = $1
        WHERE id = $2 AND user_id = $3 AND deleted_at IS NULL
        RETURNING *`,
      [actorId || null, referenceId, userId],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return { ok: false, error: VACATION_MESSAGES.referenceNotFound };
    }
    await writeAudit(client, {
      historyId: null,
      userId,
      action: HISTORY_AUDIT_ACTION.REFERENCE,
      actorId,
      oldValue: auditValue(rows[0]),
      newValue: null,
      source: rows[0].note,
    });
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  CONSUMING_STATUSES,
  compareReference,
  listForUser,
  latestByUser,
  consumingRequestsByUser,
  createReference,
  deleteReference,
};
