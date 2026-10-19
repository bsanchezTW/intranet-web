const db = require("../../db");
const { getCatalog } = require("./catalog");
const { getTimezone } = require("../../config/country");
const { SCOPE } = require("./scopes");
const { forgetLocalCache } = require("./permissionService");

/**
 * Escrituras de Gestión de Permisos. Cada una va en su transacción con su
 * fila en perm_audit (antes y después) y sube la versión, así el cambio vale
 * en todos los procesos en segundos.
 *
 * La validación es pura (validateGrant, validateAssignment) para poder
 * probarla sin base: un permiso que el país no tiene, un alcance que el
 * permiso no admite o un área que no existe se rechazan con un mensaje para
 * la pantalla, nunca se guardan "por si acaso".
 */

class PermissionInputError extends Error {}

const PRINCIPALS = ["global", "area", "jefes", "user"];

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
function validateAssignment(input, { catalog, areaIds, userIds, setIds, actorId, now = new Date(), timeZone }) {
  const principal = String(input.principal_type || "");
  if (!PRINCIPALS.includes(principal)) throw new PermissionInputError("Elige a quién se asigna.");

  const value = {
    principal_type: principal,
    area_id: null,
    user_id: null,
    include_subareas: false,
    set_id: null,
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

  const setId = toId(input.set_id);
  if (setId != null) {
    if (!setIds.has(setId)) throw new PermissionInputError("El conjunto elegido ya no existe.");
    value.set_id = setId;
  } else if (value.effect === "deniega") {
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

/** Ítems de un conjunto: [{ permission_key, scope, ... }] sin repetidos. */
function validateSetItems(items, { catalog, areaIds }) {
  const seen = new Set();
  const out = [];
  for (const raw of items || []) {
    const grant = validateGrant(raw, { catalog, areaIds });
    const k = `${grant.permission_key}|${grant.scope || ""}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(grant);
  }
  return out;
}

function slugify(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 50);
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
  const [areas, users, sets] = await Promise.all([
    client.query("SELECT id FROM work_areas"),
    client.query("SELECT id FROM users"),
    client.query("SELECT id FROM perm_sets"),
  ]);
  return {
    areaIds: new Set(areas.rows.map((r) => Number(r.id))),
    userIds: new Set(users.rows.map((r) => Number(r.id))),
    setIds: new Set(sets.rows.map((r) => Number(r.id))),
  };
}

// --- Conjuntos ---------------------------------------------------------------

async function createSet({ name, description }, actorId) {
  const cleanName = String(name || "").trim().slice(0, 120);
  if (!cleanName) throw new PermissionInputError("El conjunto necesita un nombre.");
  return inTransaction(async (client) => {
    const base = slugify(cleanName) || "conjunto";
    const { rows: existing } = await client.query("SELECT code FROM perm_sets WHERE code LIKE $1", [`${base}%`]);
    const taken = new Set(existing.map((r) => r.code));
    let code = base;
    for (let i = 2; taken.has(code); i += 1) code = `${base}_${i}`;
    const { rows } = await client.query(
      "INSERT INTO perm_sets (code, name, description) VALUES ($1, $2, $3) RETURNING *",
      [code, cleanName, String(description || "").trim() || null],
    );
    await audit(client, { actorId, action: "conjunto.crear", entityType: "conjunto", entityId: rows[0].id, newValue: rows[0] });
    return rows[0];
  });
}

async function updateSet(setId, { name, description, active }, actorId) {
  const cleanName = String(name || "").trim().slice(0, 120);
  if (!cleanName) throw new PermissionInputError("El conjunto necesita un nombre.");
  return inTransaction(async (client) => {
    const { rows: before } = await client.query("SELECT * FROM perm_sets WHERE id = $1 FOR UPDATE", [setId]);
    if (!before.length) throw new PermissionInputError("El conjunto ya no existe.");
    const { rows } = await client.query(
      `UPDATE perm_sets SET name = $1, description = $2, active = $3, updated_at = NOW()
        WHERE id = $4 RETURNING *`,
      [cleanName, String(description || "").trim() || null, Boolean(active), setId],
    );
    await audit(client, {
      actorId,
      action: "conjunto.editar",
      entityType: "conjunto",
      entityId: Number(setId),
      oldValue: before[0],
      newValue: rows[0],
    });
    return rows[0];
  });
}

async function replaceSetItems(setId, items, actorId, { catalog = getCatalog() } = {}) {
  return inTransaction(async (client) => {
    const { rows: set } = await client.query("SELECT id FROM perm_sets WHERE id = $1 FOR UPDATE", [setId]);
    if (!set.length) throw new PermissionInputError("El conjunto ya no existe.");
    const { areaIds } = await referenceSets(client);
    const clean = validateSetItems(items, { catalog, areaIds });

    const { rows: before } = await client.query(
      `SELECT permission_key, scope, scope_area_ids, scope_include_subareas
         FROM perm_set_items WHERE set_id = $1 ORDER BY permission_key, scope`,
      [setId],
    );
    await client.query("DELETE FROM perm_set_items WHERE set_id = $1", [setId]);
    for (const i of clean) {
      await client.query(
        `INSERT INTO perm_set_items (set_id, permission_key, scope, scope_area_ids, scope_include_subareas)
         VALUES ($1, $2, $3, $4, $5)`,
        [setId, i.permission_key, i.scope, i.scope_area_ids, i.scope_include_subareas],
      );
    }
    await client.query("UPDATE perm_sets SET updated_at = NOW() WHERE id = $1", [setId]);
    await audit(client, {
      actorId,
      action: "conjunto.permisos",
      entityType: "conjunto",
      entityId: Number(setId),
      oldValue: before,
      newValue: clean,
    });
    return clean;
  });
}

async function deleteSet(setId, actorId) {
  return inTransaction(async (client) => {
    const { rows } = await client.query("SELECT * FROM perm_sets WHERE id = $1 FOR UPDATE", [setId]);
    if (!rows.length) throw new PermissionInputError("El conjunto ya no existe.");
    const { rows: items } = await client.query(
      "SELECT permission_key, scope, scope_area_ids, scope_include_subareas FROM perm_set_items WHERE set_id = $1",
      [setId],
    );
    const { rows: assignments } = await client.query("SELECT * FROM perm_assignments WHERE set_id = $1", [setId]);
    // Las asignaciones del conjunto se van con él (ON DELETE CASCADE).
    await client.query("DELETE FROM perm_sets WHERE id = $1", [setId]);
    await audit(client, {
      actorId,
      action: "conjunto.eliminar",
      entityType: "conjunto",
      entityId: Number(setId),
      oldValue: { ...rows[0], items, assignments },
    });
    return rows[0];
  });
}

// --- Asignaciones --------------------------------------------------------------

async function createAssignment(input, actorId, { catalog = getCatalog() } = {}) {
  return inTransaction(async (client) => {
    const refs = await referenceSets(client);
    const value = validateAssignment(input, { catalog, ...refs, actorId, timeZone: getTimezone() });
    const { rows } = await client.query(
      `INSERT INTO perm_assignments
         (principal_type, area_id, user_id, include_subareas, set_id, permission_key, scope,
          scope_area_ids, scope_include_subareas, effect, valid_from, valid_until, note, granted_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        value.principal_type,
        value.area_id,
        value.user_id,
        value.include_subareas,
        value.set_id,
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

// --- Superadmin ----------------------------------------------------------------

/**
 * Marca o desmarca a un superadmin. Nadie cambia su propia marca y nunca
 * queda la intranet sin un superadmin activo (el login de emergencia no
 * cuenta: es para recuperar el acceso, no para operar).
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
  validateSetItems,
  slugify,
  createSet,
  updateSet,
  replaceSetItems,
  deleteSet,
  createAssignment,
  deleteAssignment,
  setSuperadmin,
};
