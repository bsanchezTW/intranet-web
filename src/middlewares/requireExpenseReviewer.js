const { rememberReturnTo } = require("../utils/returnTo");
const { isAdministrador, normalizeRole } = require("../constants/roles");
const { isAreaManager } = require("../services/expenses/areaManager");
const { isFinanceApprover } = require("../services/expenses/financeTeam");

/**
 * Acceso al módulo de gestión del centro de gastos.
 *
 * Mismo criterio que requireSupportAgent: el permiso no es del rol sino del
 * puesto. Aquí pasan tres perfiles, y ninguno es intercambiable con otro:
 *   - jefe de al menos un área  → aprueba la primera etapa de su gente
 *   - aprobador de Finanzas     → aprueba la segunda etapa
 *   - administrador             → destraba las solicitudes de los propios jefes
 *
 * Qué ve cada uno dentro lo decide expenseRequestService; esto sólo cierra la
 * puerta a quien no revisa nada.
 */

function wantsJsonResponse(req) {
  const accept = req.headers.accept || "";
  return (
    req.xhr ||
    accept.includes("application/json") ||
    /\/(upload|api\/)/.test(req.path)
  );
}

function requireExpenseReviewer() {
  return async (req, res, next) => {
    const user = req.session && req.session.user;
    if (!user) {
      rememberReturnTo(req);
      if (wantsJsonResponse(req)) {
        return res
          .status(401)
          .json({ error: "Sesión expirada. Vuelve a iniciar sesión." });
      }
      return res.redirect("/login");
    }

    try {
      if (isAdministrador(normalizeRole(user.role))) return next();
      if (await isFinanceApprover(user)) return next();
      if (await isAreaManager(user)) return next();
    } catch (err) {
      // Un fallo de BD no debe abrir la gestión: se cae al 403 de abajo.
      console.error("[Gastos] Error resolviendo revisor:", err.message);
    }

    if (wantsJsonResponse(req)) {
      return res
        .status(403)
        .json({ error: "No tienes permiso para gestionar solicitudes." });
    }
    return res
      .status(403)
      .render("acceso_no_permitido", { titulo: "Acceso no permitido" });
  };
}

module.exports = requireExpenseReviewer;
