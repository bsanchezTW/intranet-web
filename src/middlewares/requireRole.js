// src/middlewares/requireRole.js
const { denyUnauthenticated, denyForbidden } = require("../utils/httpResponses");
const {
  roleMatchesRoute,
  ROLES,
  ROLES_INTRANET_ACTIVOS,
} = require("../constants/roles");

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.session || !req.session.user) return denyUnauthenticated(req, res);

    const role = req.session.user.role;

    if (roleMatchesRoute(role, roles)) {
      return next();
    }

    return denyForbidden(req, res);
  };
}

requireRole.ROLES = ROLES;
requireRole.ROLES_INTRANET_ACTIVOS = ROLES_INTRANET_ACTIVOS;
requireRole.administrador = () => requireRole("admin");
requireRole.intranetActivo = () =>
  requireRole(...ROLES_INTRANET_ACTIVOS);

module.exports = requireRole;
