const { createRateLimiter } = require("../../utils/rateLimiter");

/**
 * Frenos de las pantallas sin sesión (login, registro, código, recuperar).
 *
 * Dos llaves distintas porque protegen cosas distintas:
 *   - por IP: tope alto contra inundaciones y scripts. Detrás de un proxy,
 *     req.ip sólo es el cliente si `trust proxy` está activo (app.js lo
 *     activa con NODE_ENV=production o TRUST_PROXY=true). Si no, todos
 *     comparten una IP; por eso el tope es generoso y configurable.
 *   - por cuenta (correo): lo que de verdad frena adivinar una contraseña o
 *     inundar el buzón de alguien. No depende del proxy.
 *
 * Los intentos contra un código de verificación NO van aquí: se cuentan en
 * la base (users.confirm_attempts), atómicos y compartidos entre procesos.
 */

const MINUTE = 60 * 1000;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

const LIMITS = {
  // Todas las acciones sin sesión de una misma IP.
  ip: { windowMs: 15 * MINUTE, max: positiveInt(process.env.AUTH_IP_RATE_LIMIT, 300) },
  // Contraseñas erradas por cuenta: al sexto intento espera.
  loginFailures: { windowMs: 15 * MINUTE, max: 5 },
  // Reenvíos de código por cuenta.
  resend: { windowMs: 15 * MINUTE, max: 3 },
  // Enlaces de recuperación por cuenta.
  forgot: { windowMs: 60 * MINUTE, max: 3 },
};

const limiters = Object.fromEntries(
  Object.entries(LIMITS).map(([name, config]) => [name, createRateLimiter(config)]),
);

function accountKey(email) {
  return String(email || "").trim().toLowerCase();
}

function clientKey(req) {
  return String(req.ip || req.socket?.remoteAddress || "desconocida");
}

function minutesLabel(ms) {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE));
  return minutes === 1 ? "1 minuto" : `${minutes} minutos`;
}

function resetAll() {
  for (const limiter of Object.values(limiters)) limiter.clear();
}

module.exports = {
  LIMITS,
  limiters,
  accountKey,
  clientKey,
  minutesLabel,
  resetAll,
};
