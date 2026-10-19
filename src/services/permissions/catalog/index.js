const { FEATURE_KEYS, getFeatures } = require("../../../config/features");
const { getCurrentCountry } = require("../../../config/country");
const { isScope } = require("../scopes");

/**
 * Catálogo de permisos: qué se puede conceder en la intranet. Vive en el
 * código porque cada permiso corresponde a una comprobación real en una ruta
 * o una vista; la base de cada país sólo guarda a quién se le asigna.
 *
 * Claves: `módulo.objeto.acción`, más `módulo.acceso` (entrar al módulo y
 * verlo en el menú) y `módulo.objeto.campo.dato` (un dato sensible).
 *
 * Un módulo o permiso con `feature` sólo existe en los países que la tienen
 * (config/features.js): fuera de ellos no aparece en Gestión de Permisos y
 * `can()` responde que no aunque quede una asignación vieja en la base.
 */

const MODULES = [
  require("./inicio"),
  require("./perfil"),
  require("./noticias"),
  require("./eventos"),
  require("./cursos"),
  require("./apps"),
  require("./casino"),
  require("./procesos"),
  require("./rrhh"),
  require("./organigrama"),
  require("./feriados"),
  require("./centrosCosto"),
  require("./vacaciones"),
  require("./gastos"),
  require("./letras"),
  require("./soporte"),
  require("./asistente"),
];

const KEY_PATTERN = /^[a-z_]+(\.[a-z_]+){1,3}$/;

/** Errores de forma del catálogo; vacío si está bien. Pura, para los tests. */
function validateCatalog(modules = MODULES) {
  const errors = [];
  const moduleCodes = new Set();
  const keys = new Set();

  for (const mod of modules) {
    if (!mod.module || !mod.label) errors.push(`Módulo sin código o etiqueta: ${JSON.stringify(mod)}`);
    if (moduleCodes.has(mod.module)) errors.push(`Módulo repetido: ${mod.module}`);
    moduleCodes.add(mod.module);
    if (mod.feature && !FEATURE_KEYS.includes(mod.feature)) {
      errors.push(`${mod.module}: feature desconocida "${mod.feature}"`);
    }
    if (!mod.permissions.some((p) => p.key === `${mod.module}.acceso`)) {
      errors.push(`${mod.module}: falta ${mod.module}.acceso`);
    }

    for (const perm of mod.permissions) {
      if (!KEY_PATTERN.test(perm.key)) errors.push(`Clave mal formada: ${perm.key}`);
      if (!perm.key.startsWith(`${mod.module}.`)) {
        errors.push(`${perm.key} no pertenece al módulo ${mod.module}`);
      }
      if (keys.has(perm.key)) errors.push(`Clave repetida: ${perm.key}`);
      keys.add(perm.key);
      if (!perm.label) errors.push(`${perm.key}: sin etiqueta`);
      if (perm.feature && !FEATURE_KEYS.includes(perm.feature)) {
        errors.push(`${perm.key}: feature desconocida "${perm.feature}"`);
      }
      for (const scope of perm.scopes || []) {
        if (!isScope(scope)) errors.push(`${perm.key}: alcance desconocido "${scope}"`);
      }
      if (isFieldKey(perm.key) && perm.scopes) {
        errors.push(`${perm.key}: un campo sensible no lleva alcance`);
      }
    }
  }
  return errors;
}

/** ¿Es un permiso de campo sensible (`módulo.objeto.campo.dato`)? */
function isFieldKey(key) {
  return String(key).split(".")[2] === "campo";
}

function describe(mod, perm) {
  const parts = perm.key.split(".");
  return Object.freeze({
    key: perm.key,
    label: perm.label,
    module: mod.module,
    object: parts.length > 2 ? parts[1] : null,
    scopes: perm.scopes ? Object.freeze([...perm.scopes]) : null,
    isField: isFieldKey(perm.key),
    isModuleAccess: perm.key === `${mod.module}.acceso`,
  });
}

const byCountry = new Map();

/**
 * Catálogo de un país: módulos y permisos cuya feature está encendida ahí.
 *   { modules: [{ module, label, permissions: [...] }], byKey: Map }
 */
function getCatalog(countryCode = getCurrentCountry()) {
  const code = String(countryCode).toUpperCase();
  if (byCountry.has(code)) return byCountry.get(code);

  const errors = validateCatalog();
  if (errors.length) throw new Error(`Catálogo de permisos inválido:\n${errors.join("\n")}`);

  const features = getFeatures(code);
  const on = (feature) => !feature || features[feature] === true;
  const byKey = new Map();
  const modules = [];
  for (const mod of MODULES) {
    if (!on(mod.feature)) continue;
    const permissions = mod.permissions.filter((p) => on(p.feature)).map((p) => describe(mod, p));
    for (const p of permissions) byKey.set(p.key, p);
    modules.push(Object.freeze({ module: mod.module, label: mod.label, permissions: Object.freeze(permissions) }));
  }

  const catalog = Object.freeze({ country: code, modules: Object.freeze(modules), byKey });
  byCountry.set(code, catalog);
  return catalog;
}

/** Definición del permiso en el país, o null si no existe ahí. */
function getPermission(key, countryCode) {
  return getCatalog(countryCode).byKey.get(key) || null;
}

/** Todas las claves de todos los países (para validar asignaciones y vistas). */
function allKeys() {
  return MODULES.flatMap((mod) => mod.permissions.map((p) => p.key));
}

module.exports = {
  MODULES,
  validateCatalog,
  isFieldKey,
  getCatalog,
  getPermission,
  allKeys,
};
