/**
 * Revisión física de vehículos (Logística): catálogos, numeración y el aviso
 * de revisión pendiente. Puro, para el servicio, las vistas, el PDF y los
 * tests.
 *
 * Un daño (abolladura, rayón, parte rota) se registra en una revisión física
 * sobre una zona del modelo 3D y queda abierto hasta que Logística lo marca
 * reparado. Si la revisión se anula, sus daños quedan anulados.
 */

/** Por qué se hace la revisión. */
const REVIEW_REASONS = Object.freeze([
  { value: "incidente", label: "Después de un incidente" },
  { value: "periodica", label: "Revisión periódica" },
  { value: "otra", label: "Otra" },
]);

const DAMAGE_TYPES = Object.freeze([
  { value: "abolladura", label: "Abolladura" },
  { value: "rayon", label: "Rayón" },
  { value: "rotura", label: "Parte rota" },
  { value: "otro", label: "Otro" },
]);

const DAMAGE_STATES = Object.freeze({
  abierto: { label: "Abierto" },
  reparado: { label: "Reparado" },
  anulado: { label: "Anulado" },
});

/** Días sin revisión física después de los cuales se avisa «pendiente». */
const PHYSICAL_DUE_DAYS = 30;
/** Fotos por daño y por reparación. */
const MIN_PHOTOS = 1;
const MAX_PHOTOS = 4;
/** Daños nuevos en una misma revisión (cada uno con hasta 4 fotos). */
const MAX_DAMAGES = 12;
/** Lados del modelo que se capturan para el PDF. */
const CAPTURE_VIEWS = Object.freeze([
  { value: "izquierdo", label: "Lado izquierdo (conductor)" },
  { value: "derecho", label: "Lado derecho" },
  { value: "frente", label: "Frente" },
  { value: "atras", label: "Atrás" },
]);

const MAX_SEQ = 99999;

function formatPhysicalNumber(year, seq) {
  return `RF-${String(seq).padStart(5, "0")}-${year}`;
}

function labelOf(list, value) {
  const found = list.find((item) => item.value === value);
  return found ? found.label : value || "—";
}

function damageTypeLabel(value) {
  return labelOf(DAMAGE_TYPES, value);
}

function reasonLabel(value) {
  return labelOf(REVIEW_REASONS, value);
}

function damageStateLabel(value) {
  return (DAMAGE_STATES[value] || { label: value }).label;
}

function daysBetween(fromIso, toIso) {
  const a = Date.parse(`${String(fromIso).slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${String(toIso).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * Aviso de revisión física: null si está al día, o { state, detail } si no
 * tiene ninguna o la última tiene más de PHYSICAL_DUE_DAYS días.
 */
function physicalReviewAlert(lastDate, today) {
  if (!lastDate) return { state: "pendiente", detail: "nunca se ha hecho" };
  const days = daysBetween(lastDate, today);
  if (days == null || days <= PHYSICAL_DUE_DAYS) return null;
  return { state: "pendiente", detail: `la última fue hace ${days} días` };
}

module.exports = {
  REVIEW_REASONS,
  DAMAGE_TYPES,
  DAMAGE_STATES,
  PHYSICAL_DUE_DAYS,
  MIN_PHOTOS,
  MAX_PHOTOS,
  MAX_DAMAGES,
  CAPTURE_VIEWS,
  MAX_SEQ,
  formatPhysicalNumber,
  damageTypeLabel,
  reasonLabel,
  damageStateLabel,
  daysBetween,
  physicalReviewAlert,
};
