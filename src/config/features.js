/**
 * Capacidades disponibles por país.
 *
 * Una feature responde "¿esta instancia tiene esta capacidad?", no "¿esta
 * instancia es Perú?". Así la lógica funcional deja de depender de la
 * geografía y agregar un país es completar una columna, no repartir ifs.
 *
 * OJO: una feature apagada no es solo ocultar el botón. Hay que proteger
 * también la ruta y la operación de backend — para eso está requireFeature en
 * middlewares/requireFeature.js.
 *
 * Las diferencias que NO son features:
 *   - mismo comportamiento con otros valores  → config/country.js
 *   - misma capacidad con otras reglas        → policy (p. ej. VacationEngine)
 */

const { COUNTRY_CODES, getCurrentCountry } = require("./country");

/** Claves de capacidad. Toda clave debe declararse para TODOS los países. */
const FEATURE_KEYS = [
  "linkedinFeed",
  "chileUfIndicator",
  "lunchMenu",
  "claudeAssistant",
  "supportTickets",
  "homeQuickAccess",
  "chileHrPortals",
  "expenseCenter",
  "expenseRequests",
  "vacations",
];

const FEATURE_MATRIX = {
  CL: {
    // Feed de comunicaciones LinkedIn (tabla linkedin_posts + OAuth).
    linkedinFeed: true,
    // Contador UF en home (mindicador.cl; indicador chileno).
    chileUfIndicator: true,
    // Menú semanal del casino en el home.
    lunchMenu: true,
    // Asistente Claude (FAB + /claude).
    claudeAssistant: true,
    // Ticketera de Soporte (/soporte).
    supportTickets: true,
    // Barra de accesos rápidos del home (sitio, Academy, Rex+, ACHS, Caja).
    homeQuickAccess: true,
    // Portales RRHH chilenos: Rex+, ACHS y Caja Los Andes (home, menú, footer).
    chileHrPortals: true,
    // Centro de gastos: centros de costo en RRHH y base del módulo de gastos.
    expenseCenter: true,
    // Rendiciones y solicitudes de fondos (/gastos y sección Finanzas de
    // Procesos).
    expenseRequests: true,
    // Vacaciones de la intranet: en Chile se solicitan en Rex+.
    vacations: false,
  },
  PE: {
    // Sin tabla linkedin_posts ni tokens; no se sincroniza el feed.
    linkedinFeed: false,
    // UF es un indicador chileno; no aplica en la home de Perú.
    chileUfIndicator: false,
    // El casino / menú de almuerzo es de la oficina de Chile.
    lunchMenu: false,
    // Asistente Claude (FAB + /claude). El catálogo oculta tickets si Soporte está apagado.
    claudeAssistant: true,
    // Perú no opera ticketera ni mesa de ayuda en esta intranet.
    supportTickets: false,
    // Barra de accesos rápidos del home: sitio y Academy. Rex+, ACHS y Caja
    // siguen apagados con chileHrPortals; Tickets, con supportTickets.
    homeQuickAccess: true,
    // Rex+, ACHS y Caja Los Andes son portales chilenos; no se ofrecen en Perú.
    chileHrPortals: false,
    // Centros de costo en RRHH. No es la sección Finanzas de Procesos.
    expenseCenter: true,
    // Rendiciones y la sección Finanzas de Procesos son sólo de Chile.
    expenseRequests: false,
    // Solicitud y gestión de vacaciones: el módulo se desarrolla para Perú.
    vacations: true,
  },
};

// Chequeo de exhaustividad al cargar: equivale al Record<Country, Record<Key,
// bool>> de TypeScript. Si alguien agrega una feature y olvida un país, la app
// no arranca en vez de comportarse de forma indefinida en producción.
for (const code of COUNTRY_CODES) {
  const config = FEATURE_MATRIX[code];
  if (!config) {
    throw new Error(`FEATURE_MATRIX no declara el país ${code}.`);
  }
  const missing = FEATURE_KEYS.filter((key) => typeof config[key] !== "boolean");
  if (missing.length) {
    throw new Error(
      `FEATURE_MATRIX[${code}] no declara: ${missing.join(", ")}.`,
    );
  }
  const unknown = Object.keys(config).filter((key) => !FEATURE_KEYS.includes(key));
  if (unknown.length) {
    throw new Error(
      `FEATURE_MATRIX[${code}] declara claves que no están en FEATURE_KEYS: ${unknown.join(", ")}.`,
    );
  }
}

function getFeatures(countryCode = getCurrentCountry()) {
  const code = String(countryCode || "").toUpperCase();
  const features = FEATURE_MATRIX[code];
  if (!features) {
    throw new Error(`País sin features declaradas: ${countryCode}`);
  }
  return features;
}

function isFeatureEnabled(feature, countryCode = getCurrentCountry()) {
  if (!FEATURE_KEYS.includes(feature)) {
    throw new Error(
      `Feature desconocida: "${feature}". Agrégala a FEATURE_KEYS y a todos los países.`,
    );
  }
  return getFeatures(countryCode)[feature];
}

/** Lanza si la capacidad no existe en esta instancia. Para backend/jobs. */
function requireFeature(feature, countryCode = getCurrentCountry()) {
  if (!isFeatureEnabled(feature, countryCode)) {
    const err = new Error(
      `La funcionalidad "${feature}" no está disponible en ${countryCode}.`,
    );
    err.code = "FEATURE_DISABLED";
    err.feature = feature;
    throw err;
  }
}

module.exports = {
  FEATURE_KEYS,
  FEATURE_MATRIX,
  getFeatures,
  isFeatureEnabled,
  requireFeature,
};
