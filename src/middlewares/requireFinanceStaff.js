const { denyUnauthenticated, denyForbidden } = require("../utils/httpResponses");
const { isFinanceStaff } = require("../services/expenses/financeTeam");

/**
 * Acceso a las herramientas internas de Finanzas (letras de cambio).
 *
 * Pasa todo el personal del área de Finanzas y sus sub-áreas, con cualquier
 * rol, más Informática. A diferencia de requireExpenseReviewer, un
 * administrador de otra área no entra: emitir títulos valor de la empresa es
 * trabajo de Finanzas, no un permiso del rol.
 */

function requireFinanceStaff() {
  return async (req, res, next) => {
    const user = req.session && req.session.user;
    if (!user) return denyUnauthenticated(req, res);

    try {
      if (await isFinanceStaff(user)) return next();
    } catch (err) {
      // Un fallo de BD no debe abrir el módulo: se cae al 403 de abajo.
      console.error("[Letras] Error resolviendo el personal de Finanzas:", err.message);
    }

    return denyForbidden(req, res, "Sólo el área de Finanzas emite letras de cambio.");
  };
}

module.exports = requireFinanceStaff;
