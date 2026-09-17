const path = require("node:path");

/**
 * Nombres de objeto en el bucket de noticias. Misma regla que tickets:
 * <N° de noticia>_1, _2…  La portada usa el hueco reservado `_portada`.
 * El nombre original se conserva en el JSON para mostrarlo.
 */

const UPLOAD_FOLDER = "noticias_adjuntos";
const PREVIEW_FOLDER = `${UPLOAD_FOLDER}/previews`;
const RENDER_FOLDER = `${UPLOAD_FOLDER}/renders`;
const WORD_MEDIA_FOLDER = `${UPLOAD_FOLDER}/word_media`;
const MAX_ATTACHMENTS = 20;

const SAFE_EXT = /^\.[a-z0-9]{1,8}$/;

function withAttachmentExtension(baseName, originalName = "") {
  const ext = path.extname(String(originalName)).toLowerCase();
  return `${baseName}${SAFE_EXT.test(ext) ? ext : ""}`;
}

function requireNewsId(noticiaId) {
  const id = Number(noticiaId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new Error("Falta el número de la noticia para nombrar el archivo.");
  }
  return id;
}

function requireIndex(index) {
  const n = Number(index);
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new Error("Falta el correlativo del archivo de la noticia.");
  }
  return n;
}

function attachmentFileName(noticiaId, index, originalName = "") {
  return withAttachmentExtension(
    `${requireNewsId(noticiaId)}_${requireIndex(index)}`,
    originalName,
  );
}

function coverFileName(noticiaId, originalName = "portada.jpg") {
  return withAttachmentExtension(`${requireNewsId(noticiaId)}_portada`, originalName);
}

function previewFileName(baseName, page, totalPages, mime = "image/jpeg") {
  const suffix = totalPages === 1 || page === 1 ? "portada" : `p${page}`;
  const ext = mime === "image/png" ? ".png" : ".jpg";
  return `${baseName}-${suffix}${ext}`;
}

function renderFileName(baseName) {
  return `${baseName}.html`;
}

function wordImageFileName(baseName, index, extension = ".png") {
  const ext = SAFE_EXT.test(extension) ? extension : ".png";
  return `${baseName}_w${requireIndex(index)}${ext}`;
}

function objectPath(folder, fileName) {
  return `${folder}/${fileName}`;
}

function stemOf(fileName) {
  return String(fileName || "").replace(/\.[^.]+$/, "");
}

function canonicalIndex(fileName, noticiaId) {
  const id = Number(noticiaId);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  const match = new RegExp(`^${id}_(\\d+)(?:\\.[a-z0-9]{1,8})?$`, "i").exec(
    path.posix.basename(String(fileName || "")),
  );
  return match ? Number(match[1]) : null;
}

function isCanonicalCoverName(fileName, noticiaId) {
  const id = Number(noticiaId);
  if (!Number.isSafeInteger(id) || id <= 0) return false;
  return new RegExp(`^${id}_portada(?:\\.[a-z0-9]{1,8})?$`, "i").test(
    path.posix.basename(String(fileName || "")),
  );
}

/**
 * Adjuntos que aún viven fuera del bucket (HTTP remoto).
 * Se descargan y se copian a Storage con el nombre canónico.
 */
function isRemoteMediaUrl(url) {
  const raw = String(url || "").trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  return !/\/(?:content|media)\//i.test(raw);
}

module.exports = {
  UPLOAD_FOLDER,
  PREVIEW_FOLDER,
  RENDER_FOLDER,
  WORD_MEDIA_FOLDER,
  MAX_ATTACHMENTS,
  withAttachmentExtension,
  attachmentFileName,
  coverFileName,
  previewFileName,
  renderFileName,
  wordImageFileName,
  objectPath,
  stemOf,
  canonicalIndex,
  isCanonicalCoverName,
  isRemoteMediaUrl,
};
