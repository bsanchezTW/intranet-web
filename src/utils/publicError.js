/**
 * Qué parte de un error se le muestra al usuario.
 *
 * El texto de un error interno (de Postgres, de Storage, de una librería)
 * describe la base, las rutas y el código: ayuda a un atacante y no le sirve
 * al usuario. Antes se mostraba siempre que NODE_ENV no fuera "production",
 * así que bastaba con que el servidor no lo definiera. Ahora es al revés: el
 * detalle sale sólo con NODE_ENV=development (lo pone scripts/dev.js).
 *
 * Un error pensado para el usuario se marca con statusCode 4xx (o
 * `expose: true`) y su mensaje sí se muestra siempre.
 */

function exposeErrorDetails(env = process.env) {
  return String(env.NODE_ENV || "").trim().toLowerCase() === "development";
}

function isUserFacingError(err) {
  if (!err || typeof err.message !== "string" || !err.message) return false;
  if (err.expose === true) return true;
  const status = Number(err.statusCode || err.status);
  return Number.isInteger(status) && status >= 400 && status < 500;
}

/**
 * Mensaje para la respuesta: el del error si es para el usuario, el detalle
 * en desarrollo, o `fallback`.
 */
function publicErrorMessage(err, fallback, env = process.env) {
  if (isUserFacingError(err)) return err.message;
  if (exposeErrorDetails(env) && err && err.message) return `${fallback}: ${err.message}`;
  return fallback;
}

/** Error con un mensaje que sí se le puede mostrar al usuario (400 por omisión). */
function userError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  err.expose = true;
  return err;
}

module.exports = { exposeErrorDetails, isUserFacingError, publicErrorMessage, userError };
