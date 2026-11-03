const { rememberReturnTo } = require("./returnTo");

/**
 * Respuestas de acceso comunes a todos los middlewares (sesión expirada, sin
 * permiso, no existe).
 *
 * Antes cada middleware tenía su copia de wantsJsonResponse y no coincidían:
 * unas miraban req.path y otras req.originalUrl, unas reconocían /upload y
 * otras no. El mismo fetch recibía JSON de un middleware y la página HTML de
 * acceso denegado de otro (el cliente fallaba al parsearla). Ésta es la
 * unión de todos los criterios.
 *
 * Quedan aparte, a propósito: routes/auth.js (los formularios de login piden
 * HTML aunque vengan por fetch) y crossOriginProtection (corre antes de leer
 * el cuerpo).
 */

const API_PATH = /\/(api|upload)(\/|\?|$)/;

function wantsJson(req) {
  const accept = String((req.headers && req.headers.accept) || "");
  const requestedWith = String((req.get && req.get("X-Requested-With")) || "").toLowerCase();
  const contentType = String((req.get && req.get("Content-Type")) || "");
  const url = String(req.originalUrl || req.url || "");
  return Boolean(
    req.xhr ||
      requestedWith === "fetch" ||
      accept.includes("application/json") ||
      contentType.includes("application/json") ||
      API_PATH.test(url) ||
      url.includes("/adjuntos/"),
  );
}

const SESSION_EXPIRED = "Sesión expirada. Vuelve a iniciar sesión.";
const FORBIDDEN = "No tienes permiso para esta acción.";

/** Sin sesión: 401 JSON o al login (recordando a dónde volver). */
function denyUnauthenticated(req, res) {
  rememberReturnTo(req);
  if (wantsJson(req)) return res.status(401).json({ error: SESSION_EXPIRED });
  return res.redirect("/login");
}

/** Con sesión pero sin permiso: 403 JSON o la página de acceso no permitido. */
function denyForbidden(req, res, message = FORBIDDEN) {
  if (wantsJson(req)) return res.status(403).json({ error: message });
  return res.status(403).render("acceso_no_permitido", { titulo: "Acceso no permitido" });
}

/** La ruta no existe en esta instancia (módulo apagado en el país). */
function respondNotFound(req, res) {
  if (wantsJson(req)) return res.status(404).json({ error: "No encontrado" });
  return res.status(404).render("404", { titulo: "Página no encontrada" });
}

module.exports = {
  wantsJson,
  denyUnauthenticated,
  denyForbidden,
  respondNotFound,
  SESSION_EXPIRED,
  FORBIDDEN,
};
