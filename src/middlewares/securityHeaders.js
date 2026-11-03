const crypto = require("node:crypto");
const express = require("express");
const logger = require("../utils/logger");
const { createRateLimiter } = require("../utils/rateLimiter");

/**
 * Cabeceras de seguridad de todas las respuestas.
 *
 * CSP:
 *   - Mínima, siempre aplicada: nadie enmarca la intranet desde otro sitio
 *     (clickjacking), no hay <base> ni <object>.
 *   - Estricta: scripts sólo de la propia intranet, de los CDN de la lista y
 *     los inline que llevan el nonce de la petición (res.locals.cspNonce, en
 *     cada <script> de las vistas). Los onclick/onerror inline ya no existen
 *     (public/js/acciones.js). Va en Report-Only y el navegador avisa a
 *     /csp-report de lo que bloquearía; con CSP_ENFORCE=true se aplica.
 *     Pasar a aplicarla después de ver el log `csp` limpio en staging.
 *
 * Orígenes externos que usan las vistas: cdnjs y jsdelivr (librerías),
 * Google Fonts, SharePoint (visor de PowerPoint en Cursos) y YouTube.
 */

const CDN_SCRIPTS = ["https://cdnjs.cloudflare.com", "https://cdn.jsdelivr.net"];

// YouTube: la API del reproductor de Cursos se carga desde su dominio.
const VIDEO_SCRIPTS = ["https://www.youtube.com", "https://s.ytimg.com"];

const ENFORCED_CSP = ["frame-ancestors 'self'", "base-uri 'self'", "object-src 'none'"].join("; ");

/** Política estricta con el nonce de la petición. */
function strictCsp(nonce) {
  return [
  "default-src 'self'",
  `script-src 'self' 'nonce-${nonce}' ${CDN_SCRIPTS.join(" ")} ${VIDEO_SCRIPTS.join(" ")}`,
  `style-src 'self' 'unsafe-inline' ${CDN_SCRIPTS.join(" ")} https://fonts.googleapis.com`,
  "font-src 'self' data: https://fonts.gstatic.com https://cdnjs.cloudflare.com",
  // Las noticias admiten imágenes externas (sanitizeContent) y el feed de
  // LinkedIn trae las suyas: imágenes de cualquier origen https.
  "img-src 'self' data: blob: https:",
  "media-src 'self' blob:",
  "connect-src 'self' https://cdnjs.cloudflare.com",
  "worker-src 'self' blob: https://cdnjs.cloudflare.com",
  "frame-src 'self' https://transworldchile.sharepoint.com https://www.youtube.com https://www.youtube-nocookie.com",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "base-uri 'self'",
  "object-src 'none'",
  "report-uri /csp-report",
  ].join("; ");
}

/** Compatibilidad: la política estricta sin nonce (sólo para tests y docs). */
const REPORT_ONLY_CSP = strictCsp("NONCE");

const PERMISSIONS_POLICY = [
  "camera=()",
  "microphone=()",
  "geolocation=()",
  "payment=()",
  "usb=()",
].join(", ");

// 180 días, sin includeSubDomains: no sabemos qué otros subdominios del
// dominio corporativo siguen por HTTP.
const HSTS = "max-age=15552000";

function enforceStrictCsp(env = process.env) {
  return String(env.CSP_ENFORCE || "").trim().toLowerCase() === "true";
}

function securityHeaders({ enforce = enforceStrictCsp() } = {}) {
  return (req, res, next) => {
    // 128 bits por petición: el nonce no se puede adivinar ni reutilizar.
    const nonce = crypto.randomBytes(16).toString("base64");
    res.locals.cspNonce = nonce;
    res.set("X-Content-Type-Options", "nosniff");
    res.set("X-Frame-Options", "SAMEORIGIN");
    res.set("Referrer-Policy", "strict-origin-when-cross-origin");
    res.set("Permissions-Policy", PERMISSIONS_POLICY);
    if (enforce) {
      // La estricta ya incluye frame-ancestors, base-uri y object-src.
      res.set("Content-Security-Policy", strictCsp(nonce));
    } else {
      res.set("Content-Security-Policy", ENFORCED_CSP);
      res.set("Content-Security-Policy-Report-Only", strictCsp(nonce));
    }
    // Sólo por HTTPS: por HTTP el navegador la ignora y, detrás de un proxy
    // sin `trust proxy`, req.secure es false aunque el cliente use HTTPS.
    if (req.secure) res.set("Strict-Transport-Security", HSTS);
    next();
  };
}

/**
 * Receptor de reportes CSP. Sin sesión y sin CSRF (lo llama el navegador
 * por su cuenta). Cada reporte distinto se registra una vez por hora y
 * proceso; el tope por IP evita que alguien inunde el log.
 */
function cspReportRouter({ now = () => Date.now() } = {}) {
  const router = express.Router();
  const perIp = createRateLimiter({ windowMs: 60 * 1000, max: 60, now });
  const seen = createRateLimiter({ windowMs: 60 * 60 * 1000, max: 1, now });

  router.post(
    "/csp-report",
    express.json({
      type: ["application/csp-report", "application/reports+json", "application/json"],
      limit: "16kb",
    }),
    (req, res) => {
      res.status(204).end();
      if (!perIp.hit(String(req.ip || "desconocida")).allowed) return;

      const reports = Array.isArray(req.body) ? req.body : [req.body];
      for (const entry of reports.slice(0, 20)) {
        const r = (entry && (entry["csp-report"] || entry.body)) || {};
        const directive = String(r["violated-directive"] || r["effective-directive"] || r.effectiveDirective || "?").slice(0, 80);
        const blocked = String(r["blocked-uri"] || r.blockedURL || "?").slice(0, 200);
        const source = String(r["source-file"] || r.sourceFile || r["document-uri"] || r.documentURL || "?").slice(0, 200);
        const line = r["line-number"] || r.lineNumber || "";
        const key = `${directive}|${blocked}|${source}|${line}`;
        if (!seen.hit(key).allowed) continue;
        logger.warn("csp", `${directive} bloquearía ${blocked} en ${source}${line ? `:${line}` : ""}`);
      }
    },
  );

  return router;
}

module.exports = {
  securityHeaders,
  strictCsp,
  enforceStrictCsp,
  cspReportRouter,
  ENFORCED_CSP,
  REPORT_ONLY_CSP,
  PERMISSIONS_POLICY,
  HSTS,
};
