/**
 * Historial de vacaciones anteriores a la intranet.
 *
 * Un registro histórico NO es una solicitud: describe días que el colaborador
 * ya se tomó antes de que la intranet administrara sus vacaciones. Por eso no
 * tiene estados (pendiente/aprobada/…) sino un origen y, cuando se conoce, un
 * rango de fechas. Ver services/vacations/vacationHistoryService.js.
 */

/** De dónde salió el registro. */
const HISTORY_ORIGIN = {
  MANUAL: "MANUAL",
  IMPORTED: "IMPORTED",
  ADJUSTMENT: "ADJUSTMENT",
};

const ALL_HISTORY_ORIGINS = Object.values(HISTORY_ORIGIN);

const HISTORY_ORIGIN_LABELS = {
  MANUAL: "Manual",
  IMPORTED: "Importado",
  ADJUSTMENT: "Ajuste",
};

/** Badge por origen; reutiliza los matices de vacaciones.css. */
const HISTORY_ORIGIN_BADGE = {
  MANUAL: "vac-badge vac-badge-progress",
  IMPORTED: "vac-badge vac-badge-completed",
  ADJUSTMENT: "vac-badge vac-badge-pending",
};

/**
 * Detalle del registro. "Resumido" es el caso normal del Excel de RRHH:
 * año, mes y cantidad de días, sin fechas exactas. Nunca se inventan fechas
 * para rellenar el esquema.
 */
const HISTORY_DETAIL = {
  SUMMARY: "SUMMARY",
  DETAILED: "DETAILED",
};

const HISTORY_DETAIL_LABELS = {
  SUMMARY: "Histórico resumido",
  DETAILED: "Histórico detallado",
};

const MONTH_NAMES = [
  "Enero",
  "Febrero",
  "Marzo",
  "Abril",
  "Mayo",
  "Junio",
  "Julio",
  "Agosto",
  "Septiembre",
  "Octubre",
  "Noviembre",
  "Diciembre",
];

/** Año mínimo aceptado en un registro histórico (antigüedad razonable). */
const MIN_HISTORY_YEAR = 1980;

function historyOriginLabel(origin) {
  return HISTORY_ORIGIN_LABELS[origin] || origin;
}

function historyOriginBadge(origin) {
  return HISTORY_ORIGIN_BADGE[origin] || "vac-badge";
}

function monthLabel(month) {
  const n = Number(month);
  if (!Number.isInteger(n) || n < 1 || n > 12) return null;
  return MONTH_NAMES[n - 1];
}

/**
 * Convierte lo que venga en la columna "mes" del Excel a 1–12.
 * Acepta número (3), nombre ("Marzo", "marzo", "MARZO") y abreviatura
 * ("mar", "Set" / "Sep" por setiembre, que es como se escribe en Perú).
 */
const MONTH_ALIASES = new Map();
MONTH_NAMES.forEach((name, index) => {
  const n = index + 1;
  const plain = normalizeMonthKey(name);
  MONTH_ALIASES.set(plain, n);
  MONTH_ALIASES.set(plain.slice(0, 3), n);
});
// Setiembre: grafía habitual en Perú para septiembre.
MONTH_ALIASES.set("setiembre", 9);
MONTH_ALIASES.set("set", 9);

function normalizeMonthKey(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

function parseMonth(value) {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isInteger(value)) {
    return value >= 1 && value <= 12 ? value : null;
  }
  const raw = String(value).trim();
  if (/^\d{1,2}$/.test(raw)) {
    const n = Number(raw);
    return n >= 1 && n <= 12 ? n : null;
  }
  return MONTH_ALIASES.get(normalizeMonthKey(raw)) ?? null;
}

module.exports = {
  HISTORY_ORIGIN,
  ALL_HISTORY_ORIGINS,
  HISTORY_ORIGIN_LABELS,
  HISTORY_ORIGIN_BADGE,
  HISTORY_DETAIL,
  HISTORY_DETAIL_LABELS,
  MONTH_NAMES,
  MIN_HISTORY_YEAR,
  historyOriginLabel,
  historyOriginBadge,
  monthLabel,
  parseMonth,
};
