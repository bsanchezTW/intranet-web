/**
 * Visibilidad de la galería compartida.
 *
 * La regla de verdad está en las vistas chile.events / peru.events. Estas
 * funciones sirven al alta (leer el interruptor) y a /content (no entregar
 * un archivo de un evento que la vista no devuelve).
 */

function eventSlugFromContentPath(relativePath) {
  const clean = String(relativePath || "");
  if (!clean.startsWith("eventos/")) return null;
  const slug = clean.slice("eventos/".length).split("/")[0];
  return slug || null;
}

function isPrivateFlag(value) {
  const values = Array.isArray(value) ? value : [value];
  return values.some((item) =>
    ["1", "true", "on", "yes"].includes(String(item ?? "").trim().toLowerCase()),
  );
}

function hasPrivacyField(body = {}) {
  return (
    Object.prototype.hasOwnProperty.call(body, "is_private") ||
    Object.prototype.hasOwnProperty.call(body, "privado")
  );
}

/** Público para ambos países. Privado solo para el país que lo creó. */
function eventVisibleTo(event, countryCode) {
  if (!event || !event.is_private) return true;
  return (
    String(event.country_code || "").toUpperCase() ===
    String(countryCode || "").toUpperCase()
  );
}

module.exports = {
  eventSlugFromContentPath,
  isPrivateFlag,
  hasPrivacyField,
  eventVisibleTo,
};
