const { denyUnauthenticated, denyForbidden } = require("../utils/httpResponses");
const { canManageRrhh } = require("../services/access/staffAccess");

/**
 * Deja pasar sólo a los administradores de RRHH y de Informática.
 *
 * Protege la Administración de RRHH (áreas, centros de costo, feriados,
 * gestión de vacaciones) y el alta, edición y baja de colaboradores. Un
 * administrador de otra área ya no opera aquí: ocultar el menú no basta, la
 * ruta también se cierra.
 */
function requireRrhhManager() {
  return async (req, res, next) => {
    if (!req.session || !req.session.user) return denyUnauthenticated(req, res);

    try {
      if (await canManageRrhh(req.session.user)) return next();
    } catch (err) {
      return next(err);
    }

    const message =
      "Sólo los administradores de RRHH e Informática pueden entrar a esta sección.";
    return denyForbidden(req, res, message);
  };
}

module.exports = requireRrhhManager;
