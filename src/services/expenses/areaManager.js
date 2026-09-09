const db = require("../../db");

/**
 * Jefatura de área: quién aprueba en la primera etapa del centro de gastos.
 *
 * Un área tiene a lo más un jefe (work_areas.manager_user_id) y ese jefe debe
 * pertenecer al área. Sin jefe no se puede rendir: dejar entrar la solicitud
 * sin aprobador la condenaría a quedarse pendiente para siempre.
 *
 * Caso borde que decide todo el diseño: cuando quien rinde ES el jefe del área,
 * no puede aprobarse a sí mismo. Esas solicitudes nacen sin manager_user_id y
 * las resuelve un administrador (ver requiresAdminApproval).
 */

function displayName(row) {
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return full || row.email || `Usuario ${row.id}`;
}

/** Jefe del área, o null si no tiene. */
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
 * Área del usuario más su jefatura, en una sola consulta. Es lo que la página
 * de Procesos necesita para decidir si habilita los botones de Finanzas.
 */
async function getUserAreaContext(userId) {
  const id = Number(userId);
  if (!Number.isInteger(id)) {
    return { area: null, manager: null, isManager: false };
  }

  const { rows } = await db.query(
    `SELECT w.id            AS area_id,
            w.area_name,
            w.color,
            w.manager_user_id,
            m.first_name    AS manager_first_name,
            m.last_name     AS manager_last_name,
            m.email         AS manager_email
       FROM users u
       JOIN work_areas w ON w.id = u.work_area_id
       LEFT JOIN users m ON m.id = w.manager_user_id
      WHERE u.id = $1`,
    [id],
  );

  if (!rows.length) return { area: null, manager: null, isManager: false };

  const row = rows[0];
  const manager = row.manager_user_id
    ? {
        id: row.manager_user_id,
        name: displayName({
          id: row.manager_user_id,
          first_name: row.manager_first_name,
          last_name: row.manager_last_name,
          email: row.manager_email,
        }),
        email: row.manager_email || null,
      }
    : null;

  return {
    area: { id: row.area_id, area_name: row.area_name, color: row.color },
    manager,
    isManager: Number(row.manager_user_id) === id,
  };
}

/**
 * Aprobador de la primera etapa para una solicitud nueva.
 *
 *   { ok: false, error }                  → el área no tiene jefe: no se rinde.
 *   { ok: true, managerId, requiresAdmin } → managerId null + requiresAdmin
 *                                            cuando el solicitante es el jefe.
 */
async function resolveApprover(requesterId, areaId) {
  const manager = await getAreaManager(areaId);
  if (!manager) {
    return {
      ok: false,
      error:
        "Tu área aún no tiene un jefe asignado. Pídele a RRHH que designe uno antes de enviar solicitudes.",
    };
  }
  if (Number(manager.id) === Number(requesterId)) {
    return { ok: true, managerId: null, requiresAdmin: true, manager: null };
  }
  return { ok: true, managerId: manager.id, requiresAdmin: false, manager };
}

/**
 * Una solicitud pendiente sin jefe asignado es la del propio jefe del área:
 * la resuelve un administrador.
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
};
