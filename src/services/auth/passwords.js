const crypto = require("node:crypto");
const { promisify } = require("node:util");

/**
 * Hash de contraseñas.
 *
 * Antes: PBKDF2-SHA256 con 120 000 iteraciones, síncrono (bloqueaba el event
 * loop ~50-100 ms por login; con varios intentos a la vez, nadie más recibía
 * respuesta) y por debajo de lo que pide OWASP hoy para PBKDF2 (600 000).
 *
 * Ahora: scrypt asíncrono (corre en el pool de libuv) con N=2^14, r=8, p=5,
 * una de las configuraciones mínimas de OWASP; usa ~16 MB por cálculo, algo
 * razonable en un hosting compartido. El hash guarda sus parámetros:
 *
 *   scrypt$N=16384,r=8,p=5$<sal base64url>$<hash base64url>
 *
 * así se pueden subir más adelante y las cuentas se rehashean solas.
 *
 * Migración transparente: verifyPassword acepta el formato antiguo (hex en
 * password_hash + sal hex en password_salt) y avisa `needsRehash`; quien
 * verifica una contraseña correcta guarda el hash nuevo.
 */

const scryptAsync = promisify(crypto.scrypt);
const pbkdf2Async = promisify(crypto.pbkdf2);

const CURRENT = Object.freeze({ N: 16384, r: 8, p: 5, keylen: 32, saltBytes: 16 });
const LEGACY_PBKDF2 = Object.freeze({ iterations: 120000, keylen: 32, digest: "sha256" });
// Tope de memoria para scrypt: 128 * N * r con margen (Node rechaza por
// encima de 32 MB por omisión).
const MAX_MEM = 64 * 1024 * 1024;
const PREFIX = "scrypt";

function encode({ N, r, p }, salt, hash) {
  return `${PREFIX}$N=${N},r=${r},p=${p}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

function parseScrypt(stored) {
  const parts = String(stored).split("$");
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const params = Object.fromEntries(
    parts[1].split(",").map((kv) => {
      const [k, v] = kv.split("=");
      return [k, Number(v)];
    }),
  );
  const { N, r, p } = params;
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return null;
  // N potencia de 2 y valores acotados: un hash alterado no debe poder
  // pedir gigas de memoria.
  if ((N & (N - 1)) !== 0 || N > 1 << 20 || r > 32 || p > 64) return null;
  const salt = Buffer.from(parts[2], "base64url");
  const hash = Buffer.from(parts[3], "base64url");
  if (!salt.length || !hash.length) return null;
  return { N, r, p, salt, hash };
}

/** Hash nuevo. Devuelve { hash, salt } listo para users (salt va NULL). */
async function hashPassword(password) {
  const salt = crypto.randomBytes(CURRENT.saltBytes);
  const derived = await scryptAsync(String(password), salt, CURRENT.keylen, {
    N: CURRENT.N,
    r: CURRENT.r,
    p: CURRENT.p,
    maxmem: MAX_MEM,
  });
  return { hash: encode(CURRENT, salt, derived), salt: null };
}

function equalBuffers(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * ¿`password` corresponde a lo guardado? Acepta el formato nuevo y el
 * PBKDF2 antiguo. { ok, needsRehash }.
 */
async function verifyPassword(password, { password_hash: stored, password_salt: legacySalt } = {}) {
  if (typeof stored !== "string" || !stored) return { ok: false, needsRehash: false };
  const plain = String(password ?? "");

  if (stored.startsWith(`${PREFIX}$`)) {
    const parsed = parseScrypt(stored);
    if (!parsed) return { ok: false, needsRehash: false };
    const derived = await scryptAsync(plain, parsed.salt, parsed.hash.length, {
      N: parsed.N,
      r: parsed.r,
      p: parsed.p,
      maxmem: MAX_MEM,
    });
    const ok = equalBuffers(derived, parsed.hash);
    const outdated = parsed.N !== CURRENT.N || parsed.r !== CURRENT.r || parsed.p !== CURRENT.p;
    return { ok, needsRehash: ok && outdated };
  }

  // Formato antiguo: hash hex con su sal hex en otra columna.
  if (!legacySalt || !/^[0-9a-f]+$/i.test(stored)) return { ok: false, needsRehash: false };
  const derived = await pbkdf2Async(
    plain,
    Buffer.from(String(legacySalt), "hex"),
    LEGACY_PBKDF2.iterations,
    LEGACY_PBKDF2.keylen,
    LEGACY_PBKDF2.digest,
  );
  const ok = equalBuffers(derived, Buffer.from(stored, "hex"));
  return { ok, needsRehash: ok };
}

function isLegacyHash(stored) {
  return typeof stored === "string" && stored !== "" && !stored.startsWith(`${PREFIX}$`);
}

module.exports = { hashPassword, verifyPassword, isLegacyHash, CURRENT };
