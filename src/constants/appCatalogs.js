/**
 * Catálogos de la tabla compartida `shared.applications` (vistas
 * `chile.applications` / `peru.applications`).
 *
 * Las apps corporativas (`/apps`) y las herramientas de autoayuda de la zona de
 * Soporte (`/soporte`) comparten forma: nombre, descripción, icono y
 * enlaces por plataforma. Separarlas en dos tablas obligaría a duplicar el CRUD,
 * la subida de iconos, el QR y los modales; separarlas por catálogo mantiene una
 * sola implementación y deja la puerta abierta a un tercer grupo sin migrar nada.
 */

const APP_CATALOGS = {
  /** Aplicaciones comerciales / corporativas — vista "Apps". */
  CORPORATE: "corporate",
  /** Herramientas de autoayuda de TI — vista "Soporte". */
  SUPPORT: "support",
};

const APP_CATALOG_VALUES = Object.values(APP_CATALOGS);

const DEFAULT_APP_CATALOG = APP_CATALOGS.CORPORATE;

/** Página que lista cada catálogo, para redirigir tras crear/editar/eliminar. */
const APP_CATALOG_PATHS = {
  [APP_CATALOGS.CORPORATE]: "/apps",
  [APP_CATALOGS.SUPPORT]: "/soporte",
};

/** Devuelve un catálogo válido; cualquier valor desconocido cae al corporativo. */
function normalizeAppCatalog(value) {
  const catalog = String(value || "").trim().toLowerCase();
  return APP_CATALOG_VALUES.includes(catalog) ? catalog : DEFAULT_APP_CATALOG;
}

/** Ruta de la vista que lista el catálogo indicado. */
function appCatalogPath(value) {
  return APP_CATALOG_PATHS[normalizeAppCatalog(value)];
}

module.exports = {
  APP_CATALOGS,
  APP_CATALOG_VALUES,
  DEFAULT_APP_CATALOG,
  APP_CATALOG_PATHS,
  normalizeAppCatalog,
  appCatalogPath,
};
