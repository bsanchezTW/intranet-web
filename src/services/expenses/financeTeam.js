const db = require("../../db");
const logger = require("../../utils/logger");
const { isAdministrador, normalizeRole } = require("../../constants/roles");
const { financeAreaIds } = require("../../constants/financeArea");
const { isInformaticaAdmin } = require("../access/staffAccess");

/**
 * Quién aprueba en la etapa de Finanzas.
 *
 * Mismo problema que la mesa de ayuda: la sesión no guarda el área del usuario
 * (y forzar un re-login para agregarla dejaría fuera a todas las sesiones
 * vivas), así que el área se resuelve contra la base y se cachea unos segundos.
 *
 * A diferencia de tickets, aquí hacen falta las DOS condiciones: pertenecer a
 * Finanzas (o a un área que dependa de ella) y tener rol Administrador. El área sola dejaría liquidar a cualquier
 * asistente del departamento; el rol solo le abriría las rendiciones de toda la
 * empresa a un administrador de Marketing.
 */

const CACHE_TTL_MS = 60 * 1000;

let cache = { expiresAt: 0, approvers: [], staffIds: new Set() };

function displayName(row) {
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return full || row.email || `Usuario ${row.id}`;
}

async function fetchTeam() {
  // El filtro por área se hace en Node y no en SQL: los acentos y mayúsculas
  // de `area_name` los normaliza constants/workAreas, y las sub-áreas de
  // Finanzas salen del recorrido del organigrama.
  const [areasResult, usersResult] = await Promise.all([
    db.query("SELECT id, area_name, parent_area_id FROM work_areas"),
    db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.work_area_id
         FROM users u
        WHERE u.is_intranet_user = TRUE AND u.work_area_id IS NOT NULL
        ORDER BY u.first_name NULLS LAST, u.last_name NULLS LAST`,
    ),
  ]);
  const finanzas = financeAreaIds(areasResult.rows);
  const staff = usersResult.rows.filter((row) => finanzas.has(Number(row.work_area_id)));

  return {
    // Todo el personal de Finanzas, con cualquier rol (letras de cambio).
    staffIds: new Set(staff.map((row) => row.id)),
    // Sólo los administradores aprueban la etapa de Finanzas.
    approvers: staff
      .filter((row) => isAdministrador(normalizeRole(row.role)))
      .map((row) => ({
        id: row.id,
        name: displayName(row),
        email: row.email || null,
      })),
  };
}

/**
 * Equipo de Finanzas resuelto y cacheado. Ante un error de BD devuelve el
 * caché previo (vacío la primera vez): sin equipo resuelto nadie entra, que
 * es más seguro que abrir la liquidación.
 */
async function loadTeam({ force = false } = {}) {
  if (!force && cache.expiresAt > Date.now()) return cache;

  try {
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, ...(await fetchTeam()) };
  } catch (err) {
    logger.error("gastos", err);
  }
  return cache;
}

/** Aprobadores de Finanzas habilitados. */
async function listFinanceApprovers({ force = false } = {}) {
  return (await loadTeam({ force })).approvers;
}

/** ¿Este usuario de sesión aprueba en Finanzas? */
async function isFinanceApprover(user) {
  if (!user || user.id == null) return false;
  // Informática tiene acceso total a la intranet, también a esta etapa.
  if (await isInformaticaAdmin(user)) return true;
  const approvers = await listFinanceApprovers();
  return approvers.some((approver) => approver.id === user.id);
}

/**
 * ¿Trabaja en Finanzas (o en un área que dependa de ella), con cualquier rol?
 * Es el criterio de las letras de cambio: emitir una letra es trabajo del
 * área, no una aprobación, así que el asistente también la emite.
 */
async function isFinanceStaff(user) {
  if (!user || user.id == null) return false;
  if (await isInformaticaAdmin(user)) return true;
  return (await loadTeam()).staffIds.has(user.id);
}

/** Correos a los que avisar cuando una solicitud llega a Finanzas. */
async function financeApproverEmails() {
  const approvers = await listFinanceApprovers();
  return approvers.map((a) => a.email).filter(Boolean);
}

/** Invalida el caché tras cambios de área, de rol o de personal. */
function invalidateFinanceTeam() {
  cache = { expiresAt: 0, approvers: [], staffIds: new Set() };
}

module.exports = {
  listFinanceApprovers,
  isFinanceApprover,
  isFinanceStaff,
  financeApproverEmails,
  invalidateFinanceTeam,
};
