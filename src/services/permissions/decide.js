const logger = require("../../utils/logger");
const { LEGACY_RULES, hasLegacyRule } = require("./legacyRules");

/**
 * La única decisión de permisos de la intranet durante la migración.
 *
 *   modo 'aplicar' → decide Gestión de Permisos.
 *   modo 'sombra'  → si el permiso tiene regla antigua (legacyRules.js),
 *                    decide ésa y se anota cuando la nueva diría otra cosa.
 *                    Si no la tiene, decide la nueva (el módulo ya nació
 *                    con permisos o no tiene equivalente antiguo).
 *
 * Las diferencias se anotan una vez por persona, permiso y resultado (no en
 * cada petición) en el log `permisos.shadow` y en una lista corta que
 * muestra el resumen de Gestión de Permisos. Antes del arranque no se anota
 * nada: sin asignaciones, todo sería diferencia.
 */

const MAX_RECENT = 200;
const MAX_SEEN = 5000;
const seen = new Set();
const recent = [];

function reportMismatch({ perms, key, legacy, next, path }) {
  const id = `${perms.userId}|${key}|${legacy}|${next}`;
  if (seen.has(id)) return;
  if (seen.size >= MAX_SEEN) seen.clear();
  seen.add(id);
  const entry = { at: new Date(), userId: perms.userId, key, legacy, next, path: path || null };
  recent.unshift(entry);
  if (recent.length > MAX_RECENT) recent.length = MAX_RECENT;
  logger.warn(
    "permisos.shadow",
    `${key} · usuario #${perms.userId}: hoy ${legacy ? "sí" : "no"}, con permisos ${next ? "sí" : "no"}${path ? ` (${path})` : ""}`,
  );
}

/**
 * ¿Puede? `legacyCtx` es el contexto antiguo de la sesión (legacyRules.
 * legacyContext); `record` ({ ownerId, areaId }) si es sobre un registro.
 */
function decide(perms, key, legacyCtx, { record = null, path = null } = {}) {
  const next = record ? perms.canOnRecord(key, record) : perms.can(key);
  if (perms.mode === "aplicar" || !hasLegacyRule(key)) return next;
  const legacy = Boolean(LEGACY_RULES[key](legacyCtx || { active: false, admin: false }, record));
  if (legacy !== next && perms.bootstrapped) reportMismatch({ perms, key, legacy, next, path });
  return legacy;
}

/**
 * Filtro SQL de un listado con alcance. En sombra el listado sigue como
 * antes (`legacyClause`, por defecto sin filtro); al aplicar, el alcance del
 * permiso.
 */
function scopeFilter(perms, key, columns, { legacyClause = "TRUE" } = {}) {
  if (perms.mode === "aplicar") return perms.sqlFilter(key, columns);
  return { clause: legacyClause, params: [] };
}

/** Diferencias recientes de este proceso, para el resumen. */
function recentMismatches() {
  return recent.slice();
}

function resetMismatches() {
  seen.clear();
  recent.length = 0;
}

module.exports = {
  decide,
  scopeFilter,
  recentMismatches,
  resetMismatches,
};
