const { rememberReturnTo } = require("../utils/returnTo");
const { isFinanceStaff } = require("../services/expenses/financeTeam");

/**
 * Acceso a las herramientas internas de Finanzas (letras de cambio).
 *
 * Pasa todo el personal del área de Finanzas y sus sub-áreas, con cualquier
 * rol, más Informática. A diferencia de requireExpenseReviewer, un
 * administrador de otra área no entra: emitir títulos valor de la empresa es
 * trabajo de Finanzas, no un permiso del rol.
 */

function wantsJsonResponse(req) {
  const accept = req.headers.accept || "";
  return req.xhr || accept.includes("application/json") || /\/api\//.test(req.path);
}

function requireFinanceStaff() {
  return async (req, res, next) => {
    const user = req.session && req.session.user;
    if (!user) {
      rememberReturnTo(req);
      if (wantsJsonResponse(req)) {
        return res.status(401).json({ error: "Sesión expirada. Vuelve a iniciar sesión." });
      }
      return res.redirect("/login");
    }

    try {
      if (await isFinanceStaff(user)) return next();
    } catch (err) {
      // Un fallo de BD no debe abrir el módulo: se cae al 403 de abajo.
      console.error("[Letras] Error resolviendo el personal de Finanzas:", err.message);
    }

    if (wantsJsonResponse(req)) {
      return res.status(403).json({ error: "Sólo el área de Finanzas emite letras de cambio." });
    }
    return res.status(403).render("acceso_no_permitido", { titulo: "Acceso no permitido" });
  };
}

module.exports = requireFinanceStaff;
