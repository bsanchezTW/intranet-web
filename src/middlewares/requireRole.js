// src/middlewares/requireRole.js
const { rememberReturnTo } = require("../utils/returnTo");
const {
  roleMatchesRoute,
  ROLES,
  ROLES_INTRANET_ACTIVOS,
} = require("../constants/roles");

function wantsJsonResponse(req) {
  const accept = req.headers.accept || "";
  return (
    req.xhr ||
    accept.includes("application/json") ||
    /\/(upload|api\/)/.test(req.path)
  );
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) {
      rememberReturnTo(req);
      if (wantsJsonResponse(req)) {
        return res.status(401).json({ error: "Sesión expirada. Vuelve a iniciar sesión." });
      }
      return res.redirect("/login");
    }

    const role = req.session.user.role;

    if (roleMatchesRoute(role, roles)) {
      return next();
    }

    if (wantsJsonResponse(req)) {
      return res.status(403).json({ error: "No tienes permiso para esta acción." });
    }

    return res
      .status(403)
      .render("acceso_no_permitido", { titulo: "Acceso no permitido" });
  };
}

requireRole.ROLES = ROLES;
requireRole.ROLES_INTRANET_ACTIVOS = ROLES_INTRANET_ACTIVOS;
requireRole.administrador = () => requireRole("admin");
requireRole.intranetActivo = () =>
  requireRole(...ROLES_INTRANET_ACTIVOS);

module.exports = requireRole;
