const logger = require("../utils/logger");

/**
 * Protección CSRF: rechaza las peticiones que cambian algo (POST, PUT,
 * PATCH, DELETE) cuando el navegador dice que vienen de otro sitio.
 *
 * Por qué cabeceras y no tokens: la app tiene ~100 formularios (18 multipart,
 * donde el cuerpo se lee recién dentro de la ruta) y decenas de fetch. Los
 * navegadores actuales informan el origen de cada petición y no dejan que una
 * página lo falsifique, así que basta con leerlo. Es el mismo criterio de
 * CrossOriginProtection de Go (net/http, 1.25):
 *
 *   1. Sec-Fetch-Site (Fetch Metadata; navegadores desde 2020-2023, sólo por
 *      HTTPS): pasa `same-origin` o `none` (el usuario escribió la URL);
 *      `same-site` o `cross-site` se rechaza. Un subdominio comprometido es
 *      `same-site`: también queda fuera.
 *   2. Sin Sec-Fetch-Site, Origin (todo navegador lo manda en un POST): su
 *      host debe ser el de esta instancia. `Origin: null` se rechaza.
 *   3. Sin ninguna de las dos no es un navegador (curl, un script): no hay
 *      sesión de víctima que usar, pasa.
 *
 * Los hosts válidos son el Host de la petición y el de APP_BASE_URL (detrás
 * de un proxy que reescribe Host, el segundo es el que ve el navegador), más
 * CSRF_TRUSTED_ORIGINS si hiciera falta otro.
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS", "TRACE"]);

function hostOf(origin) {
  try {
    const url = new URL(String(origin));
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.host.toLowerCase();
  } catch {
    return null;
  }
}

function trustedHostsFrom(env = process.env) {
  const hosts = new Set();
  const base = hostOf(String(env.APP_BASE_URL || "").trim());
  if (base) hosts.add(base);
  for (const raw of String(env.CSRF_TRUSTED_ORIGINS || "").split(",")) {
    const host = hostOf(raw.trim());
    if (host) hosts.add(host);
  }
  return hosts;
}

/**
 * Decisión pura. Devuelve { allowed, reason }.
 */
function decideCrossOrigin({ method, secFetchSite, origin, host, trustedHosts = new Set() }) {
  if (SAFE_METHODS.has(String(method || "").toUpperCase())) {
    return { allowed: true, reason: "metodo-seguro" };
  }

  const site = String(secFetchSite || "").trim().toLowerCase();
  if (site) {
    if (site === "same-origin" || site === "none") return { allowed: true, reason: `sec-fetch-site=${site}` };
    return { allowed: false, reason: `sec-fetch-site=${site}` };
  }

  if (origin === undefined || origin === null || origin === "") {
    return { allowed: true, reason: "sin-cabeceras-de-navegador" };
  }

  const originHost = hostOf(origin);
  if (!originHost) return { allowed: false, reason: `origin=${origin}` };
  const requestHost = String(host || "").trim().toLowerCase();
  if (originHost === requestHost || trustedHosts.has(originHost)) {
    return { allowed: true, reason: "origin-propio" };
  }
  return { allowed: false, reason: `origin=${origin}` };
}

function wantsJson(req) {
  const accept = String(req.get("accept") || "");
  return req.xhr || accept.includes("application/json") || String(req.get("content-type") || "").includes("application/json");
}

/**
 * @param {object} [options]
 * @param {Set<string>} [options.trustedHosts]
 * @param {(req) => boolean} [options.exempt]  rutas que reciben POST de otros orígenes a propósito
 */
function crossOriginProtection({ trustedHosts = trustedHostsFrom(), exempt = () => false } = {}) {
  return (req, res, next) => {
    const decision = decideCrossOrigin({
      method: req.method,
      secFetchSite: req.get("sec-fetch-site"),
      origin: req.get("origin"),
      host: req.get("host"),
      trustedHosts,
    });
    if (decision.allowed || exempt(req)) return next();

    logger.warn("csrf", `rechazado ${req.method} ${req.originalUrl} (${decision.reason})`);
    const error = "Solicitud rechazada: no viene de la intranet. Recarga la página e inténtalo de nuevo.";
    if (wantsJson(req)) return res.status(403).json({ error });
    return res.status(403).type("text/plain").send(error);
  };
}

module.exports = { crossOriginProtection, decideCrossOrigin, trustedHostsFrom, hostOf };
