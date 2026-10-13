const { toDateOnly, addDays } = require("../../../utils/vacationDateUtils");

/** Con cuánta anticipación se avisa que vence el plazo para gozar un período. */
const DUE_SOON_DAYS = 90;

/**
 * Contrato base para las estrategias de cálculo de vacaciones por país.
 * Cada país implementa sus reglas; las rutas/servicios nunca hacen
 * `if (country === 'CL')`, sino que delegan en la estrategia vía VacationEngine.
 */
class BaseVacationStrategy {
  getCountryCode() {
    throw new Error("getCountryCode no implementado");
  }

  /** Unidad de medida para la UI: 'business' | 'calendar' */
  getDayUnit() {
    throw new Error("getDayUnit no implementado");
  }

  /** Días que corresponden por un año completo de servicio. */
  getAnnualEntitlement(/* { yearsOfService, hireDate } */) {
    throw new Error("getAnnualEntitlement no implementado");
  }

  /** ¿El colaborador ya tiene derecho a vacaciones? */
  isEligible(/* { hireDate, referenceDate } */) {
    throw new Error("isEligible no implementado");
  }

  /** Días proporcionales si no cumplió el año completo. */
  getProportionalDays(/* { hireDate, referenceDate } */) {
    throw new Error("getProportionalDays no implementado");
  }

  /** Cuenta los días que consume una solicitud (según unidad del país). */
  countRequestDays(/* { startDate, endDate, holidays } */) {
    throw new Error("countRequestDays no implementado");
  }

  /**
   * Valida una solicitud antes de guardarla.
   * @returns {{ valid: boolean, errors: string[], days: number }}
   */
  validateRequest(/* { user, periods, request, holidays, existingRequests, config } */) {
    throw new Error("validateRequest no implementado");
  }

  /** Fecha límite para tomar vacaciones devengadas de un período. */
  getExpirationDate(/* { periodEnd } */) {
    throw new Error("getExpirationDate no implementado");
  }

  /**
   * ¿El saldo de este período se puede pedir hoy?
   *
   * Separa "derecho generado" de "saldo disponible" (el período en curso
   * devenga proporcional, pero eso es trunco de liquidación, no días
   * pedibles). Por defecto todo período cuenta; cada país afina.
   */
  isPeriodClaimable(/* { period, referenceDate } */) {
    return true;
  }

  /**
   * Último día para gozar los días de un período sin incumplir la ley.
   * No es caducidad: el saldo sigue vivo. null = el país no lo controla.
   */
  getEnjoymentDeadline(/* { periodEnd } */) {
    return null;
  }

  /**
   * Estado del plazo de goce de un período con saldo `available`.
   * overdue: el plazo ya pasó y quedan días; dueSoon: vence dentro de
   * DUE_SOON_DAYS y quedan días.
   */
  getEnjoymentStatus({ period, available, referenceDate }) {
    const enjoyBy = this.getEnjoymentDeadline({ periodEnd: period?.period_end });
    const today = toDateOnly(referenceDate);
    const pending = Number(available) > 0.001;
    if (!enjoyBy || !today || !pending) {
      return { enjoyBy, overdue: false, dueSoon: false };
    }
    const overdue = today > enjoyBy;
    const dueSoon = !overdue && addDays(today, DUE_SOON_DAYS) >= enjoyBy;
    return { enjoyBy, overdue, dueSoon };
  }
}

module.exports = BaseVacationStrategy;
