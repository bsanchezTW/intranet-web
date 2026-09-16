const db = require("../../db");
const logger = require("../../utils/logger");
const { isAdministrador, normalizeRole } = require("../../constants/roles");
const { isFinanceAreaName } = require("../../constants/financeArea");
const { isInformaticaAdmin } = require("../access/staffAccess");

/**
 * Quién aprueba en la etapa de Finanzas.
 *
 * Mismo problema que la mesa de ayuda: la sesión no guarda el área del usuario
 * (y forzar un re-login para agregarla dejaría fuera a todas las sesiones
 * vivas), así que el área se resuelve contra la base y se cachea unos segundos.
 *
 * A diferencia de tickets, aquí hacen falta las DOS condiciones: pertenecer a
 * Finanzas y tener rol Administrador. El área sola dejaría liquidar a cualquier
 * asistente del departamento; el rol solo le abriría las rendiciones de toda la
 * empresa a un administrador de Marketing.
 */

const CACHE_TTL_MS = 60 * 1000;

let cache = { expiresAt: 0, approvers: [] };

function displayName(row) {
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return full || row.email || `Usuario ${row.id}`;
}

async function fetchApprovers() {
  // El filtro por nombre de área se hace en Node y no en SQL: los acentos y
  // mayúsculas de `area_name` los normaliza constants/workAreas.
  const { rows } = await db.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.role, w.area_name
       FROM users u
       JOIN work_areas w ON w.id = u.work_area_id
      WHERE u.is_intranet_user = TRUE
      ORDER BY u.first_name NULLS LAST, u.last_name NULLS LAST`,
  );

  return rows
    .filter((row) => isFinanceAreaName(row.area_name))
    .filter((row) => isAdministrador(normalizeRole(row.role)))
    .map((row) => ({
      id: row.id,
      name: displayName(row),
      email: row.email || null,
    }));
}

/**
 * Aprobadores de Finanzas habilitados.
 * Ante un error de BD devuelve el caché previo (vacío la primera vez): sin
 * equipo resuelto nadie aprueba, que es más seguro que abrir la liquidación.
 */
async function listFinanceApprovers({ force = false } = {}) {
  if (!force && cache.expiresAt > Date.now()) return cache.approvers;

  try {
    const approvers = await fetchApprovers();
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, approvers };
    return approvers;
  } catch (err) {
    logger.error("gastos", err);
    return cache.approvers;
  }
}

/** ¿Este usuario de sesión aprueba en Finanzas? */
async function isFinanceApprover(user) {
  if (!user || user.id == null) return false;
  // Informática tiene acceso total a la intranet, también a esta etapa.
  if (await isInformaticaAdmin(user)) return true;
  const approvers = await listFinanceApprovers();
  return approvers.some((approver) => approver.id === user.id);
}

/** Correos a los que avisar cuando una solicitud llega a Finanzas. */
async function financeApproverEmails() {
  const approvers = await listFinanceApprovers();
  return approvers.map((a) => a.email).filter(Boolean);
}

/** Invalida el caché tras cambios de área, de rol o de personal. */
function invalidateFinanceTeam() {
  cache = { expiresAt: 0, approvers: [] };
}

module.exports = {
  listFinanceApprovers,
  isFinanceApprover,
  financeApproverEmails,
  invalidateFinanceTeam,
};
