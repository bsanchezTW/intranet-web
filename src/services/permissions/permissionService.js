const db = require("../../db");
const logger = require("../../utils/logger");
const { getCatalog } = require("./catalog");
const { computePermissions, emptyPermissions } = require("./resolver");

/**
 * Permisos efectivos por request, con dos cachés:
 *
 *   - La foto de la configuración (asignaciones, conjuntos de personas,
 *     áreas y personas): todas las tablas son chicas y se leen juntas. Se recarga
 *     cuando cambia `perm_meta.version`, que se consulta en cada petición:
 *     un cambio hecho en otro proceso vale en el siguiente clic. Como
 *     respaldo, también al minuto.
 *   - El resultado por persona, hasta que cambie la foto o empiece/termine
 *     una vigencia que la afecta.
 *
 * Ante un error de base se queda con la última foto; sin ninguna, nadie
 * tiene permisos.
 */

const SNAPSHOT_TTL_MS = 60 * 1000;
const RESULT_TTL_MS = 60 * 1000;

let snapshot = null; // { version, loadedAt, users, areas, groupMembers, assignments }
let loading = null;
const results = new Map(); // userId → { snapshot, expiresAt, perms }

function isMissingRelation(err) {
  // 42P01: tabla inexistente (el schema aún no corre); 42703: columna.
  return err && (err.code === "42P01" || err.code === "42703");
}

async function fetchVersion() {
  try {
    const { rows } = await db.query("SELECT version FROM perm_meta WHERE id = 1");
    return rows.length ? Number(rows[0].version) : 0;
  } catch (err) {
    if (isMissingRelation(err)) return 0;
    throw err;
  }
}

async function fetchUsers() {
  try {
    const { rows } = await db.query("SELECT id, role, work_area_id, is_superadmin FROM users");
    return rows;
  } catch (err) {
    if (!isMissingRelation(err)) throw err;
    const { rows } = await db.query("SELECT id, role, work_area_id FROM users");
    return rows.map((r) => ({ ...r, is_superadmin: false }));
  }
}

async function fetchConfiguration() {
  try {
    const [members, assignments] = await Promise.all([
      db.query("SELECT group_id, user_id FROM perm_group_members"),
      db.query(
        `SELECT id, principal_type, area_id, user_id, group_id, include_subareas,
                permission_key, scope, scope_area_ids, scope_include_subareas,
                effect, valid_from, valid_until
           FROM perm_assignments
          WHERE set_id IS NULL`,
      ),
    ]);
    // userId → Set(groupId)
    const groupMembers = new Map();
    for (const m of members.rows) {
      const userId = Number(m.user_id);
      if (!groupMembers.has(userId)) groupMembers.set(userId, new Set());
      groupMembers.get(userId).add(Number(m.group_id));
    }
    return { groupMembers, assignments: assignments.rows };
  } catch (err) {
    if (isMissingRelation(err)) return { groupMembers: new Map(), assignments: [] };
    throw err;
  }
}

/** Lee toda la configuración de permisos del país en una foto. */
async function loadSnapshot() {
  const [version, users, areas, config] = await Promise.all([
    fetchVersion(),
    fetchUsers(),
    db.query("SELECT id, parent_area_id, manager_user_id FROM work_areas").then((r) => r.rows),
    fetchConfiguration(),
  ]);
  return {
    version,
    loadedAt: Date.now(),
    users: new Map(users.map((u) => [Number(u.id), u])),
    areas,
    groupMembers: config.groupMembers,
    assignments: config.assignments,
  };
}

async function refreshSnapshot() {
  if (!loading) {
    loading = loadSnapshot()
      .then((fresh) => {
        snapshot = fresh;
        return fresh;
      })
      .catch((err) => {
        logger.error("permisos", err);
        return snapshot;
      })
      .finally(() => {
        loading = null;
      });
  }
  return loading;
}

/**
 * Foto vigente. En cada petición se compara la versión (una consulta mínima)
 * para que un cambio hecho en otro proceso valga al instante.
 */
async function getSnapshot() {
  if (!snapshot || Date.now() - snapshot.loadedAt > SNAPSHOT_TTL_MS) return refreshSnapshot();
  try {
    if ((await fetchVersion()) !== snapshot.version) return refreshSnapshot();
  } catch (err) {
    logger.error("permisos", err);
  }
  return snapshot;
}

/** Permisos efectivos de quien tiene sesión (o de cualquier usuario por id). */
async function resolve(user) {
  const catalog = getCatalog();
  if (!user || user.id == null) return emptyPermissions(catalog);

  const current = await getSnapshot();
  if (!current) return emptyPermissions(catalog, Number(user.id));

  const id = Number(user.id);
  const now = Date.now();
  const cached = results.get(id);
  if (cached && cached.snapshot === current && cached.expiresAt > now) return cached.perms;

  const perms = computePermissions(current, user, { catalog, now });
  const expiresAt = Math.min(now + RESULT_TTL_MS, perms.expiresAt || Infinity);
  results.set(id, { snapshot: current, expiresAt, perms });
  return perms;
}

/**
 * Ids de quienes pueden hacer `key` (sobre `record` = { ownerId, areaId }, si
 * se da) con la configuración vigente. Para avisos por correo y listas de
 * equipo. Los superadmins pueden todo pero no reciben avisos sólo por serlo:
 * se excluyen salvo que se pidan.
 */
async function usersWhoCan(key, record = null, { includeSuperadmins = false } = {}) {
  const catalog = getCatalog();
  const current = await getSnapshot();
  if (!current) return [];
  const now = Date.now();
  const ids = [];
  for (const id of current.users.keys()) {
    const perms = computePermissions(current, { id }, { catalog, now });
    if (perms.superadmin && !includeSuperadmins) continue;
    if (record ? perms.canOnRecord(key, record) : perms.can(key)) ids.push(id);
  }
  return ids;
}

/** Sólo este proceso: para quien ya subió la versión en su transacción. */
function forgetLocalCache() {
  snapshot = null;
  results.clear();
}

/**
 * Tras cambiar permisos, áreas, jefaturas o personas: este proceso recarga
 * en la próxima petición y los demás al ver la versión nueva. `client` para
 * subir la versión dentro de la transacción que hizo el cambio.
 */
async function invalidatePermissions(client = db) {
  forgetLocalCache();
  try {
    await client.query("UPDATE perm_meta SET version = version + 1, updated_at = NOW() WHERE id = 1");
  } catch (err) {
    if (!isMissingRelation(err)) logger.error("permisos", err);
  }
}

module.exports = {
  resolve,
  usersWhoCan,
  invalidatePermissions,
  forgetLocalCache,
  loadSnapshot,
};
