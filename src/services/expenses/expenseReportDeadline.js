/**
 * Plazo para rendir un fondo: 1 día hábil de gracia tras el fin del viaje y
 * luego 5 días hábiles (lunes a viernes, sin feriados) para enviar la
 * rendición. Un reembolso sin fondo no tiene este reloj.
 *
 * Si Finanzas aprueba el fondo después de que el viaje ya terminó, el 1+5
 * parte de esa aprobación: un fondo aprobado tarde no nace vencido.
 */

const {
  addDays,
  isWeekend,
  zonedDateOnly,
  todayInCountry,
} = require("../../utils/vacationDateUtils");
const { getTimezone } = require("../../config/country");

const GRACE_BUSINESS_DAYS = 1;
const REPORT_BUSINESS_DAYS = 5;

/** Fecha de calendario YYYY-MM-DD. DATE de pg se lee en local, no en UTC. */
function asDateOnly(value) {
  if (!value) return null;
  if (typeof value === "string") {
    const raw = value.trim();
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return null;
}

function addBusinessDays(from, n) {
  const start = asDateOnly(from);
  if (!start || !Number.isInteger(n) || n <= 0) return start;
  let current = start;
  let counted = 0;
  while (counted < n) {
    current = addDays(current, 1);
    if (!isWeekend(current)) counted += 1;
  }
  return current;
}

function approvalDate(financeReviewedAt) {
  if (!financeReviewedAt) return null;
  if (typeof financeReviewedAt === "string") {
    const raw = financeReviewedAt.trim();
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : null;
  }
  return zonedDateOnly(financeReviewedAt, getTimezone());
}

/** Día desde el que se cuenta el 1+5. */
function clockOrigin(periodEnd, financeReviewedAt) {
  const tripEnd = asDateOnly(periodEnd);
  if (!tripEnd) return null;
  const approvedOn = approvalDate(financeReviewedAt);
  if (approvedOn && approvedOn > tripEnd) return approvedOn;
  return tripEnd;
}

/** Último día hábil en que el colaborador puede rendir. Null si no hay viaje. */
function reportDueOn(periodEnd, financeReviewedAt) {
  const origin = clockOrigin(periodEnd, financeReviewedAt);
  if (!origin) return null;
  const afterGrace = addBusinessDays(origin, GRACE_BUSINESS_DAYS);
  return addBusinessDays(afterGrace, REPORT_BUSINESS_DAYS);
}

function isReportOverdue(periodEnd, financeReviewedAt, today = todayInCountry()) {
  const due = reportDueOn(periodEnd, financeReviewedAt);
  if (!due) return false;
  return today > due;
}

function annotateFundDeadline(fund, today = todayInCountry()) {
  const due =
    fund.state === "por_rendir"
      ? reportDueOn(fund.period_end, fund.finance_reviewed_at)
      : null;
  return {
    ...fund,
    reportDueOn: due,
    overdue: !!(due && today > due),
  };
}

module.exports = {
  GRACE_BUSINESS_DAYS,
  REPORT_BUSINESS_DAYS,
  asDateOnly,
  addBusinessDays,
  clockOrigin,
  reportDueOn,
  isReportOverdue,
  annotateFundDeadline,
};
