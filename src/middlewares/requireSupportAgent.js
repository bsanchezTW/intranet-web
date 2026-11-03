const { denyUnauthenticated, denyForbidden } = require("../utils/httpResponses");
const { isSupportAgent } = require("../services/tickets/supportTeam");

/**
 * Deja pasar sólo al personal de Informática.
 *
 * Gestionar un ticket (asignarlo, cambiar prioridad, responder como Soporte o
 * cerrarlo) es competencia del área, no del rol: un administrador de Marketing
 * ve la mesa de ayuda pero no opera sobre ella. Ocultar el panel en la vista no
 * basta, la operación de backend también tiene que estar protegida.
 */
function requireSupportAgent() {
  return async (req, res, next) => {
    if (!req.session || !req.session.user) return denyUnauthenticated(req, res);

    try {
      if (await isSupportAgent(req.session.user)) return next();
    } catch (err) {
      return next(err);
    }

    const message =
      "Sólo el personal de Informática puede gestionar tickets de soporte.";
    return denyForbidden(req, res, message);
  };
}

module.exports = requireSupportAgent;
