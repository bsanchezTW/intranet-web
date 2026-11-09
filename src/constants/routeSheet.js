/**
 * Hojas de ruta (Logística): estados, numeración y horas. Puro, para usarlo
 * en el servicio, las vistas, el PDF y los tests.
 */

const { getCountryConfig } = require("../config/country");

/** Una hoja se abre en la mañana, se cierra con el km final o se anula. */
const STATUSES = Object.freeze({
  open: { key: "open", label: "En ruta" },
  closed: { key: "closed", label: "Cerrada" },
  voided: { key: "voided", label: "Anulada" },
});

const MAX_SEQ = 99999;

/**
 * Firmas electrónicas de la hoja cerrada, en el orden en que se muestran.
 * La peoneta firma sólo si la hoja la tiene.
 */
const SIGNATURE_ROLES = Object.freeze([
  { role: "conductor", label: "Conductor" },
  { role: "peoneta", label: "Peoneta" },
  { role: "logistica", label: "Revisión de Logística" },
]);

/** "7F3A-91C2": los primeros 8 caracteres de la huella, para leerla rápido. */
function formatSignatureCode(hash) {
  const h = String(hash || "").toUpperCase();
  return h ? `${h.slice(0, 4)}-${h.slice(4, 8)}` : "";
}

// La hoja en papel trae 10 filas; en la intranet caben más, con un tope para
// que la hoja siga entrando en el PDF.
const MAX_STOPS = 30;

/** HR-00001-2026 */
function formatRouteSheetNumber(year, seq) {
  return `HR-${String(seq).padStart(5, "0")}-${year}`;
}

function statusLabel(status) {
  return (STATUSES[status] || { label: status || "" }).label;
}

/** "Comuna" en Chile, "Distrito" en Perú. */
function localityLabel(countryCode) {
  return getCountryConfig(countryCode).locality.label;
}

/** "la comuna" / "el distrito", para los mensajes. */
function localityWithArticle(countryCode) {
  const { label, article } = getCountryConfig(countryCode).locality;
  return `${article} ${label.toLowerCase()}`;
}

/**
 * Hora del día en 24 horas: "9:05", "09:05" o "0905" quedan "09:05"; lo que
 * no es una hora válida devuelve null. Postgres guarda "09:05:00" y también
 * se acepta.
 */
function parseTime(value) {
  const raw = String(value ?? "").trim();
  const m = raw.match(/^(\d{1,2})[:.h]?(\d{2})(?::00)?$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** "09:05:00" de Postgres → "09:05"; sin hora, "—". */
function formatTime(value) {
  return parseTime(value) || "—";
}

module.exports = {
  STATUSES,
  MAX_SEQ,
  MAX_STOPS,
  SIGNATURE_ROLES,
  formatSignatureCode,
  formatRouteSheetNumber,
  statusLabel,
  localityLabel,
  localityWithArticle,
  parseTime,
  formatTime,
};
