// Miniatura de una foto de evento.
//
// La galería muestra el JPEG original (varios MB) en el mosaico, el slider y
// la portada. Aquí se guarda una copia de hasta 960 px junto al original, en
// eventos/<slug>/thumbs/, que el listado no recorre. El original queda para
// el visor y la descarga.

const fs = require("node:fs/promises");
const path = require("node:path");
const { normalizeRelativePath } = require("../storage/storagePath");
const fileStorage = require("../fileStorage");
const storage = require("../storage/storageService");
const contentCache = require("../storage/contentCache");

const THUMB_SEGMENT = "thumbs";
const MAX_EDGE = 960;
const JPEG_QUALITY = 75;
const IMAGE_EXTENSIONS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".avif",
]);

function extensionOf(relativePath) {
  return path.posix.extname(String(relativePath || "")).toLowerCase();
}

function canonicalPath(relativePath) {
  try {
    return normalizeRelativePath(relativePath);
  } catch {
    return "";
  }
}

function eventImageParts(relativePath) {
  const clean = canonicalPath(relativePath);
  if (!clean.startsWith("eventos/")) return null;
  const parts = clean.split("/");
  if (parts.length !== 3) return null;
  if (!IMAGE_EXTENSIONS.has(extensionOf(parts[2]))) return null;
  return { slug: parts[1], fileName: parts[2], relativePath: clean };
}

function isEventImagePath(relativePath) {
  return Boolean(eventImageParts(relativePath));
}

function isEventThumbnailPath(relativePath) {
  const clean = canonicalPath(relativePath);
  const parts = clean.split("/");
  return (
    parts.length === 4 &&
    parts[0] === "eventos" &&
    parts[2] === THUMB_SEGMENT &&
    extensionOf(parts[3]) === ".jpg"
  );
}

function isEventMediaPath(relativePath) {
  const clean = canonicalPath(relativePath);
  const parts = clean.split("/");
  if (parts[0] !== "eventos" || parts.length < 3) return false;
  if (parts.length === 3) return Boolean(parts[1] && parts[2]);
  return isEventThumbnailPath(clean);
}

function isDiskCacheable(relativePath) {
  return isEventImagePath(relativePath) || isEventThumbnailPath(relativePath);
}

function thumbnailRelativePath(relativePath) {
  const parts = eventImageParts(relativePath);
  if (!parts) return "";
  const ext = extensionOf(parts.fileName);
  const base = ext ? parts.fileName.slice(0, -ext.length) : parts.fileName;
  return `eventos/${parts.slug}/${THUMB_SEGMENT}/${base}.jpg`;
}

function previewUrl(publicUrl) {
  if (!publicUrl) return "";
  const thumb = thumbnailRelativePath(publicUrl);
  if (!thumb) return String(publicUrl);
  return fileStorage.getPublicUrl(thumb);
}

function cacheControlFor(relativePath) {
  if (isEventThumbnailPath(relativePath)) {
    return "private, max-age=86400, no-transform";
  }
  if (isEventMediaPath(relativePath)) {
    return "private, max-age=604800, immutable, no-transform";
  }
  return "private, max-age=300, no-transform";
}

function storedPathsFor(publicIdOrUrl) {
  const relative = fileStorage.resolveStoredPath(publicIdOrUrl);
  if (!relative) return [];
  const thumb = thumbnailRelativePath(relative);
  return thumb ? [relative, thumb] : [relative];
}

async function renderThumbnail(buffer) {
  const { loadImage, createCanvas } = require("@napi-rs/canvas");
  const image = await loadImage(buffer);
  const srcW = image.width;
  const srcH = image.height;
  if (!srcW || !srcH) {
    throw new Error("La imagen no tiene dimensiones.");
  }

  const scale = Math.min(1, MAX_EDGE / srcW, MAX_EDGE / srcH);
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);
  return canvas.toBuffer("image/jpeg", JPEG_QUALITY);
}

async function createFromLocalFile(localFilePath, originalRelativePath, deps = {}) {
  const thumbPath = thumbnailRelativePath(originalRelativePath);
  if (!thumbPath) return null;

  const source = await fs.readFile(localFilePath);
  const render = deps.renderThumbnail || renderThumbnail;
  const jpeg = await render(source);
  const upload = deps.uploadFile || storage.uploadFile.bind(storage);
  await upload(jpeg, thumbPath, {
    contentType: "image/jpeg",
    upsert: true,
    cacheControl: "86400",
  });
  await contentCache.forget(thumbPath);
  return { relativePath: thumbPath, size: jpeg.length };
}

async function removeStored(publicIdOrUrl) {
  const paths = storedPathsFor(publicIdOrUrl);
  for (const relativePath of paths) {
    await fileStorage.deleteFile(relativePath);
    await contentCache.forget(relativePath);
  }
}

module.exports = {
  MAX_EDGE,
  JPEG_QUALITY,
  isEventImagePath,
  isEventThumbnailPath,
  isEventMediaPath,
  isDiskCacheable,
  thumbnailRelativePath,
  previewUrl,
  cacheControlFor,
  storedPathsFor,
  renderThumbnail,
  createFromLocalFile,
  removeStored,
};
