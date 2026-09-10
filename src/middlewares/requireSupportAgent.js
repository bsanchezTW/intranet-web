const { rememberReturnTo } = require("../utils/returnTo");
const { isSupportAgent } = require("../services/tickets/supportTeam");

/**
 * Deja pasar sólo al personal de Informática.
 *
 * Gestionar un ticket (asignarlo, cambiar prioridad, responder como Soporte o
 * cerrarlo) es competencia del área, no del rol: un administrador de Marketing
 * ve la mesa de ayuda pero no opera sobre ella. Ocultar el panel en la vista no
 * basta, la operación de backend también tiene que estar protegida.
 */
function wantsJsonResponse(req) {
  const accept = req.headers.accept || "";
  return req.xhr || accept.includes("application/json");
}

function requireSupportAgent() {
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
      if (await isSupportAgent(req.session.user)) return next();
    } catch (err) {
      return next(err);
    }

    const message =
      "Sólo el personal de Informática puede gestionar tickets de soporte.";
    if (wantsJsonResponse(req)) {
      return res.status(403).json({ error: message });
    }
    return res.status(403).render("acceso_no_permitido", {
      titulo: "Acceso no permitido",
    });
  };
}

module.exports = requireSupportAgent;
