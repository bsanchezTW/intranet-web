const db = require("../../db");
const { getCatalog } = require("./catalog");
const { SCOPE_LABELS } = require("./scopes");
const { loadSnapshot } = require("./permissionService");
const { computePermissions } = require("./resolver");

/**
 * Lecturas de las pantallas de Gestión de Permisos, ya con nombres para
 * mostrar ("Área Finanzas y sus subáreas", "Aprobar la etapa de Finanzas —
 * Toda la empresa").
 */

function fullName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || `Usuario ${u.id}`;
}

/** Áreas, personas y conjuntos, indexados para armar etiquetas. */
async function loadReferences() {
  const [areas, users, sets] = await Promise.all([
    db.query(
      `SELECT w.id, w.area_name, w.parent_area_id, w.manager_user_id, w.sort_order
         FROM work_areas w ORDER BY w.area_name`,
    ),
    db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.work_area_id,
              COALESCE(u.is_superadmin, FALSE) AS is_superadmin
         FROM users u
        ORDER BY u.first_name NULLS LAST, u.last_name NULLS LAST`,
    ),
    db.query(
      `SELECT s.id, s.code, s.name, s.description, s.active, s.updated_at,
              (SELECT count(*)::int FROM perm_set_items i WHERE i.set_id = s.id) AS item_count,
              (SELECT count(*)::int FROM perm_assignments a WHERE a.set_id = s.id) AS assignment_count
         FROM perm_sets s ORDER BY s.name`,
    ),
  ]);
  const people = users.rows.map((u) => ({ ...u, id: Number(u.id), name: fullName(u) }));
  return {
    areas: areas.rows.map((a) => ({ ...a, id: Number(a.id) })),
    areaById: new Map(areas.rows.map((a) => [Number(a.id), a])),
    users: people,
    userById: new Map(people.map((u) => [u.id, u])),
    sets: sets.rows.map((s) => ({ ...s, id: Number(s.id) })),
    setById: new Map(sets.rows.map((s) => [Number(s.id), s])),
  };
}

function areaName(refs, id) {
  const area = refs.areaById.get(Number(id));
  return area ? area.area_name : `Área #${id}`;
}

function principalLabel(a, refs) {
  switch (a.principal_type) {
    case "global":
      return "Todos";
    case "area":
      return `${areaName(refs, a.area_id)}${a.include_subareas ? " y sus subáreas" : ""}`;
    case "jefes":
      if (a.area_id == null) return "Jefes de área";
      return `Jefe de ${areaName(refs, a.area_id)}${a.include_subareas ? " y de sus subáreas" : ""}`;
    case "user": {
      const u = refs.userById.get(Number(a.user_id));
      return u ? u.name : `Usuario #${a.user_id}`;
    }
    default:
      return a.principal_type;
  }
}

function scopeLabel(row, refs) {
  if (!row.scope) return null;
  if (row.scope !== "areas") return SCOPE_LABELS[row.scope];
  const names = (row.scope_area_ids || []).map((id) => areaName(refs, id)).join(", ");
  return `${names}${row.scope_include_subareas ? " (con subáreas)" : ""}`;
}

function permissionLabel(key, catalog) {
  const p = catalog.byKey.get(key);
  return p ? p.label : `${key} (no existe en este país)`;
}

/** Fila de asignación con etiquetas para la pantalla. */
function describeAssignment(a, refs, catalog) {
  const set = a.set_id != null ? refs.setById.get(Number(a.set_id)) : null;
  const granter = a.granted_by != null ? refs.userById.get(Number(a.granted_by)) : null;
  return {
    ...a,
    id: Number(a.id),
    principalLabel: principalLabel(a, refs),
    targetLabel: set ? `Conjunto: ${set.name}` : permissionLabel(a.permission_key, catalog),
    isSet: Boolean(set),
    scopeLabel: a.set_id != null || a.effect === "deniega" ? null : scopeLabel(a, refs),
    grantedByName: granter ? granter.name : null,
    expired: a.valid_until != null && new Date(a.valid_until) <= new Date(),
    pending: a.valid_from != null && new Date(a.valid_from) > new Date(),
  };
}

const ASSIGNMENT_COLUMNS = `id, principal_type, area_id, user_id, include_subareas, set_id, permission_key,
  scope, scope_area_ids, scope_include_subareas, effect, valid_from, valid_until, note, granted_by, created_at`;

/** Asignaciones filtradas por destinatario o conjunto. */
async function listAssignments(filter = {}, refs, catalog = getCatalog()) {
  const where = [];
  const params = [];
  for (const [column, value] of Object.entries(filter)) {
    if (value === undefined) continue;
    if (value === null) {
      where.push(`${column} IS NULL`);
    } else {
      params.push(value);
      where.push(`${column} = $${params.length}`);
    }
  }
  const { rows } = await db.query(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM perm_assignments
      ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
      ORDER BY effect DESC, created_at DESC`,
    params,
  );
  return rows.map((a) => describeAssignment(a, refs, catalog));
}

/**
 * Quién tiene cada permiso: clave → [{ assignment, viaSet, scopeLabel }].
 * Incluye lo que llega por conjuntos, para la pantalla "Por módulo".
 */
async function whoHasByKey(refs, catalog = getCatalog()) {
  const [{ rows: assignments }, { rows: items }] = await Promise.all([
    db.query(`SELECT ${ASSIGNMENT_COLUMNS} FROM perm_assignments ORDER BY created_at`),
    db.query("SELECT set_id, permission_key, scope, scope_area_ids, scope_include_subareas FROM perm_set_items"),
  ]);
  const itemsBySet = new Map();
  for (const i of items) {
    const id = Number(i.set_id);
    if (!itemsBySet.has(id)) itemsBySet.set(id, []);
    itemsBySet.get(id).push(i);
  }
  const byKey = new Map();
  const push = (key, entry) => {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(entry);
  };
  for (const raw of assignments) {
    const a = describeAssignment(raw, refs, catalog);
    if (a.set_id != null) {
      const set = refs.setById.get(Number(a.set_id));
      for (const i of itemsBySet.get(Number(a.set_id)) || []) {
        push(i.permission_key, {
          assignment: a,
          viaSet: set ? set.name : null,
          scopeLabel: a.effect === "deniega" ? null : scopeLabel(i, refs),
        });
      }
    } else {
      push(a.permission_key, { assignment: a, viaSet: null, scopeLabel: a.scopeLabel });
    }
  }
  return byKey;
}

async function getSet(setId, refs) {
  const set = refs.setById.get(Number(setId));
  if (!set) return null;
  const { rows: items } = await db.query(
    `SELECT permission_key, scope, scope_area_ids, scope_include_subareas
       FROM perm_set_items WHERE set_id = $1 ORDER BY permission_key, scope`,
    [setId],
  );
  return { ...set, items };
}

async function listAudit({ limit = 100, offset = 0 } = {}, refs) {
  const { rows } = await db.query(
    `SELECT id, occurred_at, actor_user_id, action, entity_type, entity_id, old_value, new_value, note
       FROM perm_audit ORDER BY occurred_at DESC, id DESC LIMIT $1 OFFSET $2`,
    [limit + 1, offset],
  );
  return {
    hasMore: rows.length > limit,
    rows: rows.slice(0, limit).map((r) => ({
      ...r,
      actorName:
        r.actor_user_id == null ? "Sistema" : refs.userById.get(Number(r.actor_user_id))?.name || `Usuario #${r.actor_user_id}`,
    })),
  };
}

/**
 * Ficha de una persona: sus asignaciones directas y, por cada permiso del
 * catálogo, si lo tiene, con qué alcance y de dónde viene (o qué lo denegó).
 * Usa una foto fresca de la base, no el caché.
 */
async function userDetail(userId, refs, catalog = getCatalog()) {
  const user = refs.userById.get(Number(userId));
  if (!user) return null;

  const snapshot = await loadSnapshot();
  const perms = computePermissions(snapshot, { id: user.id }, { catalog });
  const byId = new Map((snapshot.assignments || []).map((a) => [Number(a.id), describeAssignment(a, refs, catalog)]));
  const sourceLabel = (s) => {
    if (!s) return null;
    const a = byId.get(Number(s.assignmentId));
    const via = s.setName ? `conjunto «${s.setName}»` : "permiso suelto";
    return `${via} · ${a ? a.principalLabel : s.principal}`;
  };

  const modules = catalog.modules.map((mod) => ({
    module: mod.module,
    label: mod.label,
    permissions: mod.permissions.map((p) => {
      const e = perms.explain(p.key);
      let alcance = null;
      if (e.granted && p.scopes) {
        const c = e.coverage;
        alcance = c.all
          ? SCOPE_LABELS.todo
          : [c.own ? SCOPE_LABELS.propio : null, c.areaIds.length ? c.areaIds.map((id) => areaName(refs, id)).join(", ") : null]
              .filter(Boolean)
              .join(" + ");
      }
      return {
        key: p.key,
        label: p.label,
        granted: e.granted,
        alcance,
        origins: e.superadmin ? ["superadmin"] : e.sources.map(sourceLabel),
        deniedBy: e.deniedBy ? sourceLabel(e.deniedBy) : null,
      };
    }),
  }));

  const area = user.work_area_id != null ? refs.areaById.get(Number(user.work_area_id)) : null;
  const managed = refs.areas.filter((a) => Number(a.manager_user_id) === user.id);
  const direct = (snapshot.assignments || [])
    .filter((a) => a.principal_type === "user" && Number(a.user_id) === user.id)
    .map((a) => byId.get(Number(a.id)));

  return {
    user,
    area,
    managed,
    superadmin: perms.superadmin,
    direct,
    modules,
    grantedCount: perms.keys().length,
  };
}

module.exports = {
  loadReferences,
  listAssignments,
  whoHasByKey,
  getSet,
  listAudit,
  userDetail,
  principalLabel,
  scopeLabel,
  describeAssignment,
};
