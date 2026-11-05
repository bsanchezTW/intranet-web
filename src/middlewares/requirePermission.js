const { denyUnauthenticated, denyForbidden, respondNotFound } = require("../utils/httpResponses");
const { allKeys, getPermission } = require("../services/permissions/catalog");
const permissions = require("../services/permissions/permissionService");
const { decide } = require("../services/permissions/decide");

/**
 * Corta la petición si quien la hace no tiene el permiso (Gestión de
 * Permisos). Reemplazó a requireRrhhManager, requireSupportAgent,
 * requireExpenseReviewer y requireFinanceStaff.
 *
 *   requirePermission("noticias.noticia.crear")
 *   requireAnyPermission("letras.letra.ver", "letras.letra.crear")
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
      return respondNotFound(req, res);
    }

    const user = req.session && req.session.user;
    if (!user) return denyUnauthenticated(req, res);

    try {
      if (!req.perms) req.perms = await permissions.resolve(user);
    } catch (err) {
      return next(err);
    }
    if (keys.some((key) => decide(req.perms, key))) return next();

    return denyForbidden(req, res);
  };
}

function requirePermission(key) {
  return requireAnyPermission(key);
}

module.exports = requirePermission;
module.exports.requirePermission = requirePermission;
module.exports.requireAnyPermission = requireAnyPermission;
