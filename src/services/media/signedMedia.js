// URLs públicas firmadas para medios que deben ser legibles SIN sesión.
//
// El proxy /content exige sesión activa, lo que es correcto para documentos
// corporativos pero impide que un cliente de correo (Gmail, Outlook) cargue
// las imágenes de una noticia: las pide sin cookies y recibe un 401.
//
// Aquí se firma la ruta relativa con HMAC-SHA256 y se sirve en /media/<sig>/<ruta>.
// La URL es imposible de adivinar y se revoca por completo rotando el secreto.
// Solo se firman imágenes (originales y derivadas: portada de PDF, imágenes
// extraídas de un Word). El resto del contenido sigue detrás de /content.

const crypto = require("crypto");
const path = require("path");
const storage = require("../storage/storageService");

const SIGNATURE_LENGTH = 32; // 128 bits en hex: suficiente contra fuerza bruta

// Extensiones que pueden servirse públicamente. Se excluye SVG a propósito:
// admite scripts embebidos y se serviría desde nuestro propio origen.
const PUBLIC_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".avif",
]);

const CONTENT_TYPES = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".avif": "image/avif",
};

// La validación final debe basarse también en el MIME devuelto por Storage.
// No basta con comprobar `image/*`: SVG es una imagen activa y puede ejecutar
// contenido al servirse desde el mismo origen de la intranet.
const PUBLIC_CONTENT_TYPES = new Set(Object.values(CONTENT_TYPES));

function getSecret() {
  const secret = process.env.MEDIA_SIGNING_SECRET || process.env.SESSION_SECRET;
  if (!secret) {
    throw new Error(
      "Falta MEDIA_SIGNING_SECRET (o SESSION_SECRET) para firmar URLs de medios.",
    );
  }
  return secret;
}

/**
 * Solo se exponen imágenes. Se acepta también una ruta SIN extensión porque
 * algunos adjuntos heredados se guardaron como identificadores sin sufijo; en
 * ese caso quien sirve el archivo debe confirmar que el Content-Type real es
 * image/* antes de entregarlo.
 */
function isPubliclyServable(relativePathOrName) {
  const ext = path.extname(String(relativePathOrName || "")).toLowerCase();
  return ext ? PUBLIC_EXTENSIONS.has(ext) : true;
}

function contentTypeFor(relativePath) {
  const ext = path.extname(String(relativePath || "")).toLowerCase();
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

function isSafeContentType(contentType) {
  const normalized = String(contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  return PUBLIC_CONTENT_TYPES.has(normalized);
}

/**
 * Convierte cualquier forma de referencia (/content/x, content/x, x) en la
 * ruta relativa canónica dentro del bucket privado. Devuelve "" si no es válida.
 */
function toRelativePath(urlOrPath) {
  if (!urlOrPath) return "";
  try {
    let value = String(urlOrPath).trim();
    // Absolutiza: si viene una URL completa nos quedamos con el pathname.
    if (/^https?:\/\//i.test(value)) {
      value = new URL(value).pathname;
    }
    if (value.startsWith("/media/")) {
      // /media/<sig>/<ruta> → <ruta>
      const rest = value.slice("/media/".length);
      const slash = rest.indexOf("/");
      value = slash === -1 ? "" : rest.slice(slash + 1);
    }
    return storage.normalizeRelativePath(decodeURIComponent(value));
  } catch {
    return "";
  }
}

function sign(relativePath) {
  const clean = storage.normalizeRelativePath(relativePath);
  return crypto
    .createHmac("sha256", getSecret())
    .update(clean)
    .digest("hex")
    .slice(0, SIGNATURE_LENGTH);
}

function verify(relativePath, signature) {
  if (!signature || signature.length !== SIGNATURE_LENGTH) return false;
  let expected;
  try {
    expected = sign(relativePath);
  } catch {
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
}

/**
 * URL pública firmada, relativa al host (ej. "/media/ab12…/noticias_adjuntos/foto.jpg").
 * Devuelve null si el archivo no es de un tipo que aceptemos exponer.
 */
function publicUrl(urlOrPath) {
  const clean = toRelativePath(urlOrPath);
  if (!clean || !isPubliclyServable(clean)) return null;

  const encoded = clean
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");

  return `/media/${sign(clean)}/${encoded}`;
}

/**
 * Convierte una URL relativa de la app en absoluta (necesario en correos).
 */
function absoluteUrl(url, baseUrl = process.env.APP_BASE_URL || "") {
  if (!url) return "";
  if (/^https?:\/\//i.test(url)) return url;
  const base = String(baseUrl).replace(/\/+$/, "");
  return `${base}${url.startsWith("/") ? "" : "/"}${url}`;
}

module.exports = {
  SIGNATURE_LENGTH,
  PUBLIC_EXTENSIONS,
  PUBLIC_CONTENT_TYPES,
  isPubliclyServable,
  isSafeContentType,
  contentTypeFor,
  toRelativePath,
  sign,
  verify,
  publicUrl,
  absoluteUrl,
};
