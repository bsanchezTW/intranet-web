const fs = require("node:fs");
const path = require("node:path");

/**
 * TLS de la conexión a Postgres.
 *
 * Hasta ahora, con Supabase (o DB_SSL=true) se cifraba sin verificar el
 * certificado (rejectUnauthorized: false): quien se ponga entre el hosting y
 * el pooler puede presentar cualquier certificado y leer o alterar todo el
 * tráfico, credenciales incluidas.
 *
 * DB_SSL_CA activa la verificación completa (cadena + nombre del host). Es
 * la CA que Supabase entrega en Database Settings → SSL Configuration
 * ("Download certificate"); acepta la ruta al archivo .crt/.pem o el PEM
 * pegado en la variable (los saltos de línea pueden venir como \n).
 *
 * Sin DB_SSL_CA todo sigue como antes, para no cortar la conexión de un
 * servidor que no la tenga configurada; db.js deja un aviso en el log.
 */

const SSL_URL_PARAMS = ["sslmode", "sslrootcert", "sslcert", "sslkey", "uselibpqcompat"];

function looksLikeSupabase(env) {
  const host = String(env.DB_HOST || "");
  const url = String(env.DATABASE_URL || "");
  return /supabase\.(co|com)/i.test(host) || /supabase\.(co|com)/i.test(url);
}

/** PEM de DB_SSL_CA, o null. Lanza si apunta a un archivo que no existe. */
function readDbCa(env = process.env, { readFile = fs.readFileSync } = {}) {
  const raw = String(env.DB_SSL_CA || "").trim();
  if (!raw) return null;
  if (raw.includes("-----BEGIN CERTIFICATE-----")) return raw.replace(/\\n/g, "\n");
  const file = path.resolve(path.join(__dirname, "..", ".."), raw);
  let pem;
  try {
    pem = readFile(file, "utf8");
  } catch (err) {
    throw new Error(`DB_SSL_CA apunta a "${raw}", que no se pudo leer (${err.code || err.message}).`);
  }
  if (!pem.includes("-----BEGIN CERTIFICATE-----")) {
    throw new Error(`DB_SSL_CA ("${raw}") no contiene un certificado PEM.`);
  }
  return pem;
}

/**
 * Opción `ssl` para pg. { ca, rejectUnauthorized: true } con DB_SSL_CA;
 * si no, el comportamiento anterior (cifrado sin verificar con Supabase).
 */
function resolveDbSsl(env = process.env, deps = {}) {
  const flag = String(env.DB_SSL || "").trim().toLowerCase();
  const ca = readDbCa(env, deps);

  if (flag === "false" || flag === "0") {
    if (ca) throw new Error("DB_SSL=false y DB_SSL_CA a la vez: quita una de las dos.");
    return false;
  }
  if (ca) return { ca, rejectUnauthorized: true };
  if (flag === "true" || flag === "1") return { rejectUnauthorized: false };
  return looksLikeSupabase(env) ? { rejectUnauthorized: false } : false;
}

/** ¿Se está cifrando sin verificar el certificado? Para el aviso del log. */
function isUnverifiedTls(ssl) {
  return Boolean(ssl) && ssl.rejectUnauthorized === false;
}

/**
 * Con la verificación activa, los parámetros ssl* de DATABASE_URL se quitan:
 * pg los aplica por encima de la opción `ssl` y `sslmode=no-verify` (o
 * `require` con uselibpqcompat) desactivaría la verificación sin aviso.
 */
function connectionStringForSsl(connectionString, ssl) {
  if (!ssl || ssl.rejectUnauthorized !== true) return connectionString;
  try {
    const url = new URL(connectionString);
    for (const param of SSL_URL_PARAMS) url.searchParams.delete(param);
    return url.toString();
  } catch {
    return connectionString;
  }
}

module.exports = { readDbCa, resolveDbSsl, isUnverifiedTls, connectionStringForSsl };
