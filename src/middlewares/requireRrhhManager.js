const { rememberReturnTo } = require("../utils/returnTo");
const { canManageRrhh } = require("../services/access/staffAccess");

/**
 * Deja pasar sólo a los administradores de RRHH y de Informática.
 *
 * Protege la Administración de RRHH (áreas, centros de costo, feriados,
 * gestión de vacaciones) y el alta, edición y baja de colaboradores. Un
 * administrador de otra área ya no opera aquí: ocultar el menú no basta, la
 * ruta también se cierra.
 */
function wantsJsonResponse(req) {
  const accept = req.headers.accept || "";
  return req.xhr || accept.includes("application/json");
}

function requireRrhhManager() {
  return async (req, res, next) => {
    if (!req.session || !req.session.user) {
      rememberReturnTo(req);
      if (wantsJsonResponse(req)) {
        return res
          .status(401)
          .json({ error: "Sesión expirada. Vuelve a iniciar sesión." });
      }
      return res.redirect("/login");
    }

    try {
      if (await canManageRrhh(req.session.user)) return next();
    } catch (err) {
      return next(err);
    }

    const message =
      "Sólo los administradores de RRHH e Informática pueden entrar a esta sección.";
    if (wantsJsonResponse(req)) {
      return res.status(403).json({ error: message });
    }
    return res.status(403).render("acceso_no_permitido", {
      titulo: "Acceso no permitido",
    });
  };
}

module.exports = requireRrhhManager;
