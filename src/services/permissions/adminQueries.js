const db = require("../../db");
const { getCatalog } = require("./catalog");
const { SCOPE_LABELS } = require("./scopes");
const { loadSnapshot } = require("./permissionService");
const { computePermissions } = require("./resolver");
const { personInOrg } = require("./orgView");

/**
 * Lecturas de las pantallas de Gestión de Permisos, ya con nombres para
 * mostrar ("Área Finanzas y sus subáreas", "Aprobar la etapa de Finanzas —
 * Toda la empresa").
 */

function fullName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || u.email || `Usuario ${u.id}`;
}

/** Áreas, personas y conjuntos de personas, indexados para armar etiquetas. */
async function loadReferences() {
  const [areas, users, groups] = await Promise.all([
    db.query(
      `SELECT w.id, w.area_name, w.parent_area_id, w.manager_user_id, w.sort_order, w.color
         FROM work_areas w ORDER BY w.area_name`,
    ),
    db.query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.active, u.work_area_id,
              COALESCE(u.is_superadmin, FALSE) AS is_superadmin
         FROM users u
        ORDER BY u.first_name NULLS LAST, u.last_name NULLS LAST`,
    ),
    db.query(
      `SELECT g.id, g.name, g.description, g.updated_at,
              (SELECT count(*)::int FROM perm_group_members m WHERE m.group_id = g.id) AS member_count,
              (SELECT count(*)::int FROM perm_assignments a WHERE a.group_id = g.id) AS assignment_count
         FROM perm_groups g ORDER BY LOWER(g.name)`,
    ),
  ]);
  const people = users.rows.map((u) => ({ ...u, id: Number(u.id), name: fullName(u) }));
  return {
    areas: areas.rows.map((a) => ({ ...a, id: Number(a.id) })),
    areaById: new Map(areas.rows.map((a) => [Number(a.id), a])),
    users: people,
    userById: new Map(people.map((u) => [u.id, u])),
    groups: groups.rows.map((g) => ({ ...g, id: Number(g.id) })),
    groupById: new Map(groups.rows.map((g) => [Number(g.id), { ...g, id: Number(g.id) }])),
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
    case "grupo": {
      const g = refs.groupById && refs.groupById.get(Number(a.group_id));
      return `Conjunto «${g ? g.name : `#${a.group_id}`}»`;
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
  const granter = a.granted_by != null ? refs.userById.get(Number(a.granted_by)) : null;
  return {
    ...a,
    id: Number(a.id),
    principalLabel: principalLabel(a, refs),
    targetLabel: permissionLabel(a.permission_key, catalog),
    scopeLabel: a.effect === "deniega" ? null : scopeLabel(a, refs),
    grantedByName: granter ? granter.name : null,
    expired: a.valid_until != null && new Date(a.valid_until) <= new Date(),
    pending: a.valid_from != null && new Date(a.valid_from) > new Date(),
  };
}

const ASSIGNMENT_COLUMNS = `id, principal_type, area_id, user_id, group_id, include_subareas, permission_key,
  scope, scope_area_ids, scope_include_subareas, effect, valid_from, valid_until, note, granted_by, created_at`;

/** Asignaciones filtradas por destinatario (las de antiguos conjuntos de permisos, no). */
async function listAssignments(filter = {}, refs, catalog = getCatalog()) {
  const where = ["set_id IS NULL"];
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
      WHERE ${where.join(" AND ")}
      ORDER BY effect DESC, created_at DESC`,
    params,
  );
  return rows.map((a) => describeAssignment(a, refs, catalog));
}

/** Quién tiene cada permiso asignado: clave → [{ assignment, scopeLabel }]. */
async function whoHasByKey(refs, catalog = getCatalog()) {
  const { rows } = await db.query(
    `SELECT ${ASSIGNMENT_COLUMNS} FROM perm_assignments WHERE set_id IS NULL ORDER BY effect DESC, created_at`,
  );
  const byKey = new Map();
  for (const raw of rows) {
    const a = describeAssignment(raw, refs, catalog);
    if (!byKey.has(a.permission_key)) byKey.set(a.permission_key, []);
    byKey.get(a.permission_key).push({ assignment: a, scopeLabel: a.scopeLabel });
  }
  return byKey;
}

/** Un conjunto de personas: sus miembros y los permisos que tiene asignados. */
async function getGroup(groupId, refs, catalog = getCatalog()) {
  const group = refs.groupById.get(Number(groupId));
  if (!group) return null;
  const { rows } = await db.query(
    "SELECT user_id, added_at FROM perm_group_members WHERE group_id = $1",
    [group.id],
  );
  const members = rows
    .map((r) => refs.userById.get(Number(r.user_id)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
  const assignments = await listAssignments({ group_id: group.id }, refs, catalog);
  return { ...group, members, assignments };
}

/** Conjuntos de personas a los que pertenece alguien. */
async function groupsOfUser(userId, refs) {
  const { rows } = await db.query("SELECT group_id FROM perm_group_members WHERE user_id = $1", [Number(userId)]);
  return rows
    .map((r) => refs.groupById.get(Number(r.group_id)))
    .filter(Boolean)
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
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

/** "Todos", "Finanzas", "Conjunto «Aprobadores»", "a la persona": de dónde le llega algo a alguien. */
function sourceLabeler(snapshot, refs, catalog) {
  const byId = new Map((snapshot.assignments || []).map((a) => [Number(a.id), describeAssignment(a, refs, catalog)]));
  return (s) => {
    if (!s) return null;
    if (s.principal === "user") return "a la persona";
    const a = byId.get(Number(s.assignmentId));
    return a ? a.principalLabel : s.principal;
  };
}

/** Sobre qué registros vale un permiso con alcance, en palabras. */
function alcanceLabel(e, definition, refs) {
  if (!e.granted || !definition || !definition.scopes) return null;
  const c = e.coverage;
  if (c.all) return SCOPE_LABELS.todo;
  return [c.own ? SCOPE_LABELS.propio : null, c.areaIds.length ? c.areaIds.map((id) => areaName(refs, id)).join(", ") : null]
    .filter(Boolean)
    .join(" + ");
}

/**
 * Cómo se le quita a una persona un permiso que hoy tiene, según de dónde le
 * llega (`sources` de explain):
 *
 *   { mode: "quitar", deleteIds }   sólo por asignaciones suyas: se borran.
 *   { mode: "denegar", deleteIds }  también por su área, los jefes, todos o
 *                                   un conjunto de personas: se borran sus
 *                                   asignaciones de esa clave y se le
 *                                   deniega sólo a ella. El resto del área o
 *                                   del conjunto no se toca.
 */
function removalPlan(sources) {
  const deleteIds = [];
  let needsDeny = false;
  for (const s of sources || []) {
    if (s.principal === "user") deleteIds.push(Number(s.assignmentId));
    else needsDeny = true;
  }
  return { mode: needsDeny ? "denegar" : "quitar", deleteIds: [...new Set(deleteIds)] };
}

/**
 * Quiénes tienen hoy cada clave de `keys`, persona por persona, con su origen
 * y cómo quitárselo; y a quiénes se les denegó. Los superadmins no se listan:
 * tienen todo. Una sola foto de la base para todas las claves.
 */
async function holdersByKey(keys, refs, catalog = getCatalog(), snapshot = null) {
  const snap = snapshot || (await loadSnapshot());
  const label = sourceLabeler(snap, refs, catalog);
  const out = new Map(keys.map((k) => [k, { granted: [], denied: [] }]));
  for (const user of refs.users) {
    const perms = computePermissions(snap, { id: user.id }, { catalog });
    if (perms.superadmin) continue;
    for (const key of keys) {
      const e = perms.explain(key);
      const area = user.work_area_id != null ? refs.areaById.get(Number(user.work_area_id)) : null;
      if (e.granted) {
        out.get(key).granted.push({
          user,
          areaName: area ? area.area_name : null,
          alcance: alcanceLabel(e, catalog.byKey.get(key), refs),
          origins: e.sources.map(label),
          removal: removalPlan(e.sources),
        });
      } else if (e.deniedBy) {
        const d = e.deniedBy;
        out.get(key).denied.push({
          user,
          areaName: area ? area.area_name : null,
          deniedBy: label(d),
          // Una denegación hecha a la persona se quita aquí; la de un área o de
          // todos, en su página.
          assignmentId: d.principal === "user" ? Number(d.assignmentId) : null,
        });
      }
    }
  }
  return out;
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
  const sourceLabel = sourceLabeler(snapshot, refs, catalog);

  const modules = catalog.modules.map((mod) => ({
    module: mod.module,
    label: mod.label,
    permissions: mod.permissions.map((p) => {
      const e = perms.explain(p.key);
      const alcance = alcanceLabel(e, p, refs);
      return {
        key: p.key,
        label: p.label,
        granted: e.granted,
        alcance,
        origins: e.superadmin ? ["superadmin"] : e.sources.map(sourceLabel),
        deniedBy: e.deniedBy ? sourceLabel(e.deniedBy) : null,
        removal: e.granted && !e.superadmin ? removalPlan(e.sources) : null,
        denialId: e.deniedBy && e.deniedBy.principal === "user" ? Number(e.deniedBy.assignmentId) : null,
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
    groups: await groupsOfUser(user.id, refs),
    superadmin: perms.superadmin,
    direct,
    modules,
    grantedCount: perms.keys().length,
    org: personInOrg(refs, user.id),
  };
}

module.exports = {
  loadReferences,
  listAssignments,
  whoHasByKey,
  holdersByKey,
  removalPlan,
  getGroup,
  groupsOfUser,
  listAudit,
  userDetail,
  principalLabel,
  scopeLabel,
  describeAssignment,
};
