/**
 * Categorías de los tickets de Soporte.
 *
 * En la base se guarda la clave; la etiqueta es lo que ve el usuario. La pista
 * describe qué problemas caen en cada una: la muestra el asistente al modelo
 * para que clasifique igual que lo haría una persona.
 *
 * Antes el formulario guardaba valores que no coincidían con lo que mostraba
 * (el valor `SAP` se veía como «Soporte técnico»). LEGACY_TICKET_CATEGORIES
 * lleva esos valores a las claves nuevas; la migración vive en
 * services/tickets/ticketSchema.js.
 */

const TICKET_CATEGORIES = Object.freeze([
  { key: "internet", label: "Internet y red", hint: "sin conexión, WiFi, VPN, red lenta, carpetas compartidas" },
  { key: "correo", label: "Correo electrónico", hint: "Outlook, correos que no llegan o no salen, buzón lleno" },
  { key: "impresoras", label: "Impresoras", hint: "no imprime, atascos, escáner, tóner" },
  { key: "equipos", label: "Computador y periféricos", hint: "PC o notebook, pantalla, teclado, mouse, cargador" },
  { key: "salesforce", label: "Salesforce", hint: "acceso, registros o reportes de Salesforce" },
  { key: "sap", label: "SAP", hint: "acceso, transacciones o errores de SAP" },
  { key: "cuentas", label: "Cuentas y contraseñas", hint: "clave bloqueada o vencida, permisos, cuentas nuevas" },
  { key: "intranet", label: "Intranet", hint: "errores o problemas de esta intranet" },
  { key: "otro", label: "Otro", hint: "cualquier otro requerimiento técnico" },
]);

const DEFAULT_TICKET_CATEGORY = "otro";

/** Valores guardados por el formulario anterior → clave actual. */
const LEGACY_TICKET_CATEGORIES = Object.freeze({
  SAP: "sap",
  Salesforce: "salesforce",
  Intranet: "intranet",
  Hardware: "equipos",
  Otro: "otro",
});

const BY_KEY = new Map(TICKET_CATEGORIES.map((category) => [category.key, category]));

/** Clave de categoría a partir de una clave, un valor antiguo o una etiqueta. null si no calza. */
function normalizeTicketCategory(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (BY_KEY.has(raw.toLowerCase())) return raw.toLowerCase();
  if (LEGACY_TICKET_CATEGORIES[raw]) return LEGACY_TICKET_CATEGORIES[raw];
  const byLabel = TICKET_CATEGORIES.find((category) => category.label.toLowerCase() === raw.toLowerCase());
  return byLabel ? byLabel.key : null;
}

/** Etiqueta para mostrar; un valor desconocido se muestra tal cual. */
function ticketCategoryLabel(value) {
  const key = normalizeTicketCategory(value);
  if (key) return BY_KEY.get(key).label;
  return String(value ?? "").trim() || "Sin clasificar";
}

module.exports = {
  TICKET_CATEGORIES,
  DEFAULT_TICKET_CATEGORY,
  LEGACY_TICKET_CATEGORIES,
  normalizeTicketCategory,
  ticketCategoryLabel,
};
