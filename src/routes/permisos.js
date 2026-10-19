const express = require("express");
const router = express.Router();
const db = require("../db");
const logger = require("../utils/logger");
const { getCatalog } = require("../services/permissions/catalog");
const { SCOPE_LABELS } = require("../services/permissions/scopes");
const store = require("../services/permissions/store");
const queries = require("../services/permissions/adminQueries");
const { recentMismatches } = require("../services/permissions/decide");
const { buildTree } = require("../services/workAreaTree");
const { loadSnapshot } = require("../services/permissions/permissionService");
const { computePermissions } = require("../services/permissions/resolver");
const { orgTree, areaInOrg, managersUp } = require("../services/permissions/orgView");
const { withQueryParam } = require("../utils/returnTo");

/**
 * Gestión de Permisos (/permisos). Sólo el superadmin entra: para el resto la
 * página no existe (404), igual que un módulo apagado.
 *
 *   /permisos                 resumen y superadmins
 *   /permisos/modulos         cada permiso del catálogo, quién lo tiene y quitárselo
 *   /permisos/quitar          quitarle un permiso a una persona
 *   /permisos/conjuntos       conjuntos con nombre y sus permisos
 *   /permisos/global          lo asignado a todos
 *   /permisos/areas[/:id]     el organigrama y lo asignado a cada área
 *   /permisos/jefes           lo asignado a los jefes de área
 *   /permisos/usuarios[/:id]  ficha: asignaciones y permisos efectivos con su origen
 *   /permisos/auditoria       quién cambió qué
 */

const BASE = "/permisos";
const CSS = ["/css/permisos.css?v=20261020a"];
const JS = ["/js/permisos.js?v=20261020a"];

router.use((req, res, next) => {
  if (req.perms && req.perms.superadmin) return next();
  return res.status(404).render("404", { titulo: "Página no encontrada" });
});

function actorId(req) {
  const id = Number(req.session.user && req.session.user.id);
  return id > 0 ? id : null;
}

/** Vuelta a una ruta de este módulo con aviso. */
function volver(req, fallback) {
  const raw = String((req.body && req.body.volver) || "");
  return raw.startsWith(`${BASE}`) && !raw.startsWith("//") ? raw : fallback;
}

function ok(res, to, msg) {
  return res.redirect(withQueryParam(to, "ok", msg));
}

function fail(res, to, err) {
  if (!(err instanceof store.PermissionInputError)) logger.error("permisos", err);
  const msg = err instanceof store.PermissionInputError ? err.message : "No se pudo guardar el cambio.";
  return res.redirect(withQueryParam(to, "error", msg));
}

function flash(req) {
  return { success: req.query.ok || null, error: req.query.error || null };
}

/** Lo que todas las vistas usan para los formularios de asignación. */
async function baseContext(req) {
  const catalog = getCatalog();
  const refs = await queries.loadReferences();
  return {
    catalog,
    refs,
    scopeLabels: SCOPE_LABELS,
    areaTree: buildTree(refs.areas),
    activeUsers: refs.users.filter((u) => !/^deshabilitado$/i.test(String(u.role || "").trim())),
    actorId: actorId(req),
    extraCss: CSS,
    extraJs: JS,
    ...flash(req),
  };
}

function render(res, view, titulo, seccion, ctx) {
  res.render(`permisos/${view}`, { titulo, seccion, ...ctx });
}

// --- Resumen -------------------------------------------------------------

router.get("/", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    const [{ rows: meta }, { rows: totals }] = await Promise.all([
      db.query("SELECT version, mode, bootstrapped_at FROM perm_meta WHERE id = 1"),
      db.query(
        `SELECT count(*) FILTER (WHERE effect = 'concede')::int AS concede,
                count(*) FILTER (WHERE effect = 'deniega')::int AS deniega
           FROM perm_assignments`,
      ),
    ]);
    render(res, "index", "Gestión de permisos", "inicio", {
      ...ctx,
      meta: meta[0] || null,
      totals: totals[0] || { concede: 0, deniega: 0 },
      superadmins: ctx.refs.users.filter((u) => u.is_superadmin),
      permissionCount: ctx.catalog.byKey.size,
      diferencias: recentMismatches().slice(0, 50).map((d) => ({
        ...d,
        userName: ctx.refs.userById.get(Number(d.userId))?.name || `Usuario #${d.userId}`,
        label: ctx.catalog.byKey.get(d.key)?.label || d.key,
      })),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/superadmin", async (req, res) => {
  const to = volver(req, BASE);
  try {
    await store.setSuperadmin(req.body.user_id, req.body.valor === "1", actorId(req));
    return ok(res, to, req.body.valor === "1" ? "Superadmin agregado" : "Superadmin quitado");
  } catch (err) {
    return fail(res, to, err);
  }
});

// --- Por módulo ----------------------------------------------------------

router.get("/modulos", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    const whoHas = await queries.whoHasByKey(ctx.refs, ctx.catalog);
    const modulo = String(req.query.modulo || "");
    const modules = ctx.catalog.modules;
    const current = modules.find((m) => m.module === modulo) || modules[0];
    // Persona por persona, sólo para el módulo que se mira.
    const holders = await queries.holdersByKey(current.permissions.map((p) => p.key), ctx.refs, ctx.catalog);
    render(res, "modulos", "Permisos", "modulos", { ...ctx, modules, current, whoHas, holders });
  } catch (err) {
    next(err);
  }
});

/**
 * Quitarle un permiso a una persona, venga de donde venga (ver
 * adminQueries.removalPlan). Se decide con una foto fresca de la base.
 */
router.post("/quitar", async (req, res) => {
  const to = volver(req, `${BASE}/modulos`);
  try {
    const catalog = getCatalog();
    const key = String(req.body.permission_key || "");
    const userId = Number(req.body.user_id);
    const snapshot = await loadSnapshot();
    const perms = computePermissions(snapshot, { id: userId }, { catalog });
    if (perms.superadmin) {
      throw new store.PermissionInputError("Un superadmin tiene todos los permisos: quítale primero la marca de superadmin.");
    }
    const e = perms.explain(key);
    if (!e.granted) return ok(res, to, "Esa persona ya no tenía el permiso");
    const plan = queries.removalPlan(e.sources, snapshot, key);
    await store.revokeFromUser(
      {
        userId,
        permissionKey: key,
        deleteIds: plan.deleteIds,
        deny: plan.mode === "denegar",
        note: String(req.body.note || "").trim() || "Quitado desde Gestión de permisos",
      },
      actorId(req),
      { catalog },
    );
    return ok(res, to, plan.mode === "denegar" ? "Permiso quitado: se le denegó sólo a esa persona" : "Permiso quitado");
  } catch (err) {
    return fail(res, to, err);
  }
});

// --- Conjuntos -----------------------------------------------------------

router.get("/conjuntos", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    render(res, "conjuntos", "Conjuntos de permisos", "conjuntos", ctx);
  } catch (err) {
    next(err);
  }
});

router.post("/conjuntos", async (req, res) => {
  try {
    const set = await store.createSet(req.body, actorId(req));
    return ok(res, `${BASE}/conjuntos/${set.id}`, "Conjunto creado: elige sus permisos");
  } catch (err) {
    return fail(res, `${BASE}/conjuntos`, err);
  }
});

router.get("/conjuntos/:id", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    const set = await queries.getSet(req.params.id, ctx.refs);
    if (!set) return res.redirect(withQueryParam(`${BASE}/conjuntos`, "error", "El conjunto ya no existe"));
    const assignments = await queries.listAssignments({ set_id: set.id }, ctx.refs, ctx.catalog);
    return render(res, "conjunto", set.name, "conjuntos", { ...ctx, set, assignments });
  } catch (err) {
    return next(err);
  }
});

router.post("/conjuntos/:id", async (req, res) => {
  const to = `${BASE}/conjuntos/${req.params.id}`;
  try {
    await store.updateSet(req.params.id, { ...req.body, active: req.body.active === "1" }, actorId(req));
    return ok(res, to, "Conjunto actualizado");
  } catch (err) {
    return fail(res, to, err);
  }
});

/**
 * Los permisos del conjunto llegan como campos sueltos por clave:
 *   perm=<clave>                      permiso sin alcance marcado
 *   scope:<clave>=<alcance> (varios)  permiso con alcance, uno por alcance
 *   areas:<clave>=<id> (varios)       áreas del alcance "areas"
 *   subareas:<clave>=1                incluir sus subáreas
 */
function itemsFromBody(body) {
  const list = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
  const items = list(body.perm).map((key) => ({ permission_key: key, scope: null }));
  for (const [field, value] of Object.entries(body)) {
    if (!field.startsWith("scope:")) continue;
    const key = field.slice("scope:".length);
    for (const scope of list(value)) {
      items.push({
        permission_key: key,
        scope,
        scope_area_ids: scope === "areas" ? list(body[`areas:${key}`]) : [],
        scope_include_subareas: scope === "areas" && body[`subareas:${key}`] === "1",
      });
    }
  }
  return items;
}

router.post("/conjuntos/:id/permisos", async (req, res) => {
  const to = `${BASE}/conjuntos/${req.params.id}`;
  try {
    const items = await store.replaceSetItems(req.params.id, itemsFromBody(req.body), actorId(req));
    return ok(res, to, `Permisos guardados (${items.length})`);
  } catch (err) {
    return fail(res, to, err);
  }
});

router.post("/conjuntos/:id/eliminar", async (req, res) => {
  try {
    await store.deleteSet(req.params.id, actorId(req));
    return ok(res, `${BASE}/conjuntos`, "Conjunto eliminado");
  } catch (err) {
    return fail(res, `${BASE}/conjuntos/${req.params.id}`, err);
  }
});

// --- Destinatarios: Global, Áreas, Jefes ------------------------------------

router.get("/global", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    const assignments = await queries.listAssignments({ principal_type: "global" }, ctx.refs, ctx.catalog);
    render(res, "destinatario", "Permisos globales", "global", {
      ...ctx,
      assignments,
      principal: { type: "global", label: "Todos", desc: "Toda cuenta activa de la intranet." },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/jefes", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    const assignments = await queries.listAssignments({ principal_type: "jefes" }, ctx.refs, ctx.catalog);
    // Quiénes son hoy los jefes, qué dirigen y quién está por encima de ellos.
    const porJefe = new Map();
    for (const area of ctx.refs.areas) {
      const id = Number(area.manager_user_id);
      if (!id) continue;
      if (!porJefe.has(id)) porJefe.set(id, []);
      porJefe.get(id).push(area);
    }
    const jefes = [...porJefe.entries()]
      .map(([id, areas]) => ({
        user: ctx.refs.userById.get(id) || { id, name: `Usuario #${id}` },
        areas,
        above: areas[0] && areas[0].parent_area_id != null ? managersUp(ctx.refs, areas[0].parent_area_id, { skipUserId: id }) : [],
      }))
      .sort((a, b) => a.user.name.localeCompare(b.user.name, "es"));
    render(res, "destinatario", "Permisos de jefes de área", "jefes", {
      ...ctx,
      assignments,
      jefes,
      principal: {
        type: "jefes",
        label: "Jefes de área",
        desc: "Quien sea jefe en el organigrama, de cualquier área o de una en particular. Se recalcula solo al cambiar el organigrama.",
      },
    });
  } catch (err) {
    next(err);
  }
});

router.get("/areas", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    const { rows } = await db.query(
      `SELECT area_id, count(*)::int AS n FROM perm_assignments
        WHERE principal_type = 'area' GROUP BY area_id`,
    );
    const counts = new Map(rows.map((r) => [Number(r.area_id), r.n]));
    const sinArea = ctx.activeUsers.filter((u) => u.work_area_id == null);
    render(res, "areas", "Organigrama", "areas", { ...ctx, org: orgTree(ctx.refs, { assignmentCounts: counts }), sinArea });
  } catch (err) {
    next(err);
  }
});

router.get("/areas/:id", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    const area = ctx.refs.areaById.get(Number(req.params.id));
    if (!area) return res.redirect(withQueryParam(`${BASE}/areas`, "error", "El área ya no existe"));
    const assignments = await queries.listAssignments(
      { principal_type: "area", area_id: Number(area.id) },
      ctx.refs,
      ctx.catalog,
    );
    const enOrg = areaInOrg(ctx.refs, area.id);
    return render(res, "destinatario", area.area_name, "areas", {
      ...ctx,
      assignments,
      people: enOrg.members,
      enOrg,
      principal: {
        type: "area",
        areaId: Number(area.id),
        label: area.area_name,
        desc: "Quienes trabajan en esta área (y, si lo marcas, en las que cuelgan de ella).",
      },
    });
  } catch (err) {
    return next(err);
  }
});

// --- Asignaciones ------------------------------------------------------------

router.post("/asignaciones", async (req, res) => {
  const to = volver(req, BASE);
  try {
    const body = { ...req.body };
    // El selector "conjunto o permiso suelto" manda uno de los dos.
    if (body.target === "set") body.permission_key = null;
    else body.set_id = null;
    await store.createAssignment(body, actorId(req));
    return ok(res, to, body.effect === "deniega" ? "Denegación guardada" : "Permiso asignado");
  } catch (err) {
    return fail(res, to, err);
  }
});

router.post("/asignaciones/:id", async (req, res) => {
  const to = volver(req, BASE);
  try {
    await store.updateAssignment(req.params.id, req.body, actorId(req));
    return ok(res, to, "Asignación actualizada");
  } catch (err) {
    return fail(res, to, err);
  }
});

router.post("/asignaciones/:id/eliminar", async (req, res) => {
  const to = volver(req, BASE);
  try {
    await store.deleteAssignment(req.params.id, actorId(req));
    return ok(res, to, "Asignación quitada");
  } catch (err) {
    return fail(res, to, err);
  }
});

// --- Usuarios ----------------------------------------------------------------

router.get("/usuarios", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    const q = String(req.query.q || "").trim().toLowerCase();
    const sinAcentos = (v) => String(v || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
    const list = q
      ? ctx.refs.users.filter((u) => sinAcentos(`${u.name} ${u.email || ""}`).includes(sinAcentos(q)))
      : ctx.refs.users;
    render(res, "usuarios", "Permisos por persona", "usuarios", { ...ctx, q: req.query.q || "", list });
  } catch (err) {
    next(err);
  }
});

router.get("/usuarios/:id", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    const detail = await queries.userDetail(req.params.id, ctx.refs, ctx.catalog);
    if (!detail) return res.redirect(withQueryParam(`${BASE}/usuarios`, "error", "La persona ya no existe"));
    return render(res, "usuario", detail.user.name, "usuarios", { ...ctx, detail });
  } catch (err) {
    return next(err);
  }
});

// --- Auditoría ---------------------------------------------------------------

router.get("/auditoria", async (req, res, next) => {
  try {
    const ctx = await baseContext(req);
    const page = Math.max(0, Number.parseInt(req.query.pagina, 10) || 0);
    const audit = await queries.listAudit({ limit: 50, offset: page * 50 }, ctx.refs);
    render(res, "auditoria", "Auditoría de permisos", "auditoria", { ...ctx, audit, page });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
module.exports.itemsFromBody = itemsFromBody;
