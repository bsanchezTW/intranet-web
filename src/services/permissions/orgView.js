const { chainFrom, descendantIds, buildTree } = require("../workAreaTree");

/**
 * El organigrama tal como pesa en los permisos: quién trabaja en cada área,
 * quién la dirige y qué jefes hay por encima. Funciones puras sobre
 * loadReferences() (refs.areas, refs.users), para las pantallas de Gestión
 * de Permisos. Los alcances "mi área" y "a cargo" y el grupo Jefes salen de
 * aquí: verlo explica por qué alguien tiene lo que tiene.
 */

function toId(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function isActive(u) {
  return Boolean(u) && !/^deshabilitado$/i.test(String(u.role || "").trim());
}

/** Jefes de la cadena desde `areaId` hacia arriba, sin repetir persona. */
function managersUp(refs, areaId, { skipUserId = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const area of chainFrom(refs.areas, areaId)) {
    const managerId = toId(area.manager_user_id);
    if (managerId == null || managerId === toId(skipUserId) || seen.has(managerId)) continue;
    seen.add(managerId);
    out.push({ area, manager: refs.userById.get(managerId) || { id: managerId, name: `Usuario #${managerId}` } });
  }
  return out;
}

/** Personas activas por área. */
function membersByArea(refs) {
  const byArea = new Map();
  for (const u of refs.users) {
    const areaId = toId(u.work_area_id);
    if (areaId == null || !isActive(u)) continue;
    if (!byArea.has(areaId)) byArea.set(areaId, []);
    byArea.get(areaId).push(u);
  }
  return byArea;
}

/**
 * Árbol de áreas para pintar, cada nodo con:
 *   manager        jefe del área (o null)
 *   above          jefes por encima, del más cercano al más alto
 *   members        quienes trabajan en ella
 *   subtreeCount   personas en ella y en todo lo que cuelga
 *   assignments    asignaciones hechas al área (si se pasan los conteos)
 */
function orgTree(refs, { assignmentCounts = new Map() } = {}) {
  const members = membersByArea(refs);
  const decorate = (node) => {
    const id = toId(node.id);
    const managerId = toId(node.manager_user_id);
    const children = (node.children || []).map(decorate);
    const own = members.get(id) || [];
    const subtreeCount = own.length + children.reduce((n, c) => n + c.subtreeCount, 0);
    return {
      ...node,
      id,
      children,
      manager: managerId != null ? refs.userById.get(managerId) || null : null,
      above: toId(node.parent_area_id) != null ? managersUp(refs, node.parent_area_id) : [],
      members: own,
      subtreeCount,
      assignments: assignmentCounts.get(id) || 0,
    };
  };
  return buildTree(refs.areas).map(decorate);
}

/** Un área y su lugar en el organigrama. */
function areaInOrg(refs, areaId) {
  const id = toId(areaId);
  const area = refs.areaById.get(id);
  if (!area) return null;
  const managerId = toId(area.manager_user_id);
  const members = membersByArea(refs);
  const children = refs.areas.filter((a) => toId(a.parent_area_id) === id);
  const below = descendantIds(refs.areas, id);
  let belowCount = 0;
  for (const d of below) belowCount += (members.get(d) || []).length;
  return {
    area,
    manager: managerId != null ? refs.userById.get(managerId) || null : null,
    above: toId(area.parent_area_id) != null ? managersUp(refs, area.parent_area_id) : [],
    path: chainFrom(refs.areas, id).reverse(),
    members: members.get(id) || [],
    children: children.map((c) => ({
      area: c,
      manager: toId(c.manager_user_id) != null ? refs.userById.get(toId(c.manager_user_id)) || null : null,
      count: (members.get(toId(c.id)) || []).length,
    })),
    belowCount,
  };
}

/**
 * Una persona en el organigrama:
 *   area        donde trabaja
 *   path        de la raíz a su área
 *   bosses      sus jefes, del directo hacia arriba (sin ella misma)
 *   manages     áreas que dirige
 *   underAreas  todas las áreas a su cargo (las que dirige y lo que cuelga)
 *   underCount  personas en esas áreas, sin contarla
 */
function personInOrg(refs, userId) {
  const id = toId(userId);
  const user = refs.userById.get(id);
  if (!user) return null;
  const areaId = toId(user.work_area_id);
  const manages = refs.areas.filter((a) => toId(a.manager_user_id) === id);
  const under = new Set();
  for (const a of manages) {
    under.add(toId(a.id));
    for (const d of descendantIds(refs.areas, a.id)) under.add(d);
  }
  const members = membersByArea(refs);
  let underCount = 0;
  for (const a of under) underCount += (members.get(a) || []).filter((u) => u.id !== id).length;
  return {
    area: areaId != null ? refs.areaById.get(areaId) || null : null,
    path: areaId != null ? chainFrom(refs.areas, areaId).reverse() : [],
    bosses: areaId != null ? managersUp(refs, areaId, { skipUserId: id }) : [],
    manages,
    underAreas: [...under].map((a) => refs.areaById.get(a)).filter(Boolean),
    underCount,
  };
}

module.exports = {
  managersUp,
  membersByArea,
  orgTree,
  areaInOrg,
  personInOrg,
};
