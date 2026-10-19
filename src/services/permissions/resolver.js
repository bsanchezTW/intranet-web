const { chainFrom, descendantIds } = require("../workAreaTree");
const { SCOPE } = require("./scopes");
const { canLogin, normalizeRole } = require("../../constants/roles");

/**
 * Permisos efectivos de una persona. Funciones puras sobre una foto de la
 * configuración (ver permissionService.loadSnapshot), para poder probar la
 * precedencia completa con datos en memoria.
 *
 * Precedencia, por cada permiso: se recorren los niveles de lo más
 * específico a lo más general, Usuario → Área / Jefes → Global. Se juntan las
 * concesiones de cada nivel y el recorrido se detiene en el primer nivel que
 * tenga una denegación: esa denegación anula las concesiones de su nivel y
 * las de abajo. Lo juntado hasta ahí es el permiso, y los alcances se suman.
 *
 *   Global concede; a Juan se le deniega            → Juan no lo tiene.
 *   Global concede; Comercial deniega; a Juan se
 *   le concede                                      → Juan sí; Comercial no.
 *
 * El superadmin tiene todo lo del catálogo del país y no se le puede denegar.
 */

const LEVEL = Object.freeze({ USER: 1, GROUP: 2, GLOBAL: 3 });
const LEVEL_NAMES = Object.freeze({ 1: "usuario", 2: "grupo", 3: "global" });

function toId(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function toTime(value) {
  if (value == null) return null;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(t) ? t : null;
}

/** Contexto organizacional de la persona: su área y las que tiene a cargo. */
function membershipFor(snapshot, userId, workAreaId) {
  const areas = snapshot.areas || [];
  const ownAreaId = toId(workAreaId);
  const ownChain = ownAreaId == null ? [] : chainFrom(areas, ownAreaId).map((a) => toId(a.id));
  const managedAreaIds = areas
    .filter((a) => toId(a.manager_user_id) === userId)
    .map((a) => toId(a.id));
  const managedSubtree = new Set(managedAreaIds);
  for (const id of managedAreaIds) {
    for (const d of descendantIds(areas, id)) managedSubtree.add(d);
  }
  return { ownAreaId, ownChain, managedAreaIds, managedSubtree };
}

/** ¿La asignación alcanza a esta persona? Devuelve su nivel o null. */
function levelFor(assignment, userId, member, areas) {
  switch (assignment.principal_type) {
    case "user":
      return toId(assignment.user_id) === userId ? LEVEL.USER : null;
    case "area": {
      const areaId = toId(assignment.area_id);
      if (member.ownAreaId == null || areaId == null) return null;
      if (member.ownAreaId === areaId) return LEVEL.GROUP;
      // Con subáreas: vale si su área cuelga (a cualquier profundidad) de ésta.
      return assignment.include_subareas && member.ownChain.includes(areaId) ? LEVEL.GROUP : null;
    }
    case "jefes": {
      if (!member.managedAreaIds.length) return null;
      const areaId = toId(assignment.area_id);
      if (areaId == null) return LEVEL.GROUP; // jefe de cualquier área
      if (member.managedAreaIds.includes(areaId)) return LEVEL.GROUP;
      if (!assignment.include_subareas) return null;
      const subtree = descendantIds(areas, areaId);
      return member.managedAreaIds.some((id) => subtree.has(id)) ? LEVEL.GROUP : null;
    }
    case "global":
      return LEVEL.GLOBAL;
    default:
      return null;
  }
}

function grantOf(row) {
  return {
    scope: row.scope || null,
    areaIds: (row.scope_area_ids || []).map(toId).filter((id) => id != null),
    includeSubareas: Boolean(row.scope_include_subareas),
  };
}

/** Expande una asignación vigente en entradas por clave. */
function entriesOf(assignment, level, snapshot) {
  const source = {
    assignmentId: toId(assignment.id),
    level: LEVEL_NAMES[level],
    principal: assignment.principal_type,
    areaId: toId(assignment.area_id),
    effect: assignment.effect,
  };
  if (assignment.set_id != null) {
    const set = snapshot.sets && snapshot.sets.get(toId(assignment.set_id));
    if (!set || set.active === false) return [];
    return (set.items || []).map((item) => ({
      key: item.permission_key,
      grant: grantOf(item),
      source: { ...source, setId: set.id, setCode: set.code, setName: set.name },
    }));
  }
  return [{ key: assignment.permission_key, grant: grantOf(assignment), source }];
}

/**
 * Cobertura de un permiso con alcance a partir de sus concesiones.
 * Una concesión con un alcance que el permiso no admite no cuenta.
 */
function coverageOf(definition, grants, member, areas) {
  const coverage = { all: false, own: false, areaIds: new Set() };
  for (const grant of grants) {
    if (!definition.scopes.includes(grant.scope)) continue;
    switch (grant.scope) {
      case SCOPE.TODO:
        coverage.all = true;
        break;
      case SCOPE.PROPIO:
        coverage.own = true;
        break;
      case SCOPE.MI_AREA:
        if (member.ownAreaId != null) coverage.areaIds.add(member.ownAreaId);
        break;
      case SCOPE.A_CARGO:
        for (const id of member.managedSubtree) coverage.areaIds.add(id);
        break;
      case SCOPE.AREAS:
        for (const id of grant.areaIds) {
          coverage.areaIds.add(id);
          if (grant.includeSubareas) for (const d of descendantIds(areas, id)) coverage.areaIds.add(d);
        }
        break;
      default:
        break;
    }
  }
  return coverage;
}

class EffectivePermissions {
  constructor({ userId, superadmin = false, catalog, granted = new Map(), stopped = new Map(), expiresAt = null }) {
    this.userId = userId;
    this.superadmin = superadmin;
    this.catalog = catalog;
    this.expiresAt = expiresAt;
    // Los pone permissionService con la foto: 'sombra' mientras manden las
    // reglas antiguas (ver decide.js), y si ya se aplicó el arranque.
    this.mode = "sombra";
    this.bootstrapped = false;
    // key → { plain: true } | { coverage }, más sus orígenes.
    this.granted = granted;
    this.stopped = stopped;
  }

  /** ¿Lo tiene, con algún alcance? Para mostrar menús y botones. */
  can(key) {
    const definition = this.catalog.byKey.get(key);
    if (!definition) return false;
    if (this.superadmin) return true;
    const entry = this.granted.get(key);
    if (!entry) return false;
    if (!definition.scopes) return true;
    const c = entry.coverage;
    return c.all || c.own || c.areaIds.size > 0;
  }

  /** Ver un dato sensible (`módulo.objeto.campo.dato`). */
  canSeeField(key) {
    return this.can(key);
  }

  /** { all, own, areaIds: [] } de un permiso con alcance, o null si no lo tiene. */
  coverage(key) {
    const definition = this.catalog.byKey.get(key);
    if (!definition || !definition.scopes) return null;
    if (this.superadmin) return { all: true, own: true, areaIds: [] };
    const entry = this.granted.get(key);
    if (!entry || !this.can(key)) return null;
    return { all: entry.coverage.all, own: entry.coverage.own, areaIds: [...entry.coverage.areaIds] };
  }

  /**
   * ¿Vale sobre este registro? `ownerId` es de quién es y `areaId` el área a
   * la que pertenece (la congelada al crearlo). Un permiso sin alcance vale
   * sobre todo. Las reglas propias del módulo (nadie aprueba lo suyo) van en
   * su política, no aquí.
   */
  canOnRecord(key, { ownerId = null, areaId = null } = {}) {
    if (!this.can(key)) return false;
    const definition = this.catalog.byKey.get(key);
    if (!definition.scopes || this.superadmin) return true;
    const c = this.granted.get(key).coverage;
    if (c.all) return true;
    if (c.own && ownerId != null && toId(ownerId) === this.userId) return true;
    return areaId != null && c.areaIds.has(toId(areaId));
  }

  /**
   * Filtro SQL para listados: `{ clause, params }` con placeholders desde
   * `firstParam`. Sin el permiso devuelve FALSE (no se lista nada).
   */
  sqlFilter(key, { ownerColumn, areaColumn, firstParam = 1 } = {}) {
    if (!this.can(key)) return { clause: "FALSE", params: [] };
    const definition = this.catalog.byKey.get(key);
    if (!definition.scopes || this.superadmin) return { clause: "TRUE", params: [] };
    const c = this.granted.get(key).coverage;
    if (c.all) return { clause: "TRUE", params: [] };

    const parts = [];
    const params = [];
    if (c.own && ownerColumn) {
      params.push(this.userId);
      parts.push(`${ownerColumn} = $${firstParam + params.length - 1}`);
    }
    if (c.areaIds.size && areaColumn) {
      params.push([...c.areaIds]);
      parts.push(`${areaColumn} = ANY($${firstParam + params.length - 1}::int[])`);
    }
    return parts.length ? { clause: `(${parts.join(" OR ")})`, params } : { clause: "FALSE", params: [] };
  }

  /** Claves que tiene, en el orden del catálogo. */
  keys() {
    return [...this.catalog.byKey.keys()].filter((key) => this.can(key));
  }

  /** Por qué tiene (o no) un permiso: para la ficha de usuario de Gestión de Permisos. */
  explain(key) {
    const definition = this.catalog.byKey.get(key) || null;
    const entry = this.granted.get(key);
    return {
      key,
      exists: Boolean(definition),
      granted: this.can(key),
      superadmin: this.superadmin,
      sources: entry ? entry.sources : [],
      deniedBy: this.stopped.get(key) || null,
      coverage: this.coverage(key),
    };
  }
}

/** Sin permisos (cuenta inactiva, sin datos o sin sesión). */
function emptyPermissions(catalog, userId = null) {
  return new EffectivePermissions({ userId, catalog });
}

/**
 * Permisos efectivos de `user` ({ id, role?, work_area_id? }) con la foto
 * `snapshot` ({ users: Map, areas, sets: Map, assignments }) y el catálogo
 * del país. `now` en ms (para las vigencias).
 */
function computePermissions(snapshot, user, { catalog, now = Date.now() } = {}) {
  const userId = toId(user && user.id);
  if (userId == null) return emptyPermissions(catalog);

  // El login de emergencia no existe en `users`: es superadmin por definición.
  if (userId === 0) return new EffectivePermissions({ userId, superadmin: true, catalog });

  const row = snapshot.users && snapshot.users.get(userId);
  if (!row || !canLogin(normalizeRole(row.role))) return emptyPermissions(catalog, userId);
  if (row.is_superadmin) return new EffectivePermissions({ userId, superadmin: true, catalog });

  const areas = snapshot.areas || [];
  const member = membershipFor(snapshot, userId, row.work_area_id);

  // Entradas vigentes por clave y nivel. `expiresAt`: la próxima vez que una
  // vigencia empieza o termina, para que el caché no la pase de largo.
  let expiresAt = null;
  const noteBoundary = (t) => {
    if (t != null && t > now && (expiresAt == null || t < expiresAt)) expiresAt = t;
  };
  const byKey = new Map();
  for (const assignment of snapshot.assignments || []) {
    const level = levelFor(assignment, userId, member, areas);
    if (level == null) continue;
    const from = toTime(assignment.valid_from);
    const until = toTime(assignment.valid_until);
    noteBoundary(from);
    noteBoundary(until);
    if ((from != null && from > now) || (until != null && until <= now)) continue;

    const deny = assignment.effect === "deniega";
    for (const entry of entriesOf(assignment, level, snapshot)) {
      if (!catalog.byKey.has(entry.key)) continue;
      if (!byKey.has(entry.key)) byKey.set(entry.key, { 1: [], 2: [], 3: [] });
      byKey.get(entry.key)[level].push({ deny, grant: entry.grant, source: entry.source });
    }
  }

  const granted = new Map();
  const stopped = new Map();
  for (const [key, levels] of byKey) {
    const grants = [];
    const sources = [];
    for (const level of [LEVEL.USER, LEVEL.GROUP, LEVEL.GLOBAL]) {
      const here = levels[level];
      const denial = here.find((e) => e.deny);
      if (denial) {
        stopped.set(key, denial.source);
        break;
      }
      for (const e of here) {
        grants.push(e.grant);
        sources.push(e.source);
      }
    }
    if (!grants.length) continue;
    const definition = catalog.byKey.get(key);
    granted.set(
      key,
      definition.scopes
        ? { coverage: coverageOf(definition, grants, member, areas), sources }
        : { plain: true, sources },
    );
  }

  return new EffectivePermissions({ userId, catalog, granted, stopped, expiresAt });
}

module.exports = {
  LEVEL,
  EffectivePermissions,
  emptyPermissions,
  computePermissions,
  membershipFor,
};
