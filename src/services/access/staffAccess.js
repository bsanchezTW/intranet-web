const db = require("../../db");
const logger = require("../../utils/logger");
const { isAdministrador, normalizeRole } = require("../../constants/roles");
const { isSupportAreaName } = require("../../constants/supportArea");
const { isRrhhAreaName } = require("../../constants/rrhhArea");

/**
 * Permisos que dependen del área además del rol.
 *
 *   - Administrador de Informática → acceso total a la intranet (desarrollo).
 *   - Administrador de RRHH        → Administración de RRHH y colaboradores.
 *
 * Igual que la mesa de ayuda y Finanzas, el área se resuelve contra la base y
 * no contra la sesión: un cambio de área o de rol vale sin volver a entrar. La
 * lista cambia poco, así que se cachea unos segundos.
 */

const CACHE_TTL_MS = 60 * 1000;
const NO_ACCESS = Object.freeze({ informaticaAdmin: false, rrhhAdmin: false, canManageRrhh: false });
const FULL_ACCESS = Object.freeze({ informaticaAdmin: true, rrhhAdmin: false, canManageRrhh: true });

let cache = { expiresAt: 0, byUserId: new Map() };

/** Perfil de acceso de una fila usuario + área. Pura, para poder probarla. */
function accessProfile({ role, area_name: areaName } = {}) {
  if (!isAdministrador(normalizeRole(role))) return NO_ACCESS;
  const informaticaAdmin = isSupportAreaName(areaName);
  const rrhhAdmin = isRrhhAreaName(areaName);
  return { informaticaAdmin, rrhhAdmin, canManageRrhh: informaticaAdmin || rrhhAdmin };
}

/**
 * El login de emergencia de AUTH_USER/AUTH_PASS (id 0) no existe en `users`
 * ni tiene área: es la cuenta de desarrollo, así que conserva acceso total.
 */
function isMasterLogin(user) {
  return user.id === 0 && isAdministrador(normalizeRole(user.role));
}

async function fetchProfiles() {
  const { rows } = await db.query(
    `SELECT u.id, u.role, w.area_name
       FROM users u
       JOIN work_areas w ON w.id = u.work_area_id
      WHERE u.is_intranet_user = TRUE`,
  );
  const byUserId = new Map();
  for (const row of rows) {
    const profile = accessProfile(row);
    if (profile.canManageRrhh) byUserId.set(row.id, profile);
  }
  return byUserId;
}

/**
 * Perfil del usuario de sesión. Ante un error de BD se queda con el último
 * caché (vacío la primera vez): sin datos nadie gana permisos extra.
 */
async function profileFor(user) {
  if (!user || user.id == null) return NO_ACCESS;
  if (isMasterLogin(user)) return FULL_ACCESS;

  if (cache.expiresAt <= Date.now()) {
    try {
      cache = { expiresAt: Date.now() + CACHE_TTL_MS, byUserId: await fetchProfiles() };
    } catch (err) {
      logger.error("permisos", err);
    }
  }
  return cache.byUserId.get(user.id) || NO_ACCESS;
}

async function isInformaticaAdmin(user) {
  return (await profileFor(user)).informaticaAdmin;
}

async function isRrhhAdmin(user) {
  return (await profileFor(user)).rrhhAdmin;
}

/** ¿Puede ver y operar la Administración de RRHH y editar colaboradores? */
async function canManageRrhh(user) {
  return (await profileFor(user)).canManageRrhh;
}

/** Invalida el caché tras cambios de área, de rol o de personal. */
function invalidateStaffAccess() {
  cache = { expiresAt: 0, byUserId: new Map() };
}

module.exports = {
  accessProfile,
  isInformaticaAdmin,
  isRrhhAdmin,
  canManageRrhh,
  invalidateStaffAccess,
};
