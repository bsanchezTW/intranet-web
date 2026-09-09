const db = require("../../db");
const logger = require("../../utils/logger");
const { ROLES_INTRANET_ACTIVOS, normalizeRole } = require("../../constants/roles");
const { isSupportAreaName } = require("../../constants/supportArea");

/**
 * Quién forma la mesa de ayuda.
 *
 * La sesión no guarda el área del usuario (y forzar un re-login para agregarla
 * dejaría fuera a todas las sesiones vivas), así que el área se resuelve contra
 * la base. La lista cambia poco —alta o baja de alguien en Informática—, de modo
 * que se cachea unos segundos para no consultar en cada request del modal.
 */

const CACHE_TTL_MS = 60 * 1000;

let cache = { expiresAt: 0, agents: [] };

/** Nombre visible del agente; `assigned_to` guarda texto, no un id. */
function agentDisplayName(row) {
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return full || row.email || `Usuario ${row.id}`;
}

async function fetchAgents() {
  // El filtro por nombre de área se hace en Node y no en SQL: los acentos y
  // mayúsculas de `area_name` los normaliza constants/supportArea.
  const { rows } = await db.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.role, w.area_name
       FROM users u
       JOIN work_areas w ON w.id = u.work_area_id
      WHERE u.is_intranet_user = TRUE
      ORDER BY u.first_name NULLS LAST, u.last_name NULLS LAST`,
  );

  return rows
    .filter((row) => isSupportAreaName(row.area_name))
    .filter((row) => ROLES_INTRANET_ACTIVOS.includes(normalizeRole(row.role)))
    .map((row) => ({
      id: row.id,
      name: agentDisplayName(row),
      email: row.email || null,
    }));
}

/**
 * Personal de Informática habilitado para gestionar tickets.
 * Ante un error de BD devuelve la lista vacía: sin equipo resuelto nadie
 * gestiona, que es más seguro que abrir la gestión a cualquiera.
 */
async function listSupportAgents({ force = false } = {}) {
  if (!force && cache.expiresAt > Date.now()) return cache.agents;

  try {
    const agents = await fetchAgents();
    cache = { expiresAt: Date.now() + CACHE_TTL_MS, agents };
    return agents;
  } catch (err) {
    logger.error("tickets", err);
    return cache.agents;
  }
}

/** ¿Este usuario de sesión pertenece a la mesa de ayuda? */
async function isSupportAgent(user) {
  if (!user || user.id == null) return false;
  const agents = await listSupportAgents();
  return agents.some((agent) => agent.id === user.id);
}

/** Nombre con el que se registra la asignación de un agente. */
async function getAgentById(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return null;
  const agents = await listSupportAgents();
  return agents.find((agent) => agent.id === id) || null;
}

/** Invalida el caché tras cambios de área o de personal. */
function invalidateSupportTeam() {
  cache = { expiresAt: 0, agents: [] };
}

module.exports = {
  listSupportAgents,
  isSupportAgent,
  getAgentById,
  invalidateSupportTeam,
};
