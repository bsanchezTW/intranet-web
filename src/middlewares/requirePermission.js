const { rememberReturnTo } = require("../utils/returnTo");
const { allKeys, getPermission } = require("../services/permissions/catalog");
const permissions = require("../services/permissions/permissionService");

/**
 * Corta la petición si quien la hace no tiene el permiso (Gestión de
 * Permisos). Reemplaza a requireRole, requireRrhhManager, requireSupportAgent,
 * requireExpenseReviewer y requireFinanceStaff a medida que cada módulo se
 * migra.
 *
 *   requirePermission("noticias.noticia.crear")
 *   requireAnyPermission("vacaciones.solicitud.ver", "vacaciones.solicitud.aprobar")
 *
 * Un permiso de un módulo que no existe en el país responde 404, como
 * requireFeature. Una clave que no está en el catálogo es un error de
 * programación y falla al cargar la ruta, no al usarla.
 *
 * Sólo decide "¿tiene el permiso?". Si vale sobre un registro concreto
 * (alcance, nadie aprueba lo suyo) lo decide la política del módulo con
 * req.perms.canOnRecord.
 */

const KNOWN_KEYS = new Set(allKeys());

function wantsJsonResponse(req) {
  const accept = req.headers.accept || "";
  return req.xhr || accept.includes("application/json") || /\/(upload|api)\//.test(req.originalUrl);
}

function assertKnown(keys) {
  if (!keys.length) throw new Error("requirePermission: falta la clave del permiso");
  for (const key of keys) {
    if (!KNOWN_KEYS.has(key)) {
      throw new Error(`requirePermission: "${key}" no existe en el catálogo de permisos`);
    }
  }
}

function requireAnyPermission(...keys) {
  assertKnown(keys);
  return async (req, res, next) => {
    // Ninguna existe en este país: la ruta tampoco.
    if (!keys.some((key) => getPermission(key))) {
      if (wantsJsonResponse(req)) return res.status(404).json({ error: "No encontrado" });
      return res.status(404).render("404", { titulo: "Página no encontrada" });
    }

    const user = req.session && req.session.user;
    if (!user) {
      rememberReturnTo(req);
      if (wantsJsonResponse(req)) {
        return res.status(401).json({ error: "Sesión expirada. Vuelve a iniciar sesión." });
      }
      return res.redirect("/login");
    }

    try {
      if (!req.perms) req.perms = await permissions.resolve(user);
    } catch (err) {
      return next(err);
    }
    if (keys.some((key) => req.perms.can(key))) return next();

    if (wantsJsonResponse(req)) {
      return res.status(403).json({ error: "No tienes permiso para esta acción." });
    }
    return res.status(403).render("acceso_no_permitido", { titulo: "Acceso no permitido" });
  };
}

function requirePermission(key) {
  return requireAnyPermission(key);
}

module.exports = requirePermission;
module.exports.requirePermission = requirePermission;
module.exports.requireAnyPermission = requireAnyPermission;
