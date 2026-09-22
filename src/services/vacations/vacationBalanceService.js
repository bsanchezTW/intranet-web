const db = require("../../db");
const { getStrategy, resolveCountryForUser } = require("./VacationEngine");
const { VACATION_CONFIG } = require("../../constants/vacationConfig");
const {
  toDateOnly,
  addDays,
  fullYearsBetween,
  todayInCountry,
} = require("../../utils/vacationDateUtils");

/**
 * Gestión de períodos de devengo y saldos.
 *
 * Modelo: un período por año laboral (aniversario de hire_date). Los años ya
 * cumplidos otorgan el derecho completo; el año en curso devenga proporcional.
 *
 * Saldo de un período = entitled_days + adjusted_days − used_days − historical_used_days
 *   · used_days            → solicitudes aprobadas EN la intranet
 *   · historical_used_days → días gozados ANTES de la intranet (vacation_history)
 *
 * Las dos se restan igual, pero viven separadas: RR.HH. necesita ver de dónde
 * viene cada día y reimputar el historial no debe tocar lo que ya aprobó la
 * intranet.
 *
 * Qué períodos suman al saldo disponible lo decide la estrategia del país
 * (isPeriodClaimable): en Perú solo los años cumplidos; el año en curso queda
 * como trunco para liquidación.
 */

function effectiveEntitled(period) {
  if (period.record_met === false) return 0;
  return Number(period.entitled_days);
}

/** Días del historial previo a la intranet imputados a este período. */
function periodHistoricalUsed(period) {
  return Number(period.historical_used_days || 0);
}

function periodAvailable(period) {
  return (
    effectiveEntitled(period) +
    Number(period.adjusted_days) -
    Number(period.used_days) -
    periodHistoricalUsed(period)
  );
}

/** Suma el aniversario (años) a una fecha date-only. */
function addYears(value, years) {
  const date = toDateOnly(value);
  if (!date) return null;
  const [y, m, d] = date.split("-").map(Number);
  const target = `${y + years}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  return toDateOnly(target) || target;
}

async function getUserVacationProfile(userId) {
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, email, national_id, hire_date,
            manager_user_id, prior_years_credited, progressive_days_override,
            work_days_per_week
     FROM users WHERE id = $1`,
    [userId],
  );
  return rows[0] || null;
}

/**
 * Regenera/actualiza los períodos de un colaborador según su hire_date y país.
 * Idempotente: no duplica (UNIQUE user_id, period_start) y no pisa
 * used_days, adjusted_days ni historical_used_days.
 */
async function recalculatePeriods(userId) {
  const user = await getUserVacationProfile(userId);
  if (!user || !user.hire_date) return;

  const country = resolveCountryForUser(user);
  const strategy = getStrategy(country);
  const hire = toDateOnly(user.hire_date);
  const today = todayInCountry();
  const yearsComplete = fullYearsBetween(hire, today);
  const priorYears = Number(user.prior_years_credited) || 0;
  const progressiveOverride =
    user.progressive_days_override != null
      ? Number(user.progressive_days_override)
      : null;

  for (let k = 1; k <= yearsComplete; k += 1) {
    const periodStart = addYears(hire, k - 1);
    const periodEnd = addDays(addYears(hire, k), -1);
    const entitled = strategy.getAnnualEntitlement({
      yearsOfService: k,
      priorYearsCredited: priorYears,
      progressiveOverride,
    });
    const expires = strategy.getExpirationDate({ periodEnd });
    await upsertPeriod({
      userId,
      country,
      periodStart,
      periodEnd,
      entitledDays: entitled,
      expiresAt: expires,
    });
  }

  const currentStart = addYears(hire, yearsComplete);
  const currentEnd = addDays(addYears(hire, yearsComplete + 1), -1);
  const proportional = strategy.getProportionalDays({
    hireDate: currentStart,
    referenceDate: today,
  });
  await upsertPeriod({
    userId,
    country,
    periodStart: currentStart,
    periodEnd: currentEnd,
    entitledDays: proportional,
    expiresAt: strategy.getExpirationDate({ periodEnd: currentEnd }),
    onlyRaiseEntitled: true,
  });

  // Limpia expires_at obsoleto: ni Chile ni Perú caducan (en Perú el derecho
  // no se extingue, la mora genera indemnización — D.L. 713 art. 23).
  await db.query(
    `UPDATE vacation_periods SET expires_at = NULL, updated_at = NOW()
     WHERE user_id = $1 AND expires_at IS NOT NULL`,
    [userId],
  );
}

async function upsertPeriod({
  userId,
  country,
  periodStart,
  periodEnd,
  entitledDays,
  expiresAt,
  onlyRaiseEntitled = false,
}) {
  const entitledClause = onlyRaiseEntitled
    ? "GREATEST(vacation_periods.entitled_days, EXCLUDED.entitled_days)"
    : "EXCLUDED.entitled_days";

  await db.queryRetryIdCollision(
    `INSERT INTO vacation_periods
       (user_id, country_code, period_start, period_end, entitled_days, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (user_id, period_start) DO UPDATE SET
       country_code = EXCLUDED.country_code,
       period_end   = EXCLUDED.period_end,
       entitled_days = ${entitledClause},
       expires_at   = EXCLUDED.expires_at,
       updated_at   = NOW()`,
    [userId, country, periodStart, periodEnd, entitledDays, expiresAt],
  );
}

/** Lista períodos de un usuario (más reciente primero). */
async function listPeriods(userId) {
  const { rows } = await db.query(
    `SELECT * FROM vacation_periods WHERE user_id = $1 ORDER BY period_start DESC`,
    [userId],
  );
  return rows;
}

/** ¿El saldo de este período se puede pedir hoy? Lo decide el país. */
function isPeriodClaimable(period, strategy, today) {
  return strategy.isPeriodClaimable({ period, referenceDate: today });
}

/**
 * Períodos cuyo saldo se puede pedir, ordenados FIFO (más antiguo primero).
 * En Perú excluye el año en curso: eso es trunco, no días pedibles.
 */
async function listClaimablePeriodsFifo(userId, client = db) {
  const today = todayInCountry();
  const strategy = getStrategy(resolveCountryForUser());
  const { rows } = await client.query(
    `SELECT * FROM vacation_periods
     WHERE user_id = $1
     ORDER BY period_start ASC`,
    [userId],
  );
  return rows.filter((p) => isPeriodClaimable(p, strategy, today));
}

/** Primer período FIFO con saldo disponible (para validación PE). */
async function getPrimaryPeriodForRequest(userId) {
  const periods = await listClaimablePeriodsFifo(userId);
  return periods.find((p) => periodAvailable(p) > 0.001) || null;
}

/** Saldo disponible total (suma de períodos exigibles). */
async function getAvailableBalance(userId) {
  const periods = await listClaimablePeriodsFifo(userId);
  return periods.reduce((sum, p) => sum + periodAvailable(p), 0);
}

/**
 * Detecta acumulación de períodos sin gozar (Chile art. 70).
 * @returns {{ alert: boolean, periodsWithBalance: number, message: string|null }}
 */
function detectAccumulationAlert(periods, country) {
  if (country !== "CL") {
    return { alert: false, periodsWithBalance: 0, message: null };
  }
  const maxPeriods = VACATION_CONFIG.maxAccumulatedPeriodsCL;
  const withBalance = periods.filter((p) => periodAvailable(p) > 0.001);
  if (withBalance.length >= maxPeriods) {
    return {
      alert: true,
      periodsWithBalance: withBalance.length,
      message: `Tienes ${withBalance.length} período(s) con saldo sin gozar. La ley permite acumular hasta ${maxPeriods} períodos consecutivos; RR.HH. y tu jefatura han sido notificados.`,
    };
  }
  return { alert: false, periodsWithBalance: withBalance.length, message: null };
}

/**
 * Resumen de saldos, calculado sobre una lista de períodos ya cargada.
 *
 * Función pura: recibe los períodos y la fecha de referencia, así que se puede
 * probar sin base de datos y devuelve siempre lo mismo para la misma entrada.
 */
function summarizePeriods({ periods, country, referenceDate }) {
  const strategy = getStrategy(country);
  const today = toDateOnly(referenceDate) || toDateOnly(new Date());

  let entitled = 0; // derecho de años cumplidos
  let trunco = 0; // proporcional del año en curso
  let truncoAvailable = 0;
  let used = 0; // solicitudes aprobadas en la intranet
  let historicalUsed = 0; // días gozados antes de la intranet
  let adjusted = 0;
  let available = 0;
  let nextAccrualDate = null;

  for (const p of periods) {
    const claimable = isPeriodClaimable(p, strategy, today);
    const eff = effectiveEntitled(p);

    used += Number(p.used_days);
    historicalUsed += periodHistoricalUsed(p);
    adjusted += Number(p.adjusted_days);

    if (claimable) {
      entitled += eff;
      available += periodAvailable(p);
    } else {
      trunco += eff;
      truncoAvailable += periodAvailable(p);
      // El próximo derecho llega cuando termina el período en curso.
      const nextFromPeriod = addDays(toDateOnly(p.period_end), 1);
      if (nextFromPeriod && (!nextAccrualDate || nextFromPeriod < nextAccrualDate)) {
        nextAccrualDate = nextFromPeriod;
      }
    }
  }

  const accumulation = detectAccumulationAlert(periods, country);
  const claimablePeriods = periods.filter((p) => isPeriodClaimable(p, strategy, today));

  return {
    // --- nombres históricos, en uso por las vistas actuales ---------------
    entitled: round2(entitled),
    used: round2(used),
    adjusted: round2(adjusted),
    available: round2(available),
    expiringSoon: 0, // ningún país caduca ya; se mantiene por compatibilidad
    periodsCount: periods.length,
    activePeriodsCount: claimablePeriods.length,
    accumulationAlert: accumulation.alert,
    accumulationMessage: accumulation.message,
    periodsWithBalance: accumulation.periodsWithBalance,

    // --- vocabulario del módulo de historial -------------------------------
    /** Días generados por años de servicio CUMPLIDOS. */
    generatedDays: round2(entitled),
    /** Proporcional del año en curso: liquidación, no días pedibles. */
    truncoDays: round2(trunco),
    /** Días gozados antes de la intranet (Excel de RR.HH.). */
    historicalUsedDays: round2(historicalUsed),
    /** Días gozados a través de la intranet (solicitudes aprobadas). */
    approvedUsedDays: round2(used),
    /** Total gozado, venga de donde venga. */
    totalUsedDays: round2(historicalUsed + used),
    adjustedDays: round2(adjusted),
    availableDays: round2(available),
    /** Lo que habría que pagar en una liquidación hoy: saldo + trunco. */
    severanceDays: round2(available + truncoAvailable),
    nextAccrualDate,
  };
}

/** Resumen de saldos para la UI (lee de base). */
async function getBalanceSummary(userId, { referenceDate } = {}) {
  const user = await getUserVacationProfile(userId);
  const country = resolveCountryForUser(user);
  const periods = await listPeriods(userId);
  return summarizePeriods({
    periods,
    country,
    referenceDate: referenceDate || todayInCountry(),
  });
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

/**
 * Consume días de los períodos exigibles en orden FIFO (más antiguo primero).
 * Para PE actualiza contadores de bloques protegido/flexible.
 * @returns {{ firstPeriodId: number|null, allocations: Array<{periodId,days,protectedDelta,flexibleDelta}> }}
 */
async function consumeDaysFifo(client, userId, days, countryCode) {
  let remaining = Number(days);
  let firstPeriodId = null;
  const allocations = [];
  const strategy = getStrategy(countryCode);

  const today = todayInCountry();
  const { rows: allPeriods } = await client.query(
    `SELECT * FROM vacation_periods
     WHERE user_id = $1
     ORDER BY period_start ASC
     FOR UPDATE`,
    [userId],
  );
  const periods = allPeriods.filter((p) => isPeriodClaimable(p, strategy, today));

  for (const p of periods) {
    if (remaining <= 0.001) break;
    const avail = periodAvailable(p);
    if (avail <= 0) continue;
    const take = Math.min(avail, remaining);

    let protectedDelta = 0;
    let flexibleDelta = 0;

    if (countryCode === "PE" && p.country_code === "PE") {
      ({ protectedDelta, flexibleDelta } = strategy.allocateBlockDays(p, take));
      await client.query(
        `UPDATE vacation_periods
         SET used_days = used_days + $1,
             protected_block_days_used = protected_block_days_used + $2,
             flexible_block_days_used = flexible_block_days_used + $3,
             updated_at = NOW()
         WHERE id = $4`,
        [take, protectedDelta, flexibleDelta, p.id],
      );
      // Mantener estado en memoria para siguientes slices del mismo período
      p.used_days = Number(p.used_days) + take;
      p.protected_block_days_used =
        Number(p.protected_block_days_used || 0) + protectedDelta;
      p.flexible_block_days_used =
        Number(p.flexible_block_days_used || 0) + flexibleDelta;
    } else {
      await client.query(
        `UPDATE vacation_periods SET used_days = used_days + $1, updated_at = NOW() WHERE id = $2`,
        [take, p.id],
      );
      p.used_days = Number(p.used_days) + take;
    }

    if (firstPeriodId === null) firstPeriodId = p.id;
    allocations.push({
      periodId: p.id,
      days: take,
      protectedDelta,
      flexibleDelta,
    });
    remaining -= take;
  }

  if (remaining > 0.001) {
    throw new Error("Saldo insuficiente al consumir días de vacaciones.");
  }
  return { firstPeriodId, allocations };
}

/**
 * Revierte imputaciones exactas de una aprobación (multi-período).
 * Preferir esto sobre releaseDays cuando existan period_allocations.
 */
async function releaseAllocations(client, allocations, countryCode) {
  if (!Array.isArray(allocations) || allocations.length === 0) return;

  for (const alloc of allocations) {
    const periodId = alloc.periodId ?? alloc.period_id;
    const take = Number(alloc.days || 0);
    if (!periodId || take <= 0) continue;

    if (countryCode === "PE") {
      const protRelease = Number(alloc.protectedDelta ?? alloc.protected_delta ?? 0);
      const flexRelease = Number(alloc.flexibleDelta ?? alloc.flexible_delta ?? 0);
      await client.query(
        `UPDATE vacation_periods
         SET used_days = GREATEST(0, used_days - $1),
             protected_block_days_used = GREATEST(0, protected_block_days_used - $2),
             flexible_block_days_used = GREATEST(0, flexible_block_days_used - $3),
             updated_at = NOW()
         WHERE id = $4`,
        [take, protRelease, flexRelease, periodId],
      );
    } else {
      await client.query(
        `UPDATE vacation_periods
         SET used_days = GREATEST(0, used_days - $1), updated_at = NOW()
         WHERE id = $2`,
        [take, periodId],
      );
    }
  }
}

/**
 * Libera días de un único período (fallback para solicitudes sin period_allocations).
 * Heurística PE: revierte flexible primero (espejo de tramos 1–6 art. 17.ii).
 */
async function releaseDays(client, periodId, days, countryCode) {
  if (!periodId) return;
  const take = Number(days);

  if (countryCode === "PE") {
    const { rows } = await client.query(
      `SELECT * FROM vacation_periods WHERE id = $1 FOR UPDATE`,
      [periodId],
    );
    const period = rows[0];
    if (!period) return;

    let flexRelease = Math.min(Number(period.flexible_block_days_used), take);
    let protRelease = take - flexRelease;
    if (protRelease > Number(period.protected_block_days_used)) {
      protRelease = Number(period.protected_block_days_used);
      flexRelease = take - protRelease;
    }

    await client.query(
      `UPDATE vacation_periods
       SET used_days = GREATEST(0, used_days - $1),
           protected_block_days_used = GREATEST(0, protected_block_days_used - $2),
           flexible_block_days_used = GREATEST(0, flexible_block_days_used - $3),
           updated_at = NOW()
       WHERE id = $4`,
      [take, protRelease, flexRelease, periodId],
    );
    return;
  }

  await client.query(
    `UPDATE vacation_periods
     SET used_days = GREATEST(0, used_days - $1), updated_at = NOW()
     WHERE id = $2`,
    [take, periodId],
  );
}

// ===========================================================================
// Historial previo a la intranet
// ===========================================================================

/**
 * Reparte N días ya gozados sobre una lista de períodos, FIFO.
 *
 * Función pura, sin base de datos: es el corazón del cálculo y lo que prueban
 * los tests. No valida el art. 17 —son hechos ocurridos, muchos anteriores a
 * la norma— y si el historial excede el derecho generado devuelve el exceso en
 * `overflow` en vez de fallar: RR.HH. lo ve y decide.
 */
function allocateHistoricalFifo({ days, periods, strategy }) {
  let remaining = round2(Number(days) || 0);
  const allocations = [];

  for (const p of periods) {
    if (remaining <= 0.001) break;
    const room =
      effectiveEntitled(p) +
      Number(p.adjusted_days || 0) -
      Number(p.used_days || 0) -
      periodHistoricalUsed(p);
    if (room <= 0.001) continue;

    const take = round2(Math.min(room, remaining));
    let protectedDelta = 0;
    let flexibleDelta = 0;
    if (strategy && typeof strategy.allocateHistoricalBlockDays === "function") {
      ({ protectedDelta, flexibleDelta } = strategy.allocateHistoricalBlockDays(
        p,
        take,
      ));
    }

    allocations.push({
      periodId: p.id,
      days: take,
      protectedDelta,
      flexibleDelta,
    });

    // Estado en memoria para el siguiente registro del mismo lote.
    p.historical_used_days = round2(periodHistoricalUsed(p) + take);
    p.protected_block_days_used = round2(
      Number(p.protected_block_days_used || 0) + protectedDelta,
    );
    p.flexible_block_days_used = round2(
      Number(p.flexible_block_days_used || 0) + flexibleDelta,
    );
    remaining = round2(remaining - take);
  }

  return { allocations, overflow: round2(Math.max(0, remaining)) };
}

/**
 * Reconstruye desde cero la imputación del historial de un colaborador.
 *
 * Pone historical_used_days (y la parte histórica de los bloques) en cero y
 * vuelve a repartir FIFO todos los registros vivos de vacation_history, del
 * más antiguo al más nuevo. Es determinista: el mismo historial siempre
 * produce el mismo saldo, sin importar en qué orden se cargó ni cuántas veces
 * se corrigió.
 *
 * Se llama al crear/editar/borrar historial, al importar o revertir un lote y
 * cuando ensureHistoryImputed() detecta que los números no cuadran. NO se
 * llama en cada carga de página.
 */
async function reimputeHistoricalDays(userId, externalClient = null) {
  const client = externalClient || (await db.getClient());
  const ownClient = !externalClient;
  try {
    if (ownClient) await client.query("BEGIN");

    const { rows: periods } = await client.query(
      `SELECT * FROM vacation_periods
       WHERE user_id = $1
       ORDER BY period_start ASC
       FOR UPDATE`,
      [userId],
    );

    // Los bloques 15+15 guardan protegido/flexible de TODO el consumo. Se
    // reconstruyen desde las imputaciones reales de las solicitudes vigentes y
    // luego se les suma el historial, para no arrastrar repartos viejos.
    const approvedBlocks = await approvedBlocksByPeriod(client, userId);
    for (const p of periods) {
      const approved = approvedBlocks.get(p.id) || {
        protectedDelta: 0,
        flexibleDelta: 0,
      };
      p.historical_used_days = 0;
      p.protected_block_days_used = approved.protectedDelta;
      p.flexible_block_days_used = approved.flexibleDelta;
    }

    const { rows: records } = await client.query(
      `SELECT id, days_used FROM vacation_history
       WHERE user_id = $1 AND deleted_at IS NULL
       ORDER BY period_year ASC, COALESCE(period_month, 0) ASC, id ASC`,
      [userId],
    );

    const country = resolveCountryForUser();
    const strategy = getStrategy(country);
    let totalOverflow = 0;

    for (const record of records) {
      const { allocations, overflow } = allocateHistoricalFifo({
        days: record.days_used,
        periods,
        strategy,
      });
      totalOverflow = round2(totalOverflow + overflow);
      await client.query(
        `UPDATE vacation_history SET period_allocations = $1::jsonb, updated_at = NOW()
         WHERE id = $2`,
        [JSON.stringify(allocations), record.id],
      );
    }

    for (const p of periods) {
      await client.query(
        `UPDATE vacation_periods
         SET historical_used_days = $1,
             protected_block_days_used = $2,
             flexible_block_days_used = $3,
             updated_at = NOW()
         WHERE id = $4`,
        [
          periodHistoricalUsed(p),
          Number(p.protected_block_days_used || 0),
          Number(p.flexible_block_days_used || 0),
          p.id,
        ],
      );
    }

    if (ownClient) await client.query("COMMIT");
    return { overflow: totalOverflow, records: records.length };
  } catch (err) {
    if (ownClient) await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    if (ownClient) client.release();
  }
}

/**
 * Bloques protegido/flexible que consumió cada período por solicitudes de la
 * intranet, leídos de las imputaciones exactas que guardó la aprobación.
 *
 * No se puede deducir de used_days: un tramo de 1–6 días va al bloque
 * flexible y uno de 7–14 al protegido (art. 17), así que dos períodos con los
 * mismos días usados pueden tener contadores muy distintos. Reconstruirlos "a
 * ojo" le devolvería al colaborador días sueltos que ya gastó.
 *
 * Una solicitud aprobada sin period_allocations (anterior a esa columna) no
 * aporta bloques: Perú todavía no tiene solicitudes en producción, así que hoy
 * no hay ninguna en ese caso. Si apareciera, RR.HH. lo corrige con un ajuste.
 *
 * @returns {Map<number, {protectedDelta:number, flexibleDelta:number}>}
 */
async function approvedBlocksByPeriod(client, userId) {
  const { rows } = await client.query(
    `SELECT period_allocations FROM vacation_requests
      WHERE user_id = $1
        AND status = ANY($2)
        AND period_allocations IS NOT NULL`,
    [userId, ["approved", "in_progress", "completed"]],
  );

  const porPeriodo = new Map();
  for (const row of rows) {
    let allocations = row.period_allocations;
    if (typeof allocations === "string") {
      try {
        allocations = JSON.parse(allocations);
      } catch {
        continue;
      }
    }
    if (!Array.isArray(allocations)) continue;

    for (const alloc of allocations) {
      const periodId = alloc.periodId ?? alloc.period_id;
      if (!periodId) continue;
      const acc = porPeriodo.get(periodId) || {
        protectedDelta: 0,
        flexibleDelta: 0,
      };
      acc.protectedDelta = round2(
        acc.protectedDelta + Number(alloc.protectedDelta ?? alloc.protected_delta ?? 0),
      );
      acc.flexibleDelta = round2(
        acc.flexibleDelta + Number(alloc.flexibleDelta ?? alloc.flexible_delta ?? 0),
      );
      porPeriodo.set(periodId, acc);
    }
  }
  return porPeriodo;
}

/**
 * Comprueba barato que la imputación del historial esté al día y la rehace si
 * no lo está (por ejemplo, tras un nuevo aniversario que amplía el derecho).
 * Una consulta de dos SUM; solo reimputa cuando los números no cuadran.
 */
async function ensureHistoryImputed(userId) {
  const { rows } = await db.query(
    `SELECT
       (SELECT COALESCE(SUM(days_used), 0) FROM vacation_history
         WHERE user_id = $1 AND deleted_at IS NULL) AS history_total,
       (SELECT COALESCE(SUM(historical_used_days), 0) FROM vacation_periods
         WHERE user_id = $1) AS imputed_total`,
    [userId],
  );
  const row = rows[0] || {};
  const historyTotal = round2(row.history_total || 0);
  const imputedTotal = round2(row.imputed_total || 0);
  if (Math.abs(historyTotal - imputedTotal) <= 0.001) {
    return { reimputed: false, historyTotal, imputedTotal };
  }
  const result = await reimputeHistoricalDays(userId);
  return { reimputed: true, historyTotal, imputedTotal, ...result };
}

/** Aplica un ajuste manual de saldo + auditoría. */
async function applyAdjustment({ periodId, adjustedBy, daysDelta, reason }) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE vacation_periods
       SET adjusted_days = adjusted_days + $1, updated_at = NOW()
       WHERE id = $2`,
      [Number(daysDelta), periodId],
    );
    await client.query(
      `INSERT INTO vacation_balance_adjustments
         (vacation_period_id, adjusted_by, days_delta, reason)
       VALUES ($1, $2, $3, $4)`,
      [periodId, adjustedBy, Number(daysDelta), String(reason).trim()],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Marca récord vacacional de un período (T-05). */
async function updatePeriodRecord({
  periodId,
  recordMet,
  validatedBy,
  notes,
}) {
  await db.query(
    `UPDATE vacation_periods
     SET record_met = $1,
         record_validated_by = $2,
         record_notes = $3,
         updated_at = NOW()
     WHERE id = $4`,
    [Boolean(recordMet), validatedBy || null, notes ? String(notes).trim() : null, periodId],
  );
}

module.exports = {
  effectiveEntitled,
  periodHistoricalUsed,
  periodAvailable,
  getUserVacationProfile,
  recalculatePeriods,
  listPeriods,
  listClaimablePeriodsFifo,
  getPrimaryPeriodForRequest,
  getAvailableBalance,
  detectAccumulationAlert,
  summarizePeriods,
  getBalanceSummary,
  consumeDaysFifo,
  releaseAllocations,
  releaseDays,
  allocateHistoricalFifo,
  reimputeHistoricalDays,
  ensureHistoryImputed,
  applyAdjustment,
  updatePeriodRecord,
};
