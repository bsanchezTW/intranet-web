/**
 * Organigrama de áreas: funciones puras sobre las filas de work_areas
 * ({ id, parent_area_id, manager_user_id, ... }). Sin base de datos, para
 * poder probar el recorrido completo con datos en memoria.
 *
 * La jefatura no se copia hacia abajo: el jefe de un área padre sólo aprueba
 * lo de un área hija cuando ésta no tiene jefe, o cuando quien solicita es
 * ese mismo jefe (nadie se aprueba a sí mismo).
 */

function toId(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function indexAreas(areas) {
  const byId = new Map();
  for (const area of areas || []) {
    const id = toId(area.id);
    if (id != null) byId.set(id, area);
  }
  return byId;
}

/**
 * Áreas desde `areaId` hasta la raíz, empezando por la propia. Un ciclo en
 * datos corruptos corta el recorrido en vez de colgar la petición.
 */
function chainFrom(areas, areaId) {
  const byId = areas instanceof Map ? areas : indexAreas(areas);
  const chain = [];
  const seen = new Set();
  let current = toId(areaId);
  while (current != null && byId.has(current) && !seen.has(current)) {
    seen.add(current);
    const area = byId.get(current);
    chain.push(area);
    current = toId(area.parent_area_id);
  }
  return chain;
}

/**
 * Aprobador de primera etapa para quien solicita desde `areaId`:
 *
 *   { ok: true, managerId, approverAreaId, requiresAdmin: false }
 *       → primer jefe de la cadena que no es el solicitante.
 *   { ok: true, managerId: null, requiresAdmin: true }
 *       → el solicitante es el único jefe de su cadena; lo resuelve un admin.
 *   { ok: false, reason: "no_area" | "no_manager" }
 *       → sin área, o nadie en la cadena tiene jefe: no se puede enviar.
 */
function resolveApproverFromChain(areas, areaId, requesterId) {
  const chain = chainFrom(areas, areaId);
  if (!chain.length) return { ok: false, reason: "no_area" };

  const requester = toId(requesterId);
  let requesterIsManager = false;
  for (const area of chain) {
    const managerId = toId(area.manager_user_id);
    if (managerId == null) continue;
    if (managerId === requester) {
      requesterIsManager = true;
      continue;
    }
    return {
      ok: true,
      managerId,
      approverAreaId: toId(area.id),
      requiresAdmin: false,
    };
  }

  if (requesterIsManager) {
    return { ok: true, managerId: null, approverAreaId: null, requiresAdmin: true };
  }
  return { ok: false, reason: "no_manager" };
}

/** Ids de todas las áreas que cuelgan de `areaId`, a cualquier profundidad. */
function descendantIds(areas, areaId) {
  const root = toId(areaId);
  const children = new Map();
  for (const area of areas || []) {
    const parent = toId(area.parent_area_id);
    if (parent == null) continue;
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(toId(area.id));
  }

  const found = new Set();
  const stack = [...(children.get(root) || [])];
  while (stack.length) {
    const id = stack.pop();
    if (id == null || id === root || found.has(id)) continue;
    found.add(id);
    stack.push(...(children.get(id) || []));
  }
  return found;
}

/** ¿Colgar `areaId` de `parentId` cerraría un ciclo? */
function wouldCreateCycle(areas, areaId, parentId) {
  const id = toId(areaId);
  const parent = toId(parentId);
  if (parent == null) return false;
  if (parent === id) return true;
  return descendantIds(areas, id).has(parent);
}

/**
 * Árbol para pintar: raíces con `children` ordenados por nombre. Un área cuyo
 * padre no existe, o que quedó dentro de un ciclo, se dibuja como raíz para
 * que no desaparezca de la pantalla.
 */
function buildTree(areas, { sortBy = (a, b) => String(a.area_name || "").localeCompare(String(b.area_name || ""), "es") } = {}) {
  const list = areas || [];
  const byId = indexAreas(list);
  const nodes = new Map();
  for (const area of list) {
    const id = toId(area.id);
    if (id != null) nodes.set(id, { ...area, children: [] });
  }

  const roots = [];
  for (const [id, node] of nodes) {
    const parent = toId(node.parent_area_id);
    const chain = chainFrom(byId, id);
    const last = chain[chain.length - 1];
    const reachesRoot = last && toId(last.parent_area_id) == null;
    if (parent != null && nodes.has(parent) && reachesRoot) {
      nodes.get(parent).children.push(node);
    } else {
      roots.push(node);
    }
  }

  const sortDeep = (items, depth) => {
    items.sort(sortBy);
    for (const item of items) {
      item.depth = depth;
      sortDeep(item.children, depth + 1);
    }
  };
  sortDeep(roots, 0);
  return roots;
}

module.exports = {
  chainFrom,
  resolveApproverFromChain,
  descendantIds,
  wouldCreateCycle,
  buildTree,
};
