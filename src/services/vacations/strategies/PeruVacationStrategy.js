const BaseVacationStrategy = require("./BaseVacationStrategy");
const {
  countCalendarDays,
  fullYearsBetween,
  fullMonthsBetween,
  addDays,
  toDateOnly,
  rangesOverlap,
} = require("../../../utils/vacationDateUtils");
const { VACATION_MESSAGES } = require("../../../constants/vacationMessages");

const ANNUAL_ENTITLEMENT = 30; // días calendario por año completo
const PROTECTED_BLOCK_SIZE = 15;
const FLEXIBLE_BLOCK_SIZE = 15;

/**
 * Reglas de Perú — D.L. 713 / D.L. 1188 (régimen general).
 * Unidad: días calendario (incluye fines de semana y feriados).
 */
class PeruVacationStrategy extends BaseVacationStrategy {
  getCountryCode() {
    return "PE";
  }

  getDayUnit() {
    return "calendar";
  }

  getAnnualEntitlement() {
    return ANNUAL_ENTITLEMENT;
  }

  isEligible({ hireDate, referenceDate }) {
    if (!hireDate) return false;
    return fullYearsBetween(hireDate, referenceDate) >= 1;
  }

  /** Proporcional: (meses_completos / 12) * 30. */
  getProportionalDays({ hireDate, referenceDate }) {
    if (!hireDate) return 0;
    const months = Math.min(12, fullMonthsBetween(hireDate, referenceDate));
    return Math.round((months / 12) * ANNUAL_ENTITLEMENT * 100) / 100;
  }

  countRequestDays({ startDate, endDate }) {
    return countCalendarDays(startDate, endDate);
  }

  /**
   * Los días no gozados NO caducan.
   *
   * El módulo nació con `fin de período + 365`, que es el plazo del art. 23
   * para *gozarlas*, no un plazo para *perderlas*: vencido el año el derecho
   * sigue vivo y lo que se gatilla es la indemnización. RRHH lleva el saldo
   * acumulado (una persona con 7 años y 196 días tomados tiene 14 pendientes,
   * no 14 "de los períodos que todavía no vencen") y es ese número el que se
   * usa en una liquidación. Devolver null mantiene todos los períodos vigentes.
   */
  getExpirationDate() {
    return null;
  }

  /**
   * Solo cuentan los períodos ya cerrados: 30 días por cada año de servicios
   * CUMPLIDO (art. 10 D.L. 713). El año en curso devenga trunco, que sirve
   * para una liquidación pero no habilita a pedir días.
   *
   * Es la misma cuenta que lleva RR.HH. a mano: "2 años y 3 meses → 60 días
   * acumulados", no 67,5.
   */
  isPeriodClaimable({ period, referenceDate }) {
    const end = toDateOnly(period?.period_end);
    const today = toDateOnly(referenceDate);
    if (!end || !today) return false;
    return end < today;
  }

  /**
   * Imputa días YA GOZADOS (historial previo a la intranet) a los bloques del
   * período, sin validar el art. 17.
   *
   * Un registro histórico es un hecho ocurrido, no una solicitud: buena parte
   * viene de antes del D. Leg. 1405 (2018), cuando el fraccionamiento 15+15 ni
   * existía. Por eso satura protegido y luego flexible, y nunca lanza: si el
   * período no alcanza, devuelve lo que cupo y el resto se imputa al siguiente.
   * Las solicitudes nuevas siguen pasando por allocateBlockDays().
   */
  allocateHistoricalBlockDays(period, days) {
    const N = Math.max(0, Number(days) || 0);
    const protectedRemaining = Math.max(
      0,
      PROTECTED_BLOCK_SIZE - Number(period.protected_block_days_used || 0),
    );
    const flexibleRemaining = Math.max(
      0,
      FLEXIBLE_BLOCK_SIZE - Number(period.flexible_block_days_used || 0),
    );

    const protectedDelta = Math.min(N, protectedRemaining);
    const flexibleDelta = Math.min(N - protectedDelta, flexibleRemaining);
    return { protectedDelta, flexibleDelta };
  }

  /** Vacaciones truncas al cese: proporcional a la fecha de término. */
  getSeveranceBalance({ hireDate, terminationDate }) {
    return this.getProportionalDays({
      hireDate,
      referenceDate: terminationDate,
    });
  }

  /**
   * Hook para récord vacacional (art. 10 D.L. 713).
   * Sin datos de asistencia: no-op; RR.HH. marca manualmente record_met.
   */
  evaluateRecord(/* period, attendanceData */) {
    return { recordMet: true, reason: null };
  }

  /**
   * Valida fraccionamiento art. 17 contra un período (bloque protegido 15 + flexible 15).
   * @returns {{ valid: boolean, error?: string, requiresFractionAck?: boolean }}
   */
  validateFractionAgainstPeriod(days, period) {
    const protectedUsed = Number(period.protected_block_days_used || 0);
    const flexibleUsed = Number(period.flexible_block_days_used || 0);
    const protectedRemaining = PROTECTED_BLOCK_SIZE - protectedUsed;
    const flexibleRemaining = FLEXIBLE_BLOCK_SIZE - flexibleUsed;
    const N = Number(days);

    if (N <= 0) {
      return { valid: false, error: VACATION_MESSAGES.noDays };
    }

    // Completar bloque protegido con tramo pequeño (ej. 7+6 inválido)
    if (
      protectedUsed > 0 &&
      protectedUsed < PROTECTED_BLOCK_SIZE &&
      N >= 1 &&
      N <= 6
    ) {
      const needed = PROTECTED_BLOCK_SIZE - protectedUsed;
      if (needed >= 7) {
        return {
          valid: false,
          error: VACATION_MESSAGES.protectedComplement,
        };
      }
    }

    // Bloque flexible: tramos de 1 a 6 días (art. 17.ii)
    if (N >= 1 && N <= 6) {
      if (flexibleRemaining >= N) {
        return { valid: true, requiresFractionAck: true };
      }
      return {
        valid: false,
        error: VACATION_MESSAGES.flexibleExhausted,
      };
    }

    // Bloque protegido: 15 días corridos o tramos 7+8 / 8+7 (art. 17.i)
    if (N >= PROTECTED_BLOCK_SIZE) {
      const need = Math.min(N, protectedRemaining + flexibleRemaining);
      if (need <= protectedRemaining) {
        return { valid: true, requiresFractionAck: N < PROTECTED_BLOCK_SIZE * 2 };
      }
      if (protectedRemaining + flexibleRemaining >= N) {
        return { valid: true, requiresFractionAck: true };
      }
      return {
        valid: false,
        error: VACATION_MESSAGES.insufficientPeriod(N),
      };
    }

    // Tramo intermedio 7–14 sobre bloque protegido
    if (N >= 7 && N <= 14) {
      if (protectedUsed === 0) {
        if (N <= protectedRemaining) {
          return { valid: true, requiresFractionAck: true };
        }
        return {
          valid: false,
          error: VACATION_MESSAGES.protectedNotEnough,
        };
      }
      if (protectedUsed === 7 && N >= 8 && protectedUsed + N <= PROTECTED_BLOCK_SIZE) {
        return { valid: true, requiresFractionAck: true };
      }
      if (protectedUsed === 8 && N >= 7 && protectedUsed + N <= PROTECTED_BLOCK_SIZE) {
        return { valid: true, requiresFractionAck: true };
      }
      if (protectedUsed > 0 && protectedUsed < PROTECTED_BLOCK_SIZE) {
        return {
          valid: false,
          error: VACATION_MESSAGES.protectedComplement,
        };
      }
      if (protectedRemaining >= N) {
        return { valid: true, requiresFractionAck: true };
      }
    }

    // 7–14 cuando protegido agotado: solo flexible si cabe (raro, N>6 ya cubierto arriba para <=6)
    if (N > 6 && N < 7) {
      return {
        valid: false,
        error: VACATION_MESSAGES.fractionInvalid,
      };
    }

    return {
      valid: false,
      error: VACATION_MESSAGES.fractionInvalid,
    };
  }

  /**
   * Calcula imputación a bloques protegido/flexible al consumir N días.
   * Misma lógica que validateFractionAgainstPeriod (art. 17):
   *   1–6  → bloque flexible
   *   7–14 → bloque protegido
   *   ≥15  → protegido primero, excedente a flexible
   */
  allocateBlockDays(period, days) {
    const N = Number(days);
    const protectedUsed = Number(period.protected_block_days_used || 0);
    const flexibleUsed = Number(period.flexible_block_days_used || 0);
    const protectedRemaining = PROTECTED_BLOCK_SIZE - protectedUsed;
    const flexibleRemaining = FLEXIBLE_BLOCK_SIZE - flexibleUsed;

    if (N <= 0) {
      throw new Error("Saldo insuficiente en bloques del período.");
    }

    // Art. 17.ii: tramos 1–6 solo contra bloque flexible
    if (N >= 1 && N <= 6) {
      if (N <= flexibleRemaining) {
        return { protectedDelta: 0, flexibleDelta: N };
      }
      throw new Error("Saldo insuficiente en bloques del período.");
    }

    // Art. 17.i: tramos 7–14 solo contra bloque protegido
    if (N >= 7 && N < PROTECTED_BLOCK_SIZE) {
      if (N <= protectedRemaining) {
        return { protectedDelta: N, flexibleDelta: 0 };
      }
      throw new Error("Saldo insuficiente en bloques del período.");
    }

    // ≥15: llenar protegido y desbordar a flexible
    let remaining = N;
    let protectedDelta = 0;
    let flexibleDelta = 0;

    if (remaining <= protectedRemaining) {
      protectedDelta = remaining;
      remaining = 0;
    } else {
      protectedDelta = protectedRemaining;
      remaining -= protectedRemaining;
    }

    if (remaining > 0) {
      if (remaining <= flexibleRemaining) {
        flexibleDelta = remaining;
      } else {
        throw new Error("Saldo insuficiente en bloques del período.");
      }
    }

    return { protectedDelta, flexibleDelta };
  }

  /**
   * Valida fraccionamiento art. 17 simulando el consumo FIFO por período
   * (cada tramo se imputa al período que realmente lo absorbe).
   */
  validateFractionAcrossPeriods(days, periods) {
    let remaining = Number(days);
    let requiresFractionAck = false;

    for (const p of periods || []) {
      if (remaining <= 0.001) break;
      if (p.record_met === false) continue;
      const avail = Number(
        p.available != null
          ? p.available
          : (Number(p.entitled_days) || 0) +
              (Number(p.adjusted_days) || 0) -
              (Number(p.used_days) || 0),
      );
      if (avail <= 0.001) continue;

      const take = Math.min(avail, remaining);
      const frac = this.validateFractionAgainstPeriod(take, p);
      if (!frac.valid) return frac;
      if (frac.requiresFractionAck) requiresFractionAck = true;
      remaining -= take;
    }

    if (remaining > 0.001) {
      return {
        valid: false,
        error: VACATION_MESSAGES.insufficientPeriod(days),
      };
    }
    return { valid: true, requiresFractionAck };
  }

  validateRequest({
    user = null,
    request,
    availableBalance = 0,
    existingActiveRequests = [],
    referenceDate,
    config = {},
    allowPast = false,
    primaryPeriod = null,
    fifoPeriods = null,
    fractionAcknowledged = false,
  }) {
    const errors = [];
    const warnings = [];
    const today = toDateOnly(referenceDate) || toDateOnly(new Date());
    const start = toDateOnly(request.startDate);
    const end = toDateOnly(request.endDate);
    const days = this.countRequestDays({ startDate: start, endDate: end });

    // Art. 10 D.L. 713: el descanso se gana al cumplir un año de servicios.
    // El proporcional del año en curso es trunco (liquidación), no días
    // pedibles, así que sin el año cumplido no hay solicitud posible.
    if (user && user.hire_date && !this.isEligible({
      hireDate: user.hire_date,
      referenceDate: today,
    })) {
      return {
        valid: false,
        errors: [VACATION_MESSAGES.notEligibleYet],
        warnings,
        days,
        requiresFractionAck: false,
      };
    }

    if (!start || !end) {
      errors.push(VACATION_MESSAGES.invalidDates);
      return { valid: false, errors, warnings, days: 0, requiresFractionAck: false };
    }
    if (end < start) {
      errors.push(VACATION_MESSAGES.endBeforeStart);
    }
    if (days <= 0) {
      errors.push(VACATION_MESSAGES.noDays);
    }
    if (!allowPast && start < today) {
      errors.push(VACATION_MESSAGES.pastDates);
    }

    const minNotice = Number(config.minNoticeDaysPE ?? 7);
    if (!allowPast && start >= today) {
      const noticeDays = countCalendarDays(addDays(today, 1), start);
      if (noticeDays < minNotice) {
        errors.push(VACATION_MESSAGES.minNotice(minNotice));
      }
    }

    const suggestedMin = Number(config.suggestedMinFractionDaysPE ?? 7);
    if (days < suggestedMin && days < availableBalance && days >= 1 && days <= 6) {
      warnings.push(VACATION_MESSAGES.policyWarning(suggestedMin, days));
    }

    if (days > availableBalance + 0.001) {
      errors.push(VACATION_MESSAGES.insufficientBalance(days, availableBalance));
    }

    const overlaps = existingActiveRequests.some((r) =>
      rangesOverlap(start, end, r.start_date, r.end_date),
    );
    if (overlaps) {
      errors.push(VACATION_MESSAGES.overlap);
    }

    let requiresFractionAck = days < ANNUAL_ENTITLEMENT;

    if (errors.length === 0) {
      let frac = null;
      if (Array.isArray(fifoPeriods) && fifoPeriods.length > 0) {
        frac = this.validateFractionAcrossPeriods(days, fifoPeriods);
      } else if (primaryPeriod) {
        frac = this.validateFractionAgainstPeriod(days, primaryPeriod);
      }
      if (frac) {
        if (!frac.valid) {
          errors.push(frac.error);
        } else {
          requiresFractionAck = Boolean(frac.requiresFractionAck);
        }
      }
    }

    if (requiresFractionAck && !fractionAcknowledged) {
      errors.push(VACATION_MESSAGES.fractionAckRequired);
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
      days,
      requiresFractionAck,
    };
  }
}

module.exports = PeruVacationStrategy;
