const db = require("../../db");
const logger = require("../../utils/logger");
const permissions = require("../permissions/permissionService");

/**
 * Quién forma la mesa de ayuda: quien tiene «Asignar, priorizar y cerrar
 * tickets» (soporte.ticket.gestionar) en Gestión de Permisos. Antes era el
 * área Informática por su nombre; el arranque le dio ese permiso a esa área,
 * así que el equipo es el mismo, pero ahora se cambia desde /permisos.
 *
 * Se calcula con la foto de permisos en caché (no hay otro caché aquí): un
 * cambio vale en la siguiente petición.
 */

const GESTIONAR = "soporte.ticket.gestionar";

/** Nombre visible del agente; `assigned_to` guarda texto, no un id. */
function agentDisplayName(row) {
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return full || row.email || `Usuario ${row.id}`;
}

async function fetchAgents({ includeSuperadmins }) {
  const ids = await permissions.usersWhoCan(GESTIONAR, null, { includeSuperadmins });
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT u.id, u.first_name, u.last_name, u.email
       FROM users u
      WHERE u.id = ANY($1::int[]) AND u.is_intranet_user = TRUE
      ORDER BY u.first_name NULLS LAST, u.last_name NULLS LAST`,
    [ids],
  );
  return rows.map((row) => ({ id: Number(row.id), name: agentDisplayName(row), email: row.email || null }));
}

/**
 * La mesa de ayuda. Con `includeSuperadmins` entran también los superadmins
 * (pueden tomar o asignar tickets), pero no reciben los avisos del equipo.
 * Ante un error de BD devuelve la lista vacía: nadie gestiona, que es más
 * seguro que abrir la gestión a cualquiera.
 */
async function listSupportAgents({ includeSuperadmins = false } = {}) {
  try {
    return await fetchAgents({ includeSuperadmins });
  } catch (err) {
    logger.error("tickets", err);
    return [];
  }
}

/** ¿Gestiona tickets? (por permiso; el superadmin también). */
async function isSupportAgent(user) {
  if (!user || user.id == null) return false;
  const perms = await permissions.resolve(user);
  return perms.can(GESTIONAR);
}

/** Agente (o superadmin) por id, para registrar a quién se asigna un ticket. */
async function getAgentById(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return null;
  const agents = await listSupportAgents({ includeSuperadmins: true });
  return agents.find((agent) => agent.id === id) || null;
}

/** Ya no hay caché propio: se conserva para quien lo llama tras cambiar áreas. */
function invalidateSupportTeam() {}

/** Correos del personal de Informática (Chile y Perú: el equipo de esta instancia). */
async function supportAgentEmails() {
  const agents = await listSupportAgents();
  return [
    ...new Set(
      agents
        .map((agent) => String(agent.email || "").trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

module.exports = {
  listSupportAgents,
  isSupportAgent,
  getAgentById,
  supportAgentEmails,
  invalidateSupportTeam,
};
