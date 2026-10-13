const db = require("../../db");
const { resolveApproverFromChain } = require("../workAreaTree");
const { isDeshabilitado } = require("../../constants/roles");

/**
 * Jefatura de área: quién aprueba en la primera etapa de fondos y vacaciones.
 *
 * Un área tiene a lo más un jefe (work_areas.manager_user_id), que puede no
 * pertenecer a ella: un gerente dirige varias áreas desde la suya. Las áreas
 * forman un organigrama (parent_area_id): si el
 * área no tiene jefe, aprueba el del ancestro más cercano que sí lo tenga. Sin
 * ningún jefe en la cadena no se puede solicitar: la solicitud quedaría
 * pendiente para siempre.
 *
 * Caso borde que decide todo el diseño: cuando quien solicita ES el jefe, no
 * puede aprobarse a sí mismo y la solicitud sube al jefe del área padre. Si
 * no hay nadie más arriba, nace sin aprobador y la resuelve un administrador
 * (ver requiresAdminApproval).
 */

function displayName(row) {
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return full || row.email || `Usuario ${row.id}`;
}

const NO_MANAGER_ERROR =
  "Ni tu área ni las áreas superiores del organigrama tienen un jefe asignado. Pídele a RRHH que designe uno antes de enviar solicitudes.";
const NO_AREA_ERROR = "No tienes un área asignada. Pídele a RRHH que te asigne una.";

/** Nodos del organigrama: la tabla es chica y el recorrido se hace en memoria. */
async function loadAreaNodes() {
  const { rows } = await db.query(
    "SELECT id, area_name, parent_area_id, manager_user_id FROM work_areas",
  );
  return rows;
}

/**
 * Un jefe deshabilitado (o fuera de la intranet) no puede iniciar sesión: una
 * solicitud asignada a él quedaría pendiente para siempre.
 */
function isAvailableApprover(row) {
  return Boolean(row) && row.is_intranet_user !== false && !isDeshabilitado(row.role);
}

function unavailableError(name) {
  return `${name}, quien debe aprobar tu solicitud, no está disponible para atenderla. Pídele a RRHH que habilite su cuenta o designe otro jefe.`;
}

async function getUserSummary(userId) {
  const { rows } = await db.query(
    "SELECT id, first_name, last_name, email, role, is_intranet_user FROM users WHERE id = $1",
    [userId],
  );
  if (!rows.length) return null;
  return {
    id: rows[0].id,
    name: displayName(rows[0]),
    email: rows[0].email || null,
    available: isAvailableApprover(rows[0]),
  };
}

/** Jefe directo del área, o null si no tiene. */
async function getAreaManager(areaId) {
  const id = Number(areaId);
  if (!Number.isInteger(id)) return null;

  const { rows } = await db.query(
    `SELECT u.id, u.first_name, u.last_name, u.email
       FROM work_areas w
       JOIN users u ON u.id = w.manager_user_id
      WHERE w.id = $1`,
    [id],
  );
  if (!rows.length) return null;
  return {
    id: rows[0].id,
    name: displayName(rows[0]),
    email: rows[0].email || null,
  };
}

/** Áreas que este usuario tiene a cargo. Vacío si no es jefe de ninguna. */
async function listManagedAreas(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id)) return [];

  const { rows } = await db.query(
    `SELECT id, area_name, color
       FROM work_areas
      WHERE manager_user_id = $1
      ORDER BY area_name ASC`,
    [id],
  );
  return rows;
}

async function listManagedAreaIds(userId) {
  return (await listManagedAreas(userId)).map((a) => a.id);
}

/** ¿Este usuario es jefe de al menos un área? */
async function isAreaManager(user) {
  if (!user || user.id == null) return false;
  const { rows } = await db.query(
    "SELECT 1 FROM work_areas WHERE manager_user_id = $1 LIMIT 1",
    [user.id],
  );
  return rows.length > 0;
}

/**
 * Aprobador de la primera etapa para una solicitud nueva, subiendo por el
 * organigrama desde el área del solicitante.
 *
 *   { ok: false, error }                   → nadie en la cadena tiene jefe.
 *   { ok: false, error, unavailable }      → el jefe que toca está deshabilitado;
 *                                            `unavailable` es ese jefe.
 *   { ok: true, managerId, requiresAdmin } → managerId null + requiresAdmin
 *                                            cuando el solicitante es el único
 *                                            jefe de su cadena.
 */
async function resolveApprover(requesterId, areaId) {
  const resolved = resolveApproverFromChain(await loadAreaNodes(), areaId, requesterId);
  if (!resolved.ok) {
    return {
      ok: false,
      error: resolved.reason === "no_area" ? NO_AREA_ERROR : NO_MANAGER_ERROR,
    };
  }
  if (resolved.requiresAdmin) {
    return { ok: true, managerId: null, requiresAdmin: true, manager: null };
  }

  const manager = await getUserSummary(resolved.managerId);
  if (!manager) return { ok: false, error: NO_MANAGER_ERROR };
  if (!manager.available) {
    return { ok: false, error: unavailableError(manager.name), unavailable: manager };
  }
  return {
    ok: true,
    managerId: manager.id,
    requiresAdmin: false,
    manager,
    approverAreaId: resolved.approverAreaId,
  };
}

/**
 * Área del usuario más quién le aprueba. Es lo que Procesos y Gastos
 * necesitan para decidir si habilitan los botones de solicitud.
 *
 * `manager` es el aprobador efectivo según el organigrama (puede ser el jefe
 * de un área superior); `requiresAdmin` indica que no hay jefe por encima del
 * solicitante y lo resolverá un administrador. `blockedReason` explica por qué
 * no puede solicitar cuando el área tiene jefe pero no está disponible.
 */
async function getUserAreaContext(userId) {
  const empty = {
    area: null,
    manager: null,
    isManager: false,
    requiresAdmin: false,
    unavailableManager: null,
    blockedReason: null,
  };
  const id = Number(userId);
  if (!Number.isInteger(id)) return empty;

  const { rows } = await db.query(
    `SELECT w.id AS area_id, w.area_name, w.color, w.manager_user_id
       FROM users u
       JOIN work_areas w ON w.id = u.work_area_id
      WHERE u.id = $1`,
    [id],
  );
  if (!rows.length) return empty;

  const row = rows[0];
  const area = { id: row.area_id, area_name: row.area_name, color: row.color };
  const approver = await resolveApprover(id, row.area_id);

  return {
    area,
    manager: approver.ok ? approver.manager : null,
    isManager: Number(row.manager_user_id) === id,
    requiresAdmin: approver.ok && approver.requiresAdmin,
    unavailableManager: approver.unavailable || null,
    blockedReason: approver.ok ? null : approver.error,
  };
}

/**
 * Una solicitud pendiente sin jefe asignado es la de alguien que no tiene
 * jefe por encima en el organigrama: la resuelve un administrador.
 */
function requiresAdminApproval(request) {
  return request.status === "pending" && request.manager_user_id == null;
}

module.exports = {
  getAreaManager,
  listManagedAreas,
  listManagedAreaIds,
  isAreaManager,
  getUserAreaContext,
  resolveApprover,
  requiresAdminApproval,
  isAvailableApprover,
};
