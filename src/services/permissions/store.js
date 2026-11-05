const db = require("../../db");
const { getCatalog } = require("./catalog");
const { getTimezone } = require("../../config/country");
const { SCOPE } = require("./scopes");
const { forgetLocalCache } = require("./permissionService");

/**
 * Escrituras de Gestión de Permisos. Cada una va en su transacción con su
 * fila en perm_audit (antes y después) y sube la versión, así el cambio vale
 * en todos los procesos en la siguiente petición.
 *
 * La validación es pura (validateGrant, validateAssignment) para poder
 * probarla sin base: un permiso que el país no tiene, un alcance que el
 * permiso no admite o un área que no existe se rechazan con un mensaje para
 * la pantalla, nunca se guardan "por si acaso".
 */

class PermissionInputError extends Error {}

const PRINCIPALS = ["global", "area", "jefes", "user", "grupo"];

function toId(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function toIdList(value) {
  const list = Array.isArray(value) ? value : value == null || value === "" ? [] : [value];
  return [...new Set(list.map(toId).filter((id) => id != null))];
}

/** Diferencia en ms entre la hora local de `timeZone` y UTC en ese instante. */
function zoneOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - instant.getTime();
}

/** Medianoche de `ymd` (AAAA-MM-DD) en la zona del país. */
function localMidnight(ymd, timeZone) {
  const [y, m, d] = ymd.split("-").map(Number);
  const guess = new Date(Date.UTC(y, m - 1, d));
  return new Date(guess.getTime() - zoneOffsetMs(guess, timeZone));
}

/**
 * Fecha del formulario. Un día suelto (input date) se lee en la zona del
 * país; `endOfDay` lo lleva al inicio del día siguiente, porque «vigente
 * hasta el 20» incluye todo el 20.
 */
function toDate(value, label, { timeZone = "UTC", endOfDay = false } = {}) {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  let date;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [y, m, d] = text.split("-").map(Number);
    const day = endOfDay ? new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10) : text;
    date = localMidnight(day, timeZone);
  } else {
    date = new Date(text);
  }
  if (Number.isNaN(date.getTime())) throw new PermissionInputError(`La fecha «${label}» no es válida.`);
  return date;
}

/**
 * Permiso + alcance listos para guardar.
 *   { permission_key, scope, scope_area_ids, scope_include_subareas }
 * `areaIds`: ids de áreas existentes.
 */
function validateGrant(input, { catalog, areaIds }) {
  const key = String(input.permission_key || "").trim();
  const definition = catalog.byKey.get(key);
  if (!definition) throw new PermissionInputError("Ese permiso no existe en la intranet de este país.");

  if (!definition.scopes) {
    return { permission_key: key, scope: null, scope_area_ids: [], scope_include_subareas: false };
  }
  const scope = String(input.scope || "").trim();
  if (!definition.scopes.includes(scope)) {
    throw new PermissionInputError(`Elige sobre qué registros vale «${definition.label}».`);
  }
  if (scope !== SCOPE.AREAS) {
    return { permission_key: key, scope, scope_area_ids: [], scope_include_subareas: false };
  }
  const ids = toIdList(input.scope_area_ids);
  if (!ids.length) throw new PermissionInputError("Elige al menos un área para el alcance «Áreas elegidas».");
  if (ids.some((id) => !areaIds.has(id))) throw new PermissionInputError("Una de las áreas elegidas ya no existe.");
  return {
    permission_key: key,
    scope,
    scope_area_ids: ids,
    scope_include_subareas: Boolean(input.scope_include_subareas),
  };
}

/** Asignación lista para guardar. Ver perm_assignments. */
function validateAssignment(input, { catalog, areaIds, userIds, groupIds = new Set(), actorId, now = new Date(), timeZone }) {
  const principal = String(input.principal_type || "");
  if (!PRINCIPALS.includes(principal)) throw new PermissionInputError("Elige a quién se asigna.");

  const value = {
    principal_type: principal,
    area_id: null,
    user_id: null,
    group_id: null,
    include_subareas: false,
    permission_key: null,
    scope: null,
    scope_area_ids: [],
    scope_include_subareas: false,
    effect: input.effect === "deniega" ? "deniega" : "concede",
    valid_from: toDate(input.valid_from, "desde", { timeZone }),
    valid_until: toDate(input.valid_until, "hasta", { timeZone, endOfDay: true }),
    note: String(input.note || "").trim().slice(0, 500) || null,
  };

  if (principal === "area" || principal === "jefes") {
    const areaId = toId(input.area_id);
    if (principal === "area" && areaId == null) throw new PermissionInputError("Elige el área.");
    if (areaId != null && !areaIds.has(areaId)) throw new PermissionInputError("El área elegida ya no existe.");
    value.area_id = areaId;
    value.include_subareas = areaId != null && Boolean(input.include_subareas);
  }
  if (principal === "user") {
    const userId = toId(input.user_id);
    if (userId == null || !userIds.has(userId)) throw new PermissionInputError("Elige a la persona.");
    if (actorId != null && userId === Number(actorId)) {
      throw new PermissionInputError("No puedes cambiar tus propias asignaciones.");
    }
    value.user_id = userId;
  }
  if (principal === "grupo") {
    const groupId = toId(input.group_id);
    if (groupId == null || !groupIds.has(groupId)) throw new PermissionInputError("Elige el conjunto de personas.");
    value.group_id = groupId;
  }

  if (value.effect === "deniega") {
    // Denegar quita el permiso entero: el alcance no aplica.
    const key = String(input.permission_key || "").trim();
    if (!catalog.byKey.has(key)) throw new PermissionInputError("Ese permiso no existe en la intranet de este país.");
    value.permission_key = key;
  } else {
    Object.assign(value, validateGrant(input, { catalog, areaIds }));
  }

  if (value.valid_from && value.valid_until && value.valid_until <= value.valid_from) {
    throw new PermissionInputError("La vigencia debe terminar después de empezar.");
  }
  if (value.valid_until && value.valid_until <= now) {
    throw new PermissionInputError("La vigencia ya terminó: elige una fecha futura.");
  }
  return value;
}

// ---------------------------------------------------------------------------

async function audit(client, { actorId, action, entityType, entityId = null, oldValue = null, newValue = null, note = null }) {
  await client.query(
    `INSERT INTO perm_audit (actor_user_id, action, entity_type, entity_id, old_value, new_value, note)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)`,
    [
      actorId || null,
      action,
      entityType,
      entityId,
      oldValue == null ? null : JSON.stringify(oldValue),
      newValue == null ? null : JSON.stringify(newValue),
      note,
    ],
  );
}

/** Transacción + auditoría + versión. `fn(client)` hace el cambio. */
async function inTransaction(fn) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("UPDATE perm_meta SET version = version + 1, updated_at = NOW() WHERE id = 1");
    await client.query("COMMIT");
    forgetLocalCache();
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function referenceSets(client) {
  // En serie: un cliente de pg no admite consultas simultáneas (pg@9 lo prohíbe).
  const areas = await client.query("SELECT id FROM work_areas");
  const users = await client.query("SELECT id FROM users");
  const groups = await client.query("SELECT id FROM perm_groups");
  return {
    areaIds: new Set(areas.rows.map((r) => Number(r.id))),
    userIds: new Set(users.rows.map((r) => Number(r.id))),
    groupIds: new Set(groups.rows.map((r) => Number(r.id))),
  };
}

// --- Conjuntos de personas -------------------------------------------------

function cleanGroupInput({ name, description } = {}) {
  const cleanName = String(name || "").trim().slice(0, 120);
  if (!cleanName) throw new PermissionInputError("El conjunto necesita un nombre.");
  return { name: cleanName, description: String(description || "").trim().slice(0, 300) || null };
}

async function assertGroupNameFree(client, name, exceptId = null) {
  const { rows } = await client.query(
    "SELECT id FROM perm_groups WHERE LOWER(name) = LOWER($1) AND ($2::int IS NULL OR id <> $2)",
    [name, exceptId],
  );
  if (rows.length) throw new PermissionInputError(`Ya hay un conjunto llamado «${name}».`);
}

async function createGroup(input, actorId) {
  const value = cleanGroupInput(input);
  return inTransaction(async (client) => {
    await assertGroupNameFree(client, value.name);
    const { rows } = await client.query(
      "INSERT INTO perm_groups (name, description) VALUES ($1, $2) RETURNING *",
      [value.name, value.description],
    );
    await audit(client, { actorId, action: "grupo.crear", entityType: "grupo", entityId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
}

async function updateGroup(groupId, input, actorId) {
  const id = toId(groupId);
  const value = cleanGroupInput(input);
  return inTransaction(async (client) => {
    const { rows: before } = await client.query("SELECT * FROM perm_groups WHERE id = $1 FOR UPDATE", [id]);
    if (!before.length) throw new PermissionInputError("El conjunto ya no existe.");
    await assertGroupNameFree(client, value.name, id);
    const { rows } = await client.query(
      "UPDATE perm_groups SET name = $1, description = $2, updated_at = NOW() WHERE id = $3 RETURNING *",
      [value.name, value.description, id],
    );
    await audit(client, { actorId, action: "grupo.editar", entityType: "grupo", entityId: id, oldValue: before[0], newValue: rows[0] });
    return rows[0];
  });
}

/** Elimina el conjunto; sus miembros y sus asignaciones se van con él. */
async function deleteGroup(groupId, actorId) {
  const id = toId(groupId);
  return inTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM perm_groups WHERE id = $1 FOR UPDATE", [id]);
    if (!rows.length) throw new PermissionInputError("El conjunto ya no existe.");
    const { rows: members } = await client.query("SELECT user_id FROM perm_group_members WHERE group_id = $1", [id]);
    const { rows: assignments } = await client.query("SELECT * FROM perm_assignments WHERE group_id = $1", [id]);
    await client.query("DELETE FROM perm_groups WHERE id = $1", [id]);
    await audit(client, {
      actorId,
      action: "grupo.eliminar",
      entityType: "grupo",
      entityId: id,
      oldValue: { ...rows[0], members: members.map((m) => Number(m.user_id)), assignments },
    });
    return rows[0];
  });
}

/**
 * Agrega o quita a una persona de un conjunto. Nadie se cambia a sí mismo
 * (sería darse permisos) y un superadmin no necesita conjuntos.
 */
async function setGroupMember(groupId, userId, member, actorId) {
  const gid = toId(groupId);
  const uid = toId(userId);
  if (uid == null) throw new PermissionInputError("Elige a la persona.");
  if (actorId != null && uid === Number(actorId)) throw new PermissionInputError("No puedes cambiar tus propios conjuntos.");
  return inTransaction(async (client) => {
    const { rows: group } = await client.query("SELECT id, name FROM perm_groups WHERE id = $1 FOR UPDATE", [gid]);
    if (!group.length) throw new PermissionInputError("El conjunto ya no existe.");
    const { rows: user } = await client.query("SELECT id, is_superadmin FROM users WHERE id = $1", [uid]);
    if (!user.length) throw new PermissionInputError("La persona ya no existe.");
    if (member) {
      if (user[0].is_superadmin) throw new PermissionInputError("Un superadmin ya tiene todos los permisos.");
      const { rows } = await client.query(
        `INSERT INTO perm_group_members (group_id, user_id, added_by) VALUES ($1, $2, $3)
         ON CONFLICT DO NOTHING RETURNING *`,
        [gid, uid, actorId || null],
      );
      if (!rows.length) return { changed: false };
      await audit(client, { actorId, action: "grupo.miembro.agregar", entityType: "grupo", entityId: gid, newValue: { user_id: uid } });
      return { changed: true };
    }
    const { rows } = await client.query(
      "DELETE FROM perm_group_members WHERE group_id = $1 AND user_id = $2 RETURNING *",
      [gid, uid],
    );
    if (!rows.length) return { changed: false };
    await audit(client, { actorId, action: "grupo.miembro.quitar", entityType: "grupo", entityId: gid, oldValue: { user_id: uid } });
    return { changed: true };
  });
}

// --- Asignaciones --------------------------------------------------------------

async function createAssignment(input, actorId, { catalog = getCatalog() } = {}) {
  return inTransaction(async (client) => {
    const refs = await referenceSets(client);
    const value = validateAssignment(input, { catalog, ...refs, actorId, timeZone: getTimezone() });
    const { rows } = await client.query(
      `INSERT INTO perm_assignments
         (principal_type, area_id, user_id, include_subareas, group_id, permission_key, scope,
          scope_area_ids, scope_include_subareas, effect, valid_from, valid_until, note, granted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        value.principal_type,
        value.area_id,
        value.user_id,
        value.include_subareas,
        value.group_id,
        value.permission_key,
        value.scope,
        value.scope_area_ids,
        value.scope_include_subareas,
        value.effect,
        value.valid_from,
        value.valid_until,
        value.note,
        actorId || null,
      ],
    );
    await audit(client, {
      actorId,
      action: value.effect === "deniega" ? "asignacion.denegar" : "asignacion.conceder",
      entityType: "asignacion",
      entityId: rows[0].id,
      newValue: rows[0],
    });
    return rows[0];
  });
}

async function deleteAssignment(assignmentId, actorId) {
  return inTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM perm_assignments WHERE id = $1 FOR UPDATE", [assignmentId]);
    if (!rows.length) throw new PermissionInputError("La asignación ya no existe.");
    if (rows[0].principal_type === "user" && actorId != null && Number(rows[0].user_id) === Number(actorId)) {
      throw new PermissionInputError("No puedes cambiar tus propias asignaciones.");
    }
    await client.query("DELETE FROM perm_assignments WHERE id = $1", [assignmentId]);
    await audit(client, {
      actorId,
      action: "asignacion.quitar",
      entityType: "asignacion",
      entityId: Number(assignmentId),
      oldValue: rows[0],
    });
    return rows[0];
  });
}

/**
 * Cambia la vigencia, el motivo, el alcance o si alcanza a las subáreas de
 * una asignación. A quién se asigna, qué y si concede o deniega no cambian:
 * eso es otra asignación (se quita y se agrega).
 */
async function updateAssignment(assignmentId, input, actorId, { catalog = getCatalog() } = {}) {
  return inTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM perm_assignments WHERE id = $1 FOR UPDATE", [assignmentId]);
    if (!rows.length) throw new PermissionInputError("La asignación ya no existe.");
    const before = rows[0];
    const refs = await referenceSets(client);
    const value = validateAssignment(
      {
        ...input,
        principal_type: before.principal_type,
        area_id: before.area_id,
        user_id: before.user_id,
        group_id: before.group_id,
        permission_key: before.permission_key,
        effect: before.effect,
      },
      { catalog, ...refs, actorId, timeZone: getTimezone() },
    );
    const { rows: after } = await client.query(
      `UPDATE perm_assignments
          SET include_subareas = $1, scope = $2, scope_area_ids = $3, scope_include_subareas = $4,
              valid_from = $5, valid_until = $6, note = $7
        WHERE id = $8
        RETURNING *`,
      [
        value.include_subareas,
        value.scope,
        value.scope_area_ids,
        value.scope_include_subareas,
        value.valid_from,
        value.valid_until,
        value.note,
        assignmentId,
      ],
    );
    await audit(client, {
      actorId,
      action: "asignacion.editar",
      entityType: "asignacion",
      entityId: Number(assignmentId),
      oldValue: before,
      newValue: after[0],
    });
    return after[0];
  });
}

/**
 * Le quita un permiso a una persona (ver adminQueries.removalPlan): borra sus
 * asignaciones `deleteIds` y, si `deny`, le deniega la clave a ella sola.
 * Todo en una transacción: o queda sin el permiso, o no cambia nada.
 */
async function revokeFromUser({ userId, permissionKey, deleteIds = [], deny = false, note = null }, actorId, { catalog = getCatalog() } = {}) {
  const id = toId(userId);
  if (id == null) throw new PermissionInputError("Elige a la persona.");
  if (actorId != null && id === Number(actorId)) throw new PermissionInputError("No puedes cambiar tus propias asignaciones.");
  if (!catalog.byKey.has(permissionKey)) throw new PermissionInputError("Ese permiso no existe en la intranet de este país.");
  return inTransaction(async (client) => {
    const ids = toIdList(deleteIds);
    if (ids.length) {
      // Sólo asignaciones de esa persona: el plan viene del servidor, pero no
      // se borra nada de otros aunque llegara mal.
      const { rows } = await client.query(
        `DELETE FROM perm_assignments
          WHERE id = ANY($1::int[]) AND principal_type = 'user' AND user_id = $2
          RETURNING *`,
        [ids, id],
      );
      for (const row of rows) {
        await audit(client, {
          actorId,
          action: "asignacion.quitar",
          entityType: "asignacion",
          entityId: Number(row.id),
          oldValue: row,
          note,
        });
      }
    }
    if (!deny) return { denied: null };
    const refs = await referenceSets(client);
    const value = validateAssignment(
      { principal_type: "user", user_id: id, permission_key: permissionKey, effect: "deniega", note },
      { catalog, ...refs, actorId, timeZone: getTimezone() },
    );
    const { rows } = await client.query(
      `INSERT INTO perm_assignments (principal_type, user_id, permission_key, effect, note, granted_by)
       VALUES ('user', $1, $2, 'deniega', $3, $4)
       RETURNING *`,
      [value.user_id, value.permission_key, value.note, actorId || null],
    );
    await audit(client, {
      actorId,
      action: "asignacion.denegar",
      entityType: "asignacion",
      entityId: rows[0].id,
      newValue: rows[0],
      note,
    });
    return { denied: rows[0] };
  });
}

// --- Superadmin ----------------------------------------------------------------

/**
 * Marca o desmarca a un superadmin. Nadie cambia su propia marca y nunca
 * queda la intranet sin un superadmin activo. Si igual faltara (la base se
 * editó a mano), se recupera con scripts/superadmin.js desde el servidor.
 */
async function setSuperadmin(userId, value, actorId) {
  const id = toId(userId);
  if (id == null) throw new PermissionInputError("Elige a la persona.");
  if (actorId != null && id === Number(actorId)) {
    throw new PermissionInputError("No puedes cambiar tu propia marca de superadmin.");
  }
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      "SELECT id, first_name, last_name, role, is_superadmin FROM users WHERE id = $1 FOR UPDATE",
      [id],
    );
    if (!rows.length) throw new PermissionInputError("La persona ya no existe.");
    const desired = Boolean(value);
    if (Boolean(rows[0].is_superadmin) === desired) return rows[0];
    if (!desired) {
      const { rows: others } = await client.query(
        `SELECT count(*)::int AS n FROM users
          WHERE is_superadmin AND id <> $1 AND COALESCE(role, '') NOT ILIKE 'deshabilitado'`,
        [id],
      );
      if (others[0].n === 0) throw new PermissionInputError("Tiene que quedar al menos un superadmin activo.");
    }
    await client.query("UPDATE users SET is_superadmin = $1 WHERE id = $2", [desired, id]);
    await audit(client, {
      actorId,
      action: desired ? "superadmin.marcar" : "superadmin.quitar",
      entityType: "usuario",
      entityId: id,
      oldValue: { is_superadmin: Boolean(rows[0].is_superadmin) },
      newValue: { is_superadmin: desired },
    });
    return { ...rows[0], is_superadmin: desired };
  });
}

module.exports = {
  PermissionInputError,
  validateGrant,
  validateAssignment,
  createGroup,
  updateGroup,
  deleteGroup,
  setGroupMember,
  createAssignment,
  deleteAssignment,
  updateAssignment,
  revokeFromUser,
  setSuperadmin,
};
