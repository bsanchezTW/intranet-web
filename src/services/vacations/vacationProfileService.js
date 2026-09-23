const db = require("../../db");
const balanceService = require("./vacationBalanceService");
const { writeAudit } = require("./vacationHistoryService");
const { VACATION_MESSAGES } = require("../../constants/vacationMessages");
const { HISTORY_AUDIT_ACTION } = require("../../constants/vacationHistory");
const { validateNationalId } = require("../../utils/nationalId");
const { toDateOnly, todayInCountry, formatDisplay } = require("../../utils/vacationDateUtils");

/**
 * Datos de los que depende el cálculo de vacaciones: fecha de ingreso y
 * documento. Viven en la ficha de Personal (users), pero RR.HH. los corrige
 * desde la ficha de vacaciones al conciliar con su Excel, así que cada cambio
 * queda en la bitácora con el valor anterior y el motivo.
 */

function profileSnapshot(user) {
  return {
    hire_date: toDateOnly(user?.hire_date),
    national_id: user?.national_id || null,
  };
}

/** ¿Cambió algo que afecte al cálculo? */
function profileChanged(before, after) {
  return before.hire_date !== after.hire_date || before.national_id !== after.national_id;
}

/**
 * Deja constancia de un cambio de fecha de ingreso o documento. `client`
 * puede ser una transacción abierta o el pool.
 */
async function auditProfileChange(client, { userId, actorId, before, after, reason = null }) {
  if (!profileChanged(before, after)) return;
  await writeAudit(client, {
    historyId: null,
    userId,
    action: HISTORY_AUDIT_ACTION.PROFILE,
    actorId,
    oldValue: before,
    newValue: after,
    source: reason ? String(reason).trim().slice(0, 255) : null,
  });
}

/**
 * Corrige fecha de ingreso y/o documento, realinea los períodos y reimputa
 * el historial.
 *
 * @returns {Promise<{ ok: boolean, errors?: string[], warnings?: string[] }>}
 */
async function updateCalculationData({ userId, hireDate, nationalId, reason, actorId }) {
  const user = await balanceService.getUserVacationProfile(userId);
  if (!user) return { ok: false, errors: [VACATION_MESSAGES.collaboratorNotFound] };

  const errors = [];
  const hire = toDateOnly(hireDate);
  if (!hire) errors.push(VACATION_MESSAGES.profileNeedHireDate);
  else if (hire > todayInCountry()) errors.push(VACATION_MESSAGES.profileFutureHireDate);

  const documento = validateNationalId(nationalId);
  if (!documento.valid) errors.push(documento.error);

  if (!reason || !String(reason).trim()) errors.push(VACATION_MESSAGES.profileNeedReason);
  if (errors.length) return { ok: false, errors };

  const before = profileSnapshot(user);
  const after = { hire_date: hire, national_id: documento.storageValue };
  if (!profileChanged(before, after)) {
    return { ok: false, errors: [VACATION_MESSAGES.profileNoChanges] };
  }

  if (after.national_id && after.national_id !== before.national_id) {
    const { rows } = await db.query(
      "SELECT id FROM users WHERE national_id = $1 AND id <> $2",
      [after.national_id, userId],
    );
    if (rows.length) return { ok: false, errors: [VACATION_MESSAGES.profileDuplicateId] };
  }

  // Si con la nueva fecha sobran períodos que la intranet ya consumió, no se
  // cambia nada: habría que decidir a mano a dónde van esos días.
  if (after.hire_date !== before.hire_date) {
    const plan = balanceService.planPeriodRealignment({
      existing: await balanceService.listPeriods(userId),
      expected: balanceService.expectedPeriodRanges(after.hire_date, todayInCountry()),
    });
    if (plan.blocked.length) {
      return { ok: false, errors: [VACATION_MESSAGES.profileBlockedPeriods] };
    }
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      "UPDATE users SET hire_date = $1, national_id = $2 WHERE id = $3",
      [after.hire_date, after.national_id, userId],
    );
    await auditProfileChange(client, { userId, actorId, before, after, reason });
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  await balanceService.recalculatePeriods(userId);
  await balanceService.ensureHistoryImputed(userId);

  // Salidas registradas antes del nuevo ingreso: siguen contando (pueden ser
  // adelantos), pero conviene revisarlas.
  const warnings = [];
  const { rows: previas } = await db.query(
    `SELECT COUNT(*)::int AS n FROM vacation_history
      WHERE user_id = $1 AND deleted_at IS NULL
        AND make_date(period_year, COALESCE(period_month, 12), 28) < $2::date`,
    [userId, after.hire_date],
  );
  if (previas[0]?.n > 0) {
    warnings.push(VACATION_MESSAGES.profileHistoryBeforeHire(previas[0].n, formatDisplay(after.hire_date)));
  }
  return { ok: true, warnings };
}

module.exports = {
  profileSnapshot,
  profileChanged,
  auditProfileChange,
  updateCalculationData,
};
