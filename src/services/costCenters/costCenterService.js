const db = require("../../db");
const { MAX_COST_CENTERS_PER_USER } = require("./costCenterSchema");

/**
 * Centros de costo: a qué bolsillo se imputa un gasto.
 *
 * No confundir con el área de trabajo. Un colaborador pertenece a una sola
 * área (que define quién aprueba sus gastos) pero puede rendirle a uno o dos
 * centros de costo. Las dos agrupaciones son independientes: alguien de
 * Logística puede imputar a "CC-200 Proyectos" sin dejar de ser de Logística.
 */

function parsePositiveInt(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** Código: sin espacios de más, en mayúsculas — es lo que cita contabilidad. */
function parseCode(value) {
  const code = String(value || "").trim().replace(/\s+/g, " ").toUpperCase();
  if (!code || code.length > 30) return null;
  return code;
}

function parseName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (!name || name.length > 150) return null;
  return name;
}

function displayName(row) {
  const full = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return full || row.email || `Usuario ${row.id}`;
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

/** Todos los centros con su cantidad de colaboradores asignados. */
async function listCostCenters() {
  const { rows } = await db.query(
    `SELECT c.id, c.code, c.name, c.active,
            COUNT(uc.user_id)::int AS member_count
       FROM cost_centers c
       LEFT JOIN user_cost_centers uc ON uc.cost_center_id = c.id
      GROUP BY c.id, c.code, c.name, c.active
      ORDER BY c.active DESC, c.code ASC`,
  );
  return rows;
}

/** Centros con sus miembros, para la vista de gestión. */
async function listCostCentersWithMembers() {
  const [centersResult, membersResult] = await Promise.all([
    db.query(
      `SELECT id, code, name, active FROM cost_centers
        ORDER BY active DESC, code ASC`,
    ),
    db.query(
      `SELECT uc.cost_center_id, u.id, u.first_name, u.last_name, u.email, u.photo,
              w.area_name
         FROM user_cost_centers uc
         JOIN users u ON u.id = uc.user_id
         LEFT JOIN work_areas w ON w.id = u.work_area_id
        ORDER BY u.last_name ASC NULLS LAST, u.first_name ASC`,
    ),
  ]);

  const byCenter = new Map();
  for (const row of membersResult.rows) {
    const list = byCenter.get(row.cost_center_id) || [];
    list.push({
      id: row.id,
      name: displayName(row),
      email: row.email || null,
      photo: row.photo || null,
      areaName: row.area_name || null,
    });
    byCenter.set(row.cost_center_id, list);
  }

  return centersResult.rows.map((center) => {
    const members = byCenter.get(center.id) || [];
    return { ...center, members, memberCount: members.length };
  });
}

/** Centros activos que este colaborador puede usar al rendir. */
async function listUserCostCenters(userId) {
  const id = parsePositiveInt(userId);
  if (!id) return [];

  const { rows } = await db.query(
    `SELECT c.id, c.code, c.name
       FROM user_cost_centers uc
       JOIN cost_centers c ON c.id = uc.cost_center_id
      WHERE uc.user_id = $1 AND c.active = TRUE
      ORDER BY c.code ASC`,
    [id],
  );
  return rows;
}

/** Cuántos centros tiene ya asignados, para respetar el tope. */
async function countUserCostCenters(userId) {
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS n FROM user_cost_centers WHERE user_id = $1",
    [userId],
  );
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Mutaciones
// ---------------------------------------------------------------------------

async function createCostCenter({ code, name }) {
  const parsedCode = parseCode(code);
  const parsedName = parseName(name);
  if (!parsedCode) return { ok: false, error: "El código del centro de costo es obligatorio." };
  if (!parsedName) return { ok: false, error: "El nombre del centro de costo es obligatorio." };

  try {
    const { rows } = await db.query(
      "INSERT INTO cost_centers (code, name) VALUES ($1, $2) RETURNING *",
      [parsedCode, parsedName],
    );
    return { ok: true, costCenter: rows[0] };
  } catch (err) {
    if (err && err.code === "23505") {
      return { ok: false, error: `Ya existe un centro de costo con el código «${parsedCode}».` };
    }
    throw err;
  }
}

async function updateCostCenter(costCenterId, { code, name, active }) {
  const id = parsePositiveInt(costCenterId);
  if (!id) return { ok: false, error: "Centro de costo inválido." };

  const parsedCode = parseCode(code);
  const parsedName = parseName(name);
  if (!parsedCode) return { ok: false, error: "El código del centro de costo es obligatorio." };
  if (!parsedName) return { ok: false, error: "El nombre del centro de costo es obligatorio." };

  try {
    const { rowCount } = await db.query(
      "UPDATE cost_centers SET code = $1, name = $2, active = $3 WHERE id = $4",
      [parsedCode, parsedName, active !== false, id],
    );
    if (!rowCount) return { ok: false, error: "El centro de costo no existe." };
    return { ok: true };
  } catch (err) {
    if (err && err.code === "23505") {
      return { ok: false, error: `Ya existe un centro de costo con el código «${parsedCode}».` };
    }
    throw err;
  }
}

/**
 * Desactivar en vez de borrar. Un centro con historial de rendiciones no puede
 * desaparecer sin dejar huérfanos esos documentos contables.
 */
async function setCostCenterActive(costCenterId, active) {
  const id = parsePositiveInt(costCenterId);
  if (!id) return { ok: false, error: "Centro de costo inválido." };

  const { rowCount } = await db.query(
    "UPDATE cost_centers SET active = $1 WHERE id = $2",
    [!!active, id],
  );
  if (!rowCount) return { ok: false, error: "El centro de costo no existe." };
  return { ok: true };
}

/**
 * Borrado real, sólo para centros que nunca se usaron. Si tiene rendiciones
 * asociadas se rechaza y se sugiere desactivarlo.
 */
async function deleteCostCenter(costCenterId) {
  const id = parsePositiveInt(costCenterId);
  if (!id) return { ok: false, error: "Centro de costo inválido." };

  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS n FROM expense_requests WHERE cost_center_id = $1",
    [id],
  );
  if (rows[0].n > 0) {
    return {
      ok: false,
      error: `Este centro tiene ${rows[0].n} solicitud(es) asociadas. Desactívalo en vez de eliminarlo.`,
    };
  }

  const { rowCount } = await db.query("DELETE FROM cost_centers WHERE id = $1", [id]);
  if (!rowCount) return { ok: false, error: "El centro de costo no existe." };
  return { ok: true };
}

/** Asigna un colaborador a un centro, respetando el tope de dos. */
async function assignUser(costCenterId, userId) {
  const centerId = parsePositiveInt(costCenterId);
  const uid = parsePositiveInt(userId);
  if (!centerId || !uid) return { ok: false, error: "Datos inválidos." };

  const [centerResult, userResult] = await Promise.all([
    db.query("SELECT id, active FROM cost_centers WHERE id = $1", [centerId]),
    db.query("SELECT id FROM users WHERE id = $1", [uid]),
  ]);
  if (!centerResult.rows.length) return { ok: false, error: "El centro de costo no existe." };
  if (!centerResult.rows[0].active) {
    return { ok: false, error: "No se puede asignar colaboradores a un centro inactivo." };
  }
  if (!userResult.rows.length) return { ok: false, error: "Colaborador no encontrado." };

  const yaTiene = await countUserCostCenters(uid);
  if (yaTiene >= MAX_COST_CENTERS_PER_USER) {
    return {
      ok: false,
      error: `Un colaborador puede tener como máximo ${MAX_COST_CENTERS_PER_USER} centros de costo. Quítale uno antes de asignar otro.`,
    };
  }

  // ON CONFLICT y no un SELECT previo: dos asignaciones simultáneas del mismo
  // par pasarían el chequeo y sólo la PK las distingue.
  const { rowCount } = await db.query(
    `INSERT INTO user_cost_centers (user_id, cost_center_id)
     VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [uid, centerId],
  );
  if (!rowCount) return { ok: false, error: "El colaborador ya estaba en este centro de costo." };
  return { ok: true };
}

/**
 * Asigna varios colaboradores de una vez (lo que manda el modal de la pantalla
 * de centros).
 *
 * No es atómico a propósito: el tope de centros por persona se evalúa uno a
 * uno, así que si alguien ya llegó al máximo se le salta y el resto entra
 * igual. Devuelve la cuenta y los motivos para poder decir qué pasó con
 * quiénes en vez de un "no se pudo" a secas.
 */
async function assignUsers(costCenterId, userIds) {
  const ids = [].concat(userIds || []).map(parsePositiveInt).filter(Boolean);
  if (!ids.length) return { ok: false, error: "Datos inválidos." };

  let asignados = 0;
  const fallos = [];
  for (const uid of ids) {
    // En serie y no en paralelo: countUserCostCenters tiene que ver el efecto
    // de la asignación anterior para que el tope se respete de verdad.
    const resultado = await assignUser(costCenterId, uid);
    if (resultado.ok) asignados += 1;
    else fallos.push(resultado.error);
  }

  return { ok: asignados > 0, asignados, fallos, total: ids.length };
}

/**
 * Deja al colaborador exactamente en los centros indicados. Es lo que usan la
 * ficha de creación y la de edición, donde el administrador ve el conjunto
 * completo y no una asignación suelta.
 *
 * Sólo toca los centros activos: la ficha únicamente ofrece esos, así que un
 * centro apagado en el que la persona ya estaba —y al que probablemente le
 * rindió gastos— no puede desaparecer por no venir en el formulario.
 */
async function setUserCostCenters(userId, costCenterIds) {
  const uid = parsePositiveInt(userId);
  if (!uid) return { ok: false, error: "Datos inválidos." };

  const pedidos = Array.from(
    new Set([].concat(costCenterIds || []).map(parsePositiveInt).filter(Boolean)),
  );

  const [userResult, inactivosResult] = await Promise.all([
    db.query("SELECT id FROM users WHERE id = $1", [uid]),
    db.query(
      `SELECT uc.cost_center_id
         FROM user_cost_centers uc
         JOIN cost_centers c ON c.id = uc.cost_center_id
        WHERE uc.user_id = $1 AND c.active = FALSE`,
      [uid],
    ),
  ]);
  if (!userResult.rows.length) return { ok: false, error: "Colaborador no encontrado." };

  const conservados = inactivosResult.rows.length;
  if (pedidos.length + conservados > MAX_COST_CENTERS_PER_USER) {
    return {
      ok: false,
      error: `Un colaborador puede tener como máximo ${MAX_COST_CENTERS_PER_USER} centros de costo.`,
    };
  }

  if (pedidos.length) {
    const { rows: validos } = await db.query(
      "SELECT id FROM cost_centers WHERE id = ANY($1::int[]) AND active = TRUE",
      [pedidos],
    );
    if (validos.length !== pedidos.length) {
      return { ok: false, error: "Alguno de los centros de costo ya no está disponible." };
    }
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query(
      `DELETE FROM user_cost_centers uc
        USING cost_centers c
        WHERE uc.cost_center_id = c.id
          AND uc.user_id = $1
          AND c.active = TRUE`,
      [uid],
    );
    for (const centerId of pedidos) {
      await client.query(
        `INSERT INTO user_cost_centers (user_id, cost_center_id)
         VALUES ($1, $2) ON CONFLICT DO NOTHING`,
        [uid, centerId],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return { ok: true, asignados: pedidos.length };
}

async function removeUser(costCenterId, userId) {
  const centerId = parsePositiveInt(costCenterId);
  const uid = parsePositiveInt(userId);
  if (!centerId || !uid) return { ok: false, error: "Datos inválidos." };

  const { rowCount } = await db.query(
    "DELETE FROM user_cost_centers WHERE cost_center_id = $1 AND user_id = $2",
    [centerId, uid],
  );
  if (!rowCount) return { ok: false, error: "El colaborador no está en este centro de costo." };
  return { ok: true };
}

module.exports = {
  MAX_COST_CENTERS_PER_USER,
  parseCode,
  parseName,
  listCostCenters,
  listCostCentersWithMembers,
  listUserCostCenters,
  countUserCostCenters,
  createCostCenter,
  updateCostCenter,
  setCostCenterActive,
  deleteCostCenter,
  assignUser,
  assignUsers,
  setUserCostCenters,
  removeUser,
};
