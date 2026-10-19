const db = require("../../db");
const logger = require("../../utils/logger");
const { getCatalog } = require("./catalog");
const { computePermissions, emptyPermissions } = require("./resolver");

/**
 * Permisos efectivos por request, con dos cachés:
 *
 *   - La foto de la configuración (asignaciones, conjuntos, áreas y
 *     personas): todas las tablas son chicas y se leen juntas. Se recarga
 *     cuando cambia `perm_meta.version` (que se consulta cada pocos segundos,
 *     así un cambio hecho en otro proceso vale en todos) o, como respaldo,
 *     al minuto.
 *   - El resultado por persona, hasta que cambie la foto o empiece/termine
 *     una vigencia que la afecta.
 *
 * Ante un error de base se queda con la última foto; sin ninguna, nadie
 * tiene permisos (salvo el login de emergencia).
 */

const VERSION_POLL_MS = 5 * 1000;
const SNAPSHOT_TTL_MS = 60 * 1000;
const RESULT_TTL_MS = 60 * 1000;

let snapshot = null; // { version, loadedAt, users, areas, sets, assignments }
let versionCheckedAt = 0;
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
    const [sets, items, assignments] = await Promise.all([
      db.query("SELECT id, code, name, active FROM perm_sets"),
      db.query(
        `SELECT set_id, permission_key, scope, scope_area_ids, scope_include_subareas
           FROM perm_set_items`,
      ),
      db.query(
        `SELECT id, principal_type, area_id, user_id, include_subareas, set_id,
                permission_key, scope, scope_area_ids, scope_include_subareas,
                effect, valid_from, valid_until
           FROM perm_assignments`,
      ),
    ]);
    const byId = new Map(sets.rows.map((s) => [Number(s.id), { ...s, id: Number(s.id), items: [] }]));
    for (const item of items.rows) {
      const set = byId.get(Number(item.set_id));
      if (set) set.items.push(item);
    }
    return { sets: byId, assignments: assignments.rows };
  } catch (err) {
    if (isMissingRelation(err)) return { sets: new Map(), assignments: [] };
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
    sets: config.sets,
    assignments: config.assignments,
  };
}

async function refreshSnapshot() {
  if (!loading) {
    loading = loadSnapshot()
      .then((fresh) => {
        snapshot = fresh;
        versionCheckedAt = Date.now();
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

/** Foto vigente, recargándola si otro proceso cambió la versión. */
async function getSnapshot() {
  const now = Date.now();
  if (!snapshot || now - snapshot.loadedAt > SNAPSHOT_TTL_MS) return refreshSnapshot();
  if (now - versionCheckedAt > VERSION_POLL_MS) {
    versionCheckedAt = now;
    try {
      if ((await fetchVersion()) !== snapshot.version) return refreshSnapshot();
    } catch (err) {
      logger.error("permisos", err);
    }
  }
  return snapshot;
}

/** Permisos efectivos de quien tiene sesión (o de cualquier usuario por id). */
async function resolve(user) {
  const catalog = getCatalog();
  if (!user || user.id == null) return emptyPermissions(catalog);
  if (Number(user.id) === 0) return computePermissions({}, user, { catalog });

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
 * Tras cambiar permisos, áreas, jefaturas o personas: este proceso recarga
 * en la próxima petición y los demás al ver la versión nueva. `client` para
 * subir la versión dentro de la transacción que hizo el cambio.
 */
async function invalidatePermissions(client = db) {
  snapshot = null;
  results.clear();
  try {
    await client.query("UPDATE perm_meta SET version = version + 1, updated_at = NOW() WHERE id = 1");
  } catch (err) {
    if (!isMissingRelation(err)) logger.error("permisos", err);
  }
}

module.exports = {
  resolve,
  invalidatePermissions,
  loadSnapshot,
};
