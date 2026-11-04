const crypto = require("crypto");
const fileStorage = require("../fileStorage");
const { readStreamToBuffer } = require("../storage/contentCache");

/**
 * Fotos de la revisión física: daños, reparaciones y capturas del modelo 3D.
 *
 * Toda imagen se vuelve a codificar en el servidor como JPEG de a lo más
 * MAX_EDGE px por lado: así lo guardado es siempre una imagen (no cualquier
 * archivo con extensión .jpg), sin metadatos (ubicación GPS del teléfono) y
 * liviana para el PDF. El teléfono ya las manda reducidas; esto es la
 * garantía.
 *
 * Quedan en Storage bajo logistica/, que /content no sirve: las entrega
 * /logistica/flota/fotos/:id después de revisar el permiso.
 */

const MAX_EDGE = 1600;
const JPEG_QUALITY = 82;
const STORAGE_PREFIX = "logistica";

class PhotoError extends Error {
  constructor(message) {
    super(message);
    this.code = "PHOTO_INVALID";
  }
}

/** Reduce y vuelve a codificar. `{ buffer, width, height }` o PhotoError. */
async function processImage(input, { maxEdge = MAX_EDGE, quality = JPEG_QUALITY } = {}) {
  const { loadImage, createCanvas } = require("@napi-rs/canvas");
  let image;
  try {
    image = await loadImage(input);
  } catch {
    throw new PhotoError("Una de las fotos no es una imagen válida. Usa fotos JPG o PNG.");
  }
  const srcW = image.width;
  const srcH = image.height;
  if (!srcW || !srcH) throw new PhotoError("Una de las fotos no tiene contenido.");
  const scale = Math.min(1, maxEdge / srcW, maxEdge / srcH);
  const width = Math.max(1, Math.round(srcW * scale));
  const height = Math.max(1, Math.round(srcH * scale));
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, 0, 0, width, height);
  return { buffer: canvas.toBuffer("image/jpeg", quality), width, height };
}

/** Carpeta nueva y única para un lote (no depende de ids que aún no existen). */
function newFolder(kind, year) {
  return `${STORAGE_PREFIX}/${kind}/${year}/${crypto.randomUUID()}`;
}

/**
 * Sube un lote de imágenes ya procesadas: [{ name, buffer, ... }]. Devuelve
 * el mismo arreglo con `storage_path`. Si una falla, borra las que alcanzó a
 * subir y relanza el error.
 */
async function storeAll(images, folder, deps = {}) {
  const save = deps.saveFileAs || fileStorage.saveFileAs;
  const stored = [];
  try {
    for (const img of images) {
      const res = await save(img.buffer, folder, img.name, { contentType: "image/jpeg", cacheControl: "86400" });
      stored.push({ ...img, storage_path: res.public_id, size_bytes: img.buffer.length });
    }
    return stored;
  } catch (err) {
    await removeAll(stored.map((s) => s.storage_path), deps);
    throw err;
  }
}

/** Borra rutas de Storage sin fallar (lo que no se pudo queda en el log). */
async function removeAll(paths, deps = {}) {
  const clean = (paths || []).filter(Boolean);
  if (!clean.length) return;
  try {
    const remove = deps.deleteFiles || fileStorage.deleteFiles;
    await remove(clean);
  } catch (err) {
    console.error("[Logística] No se pudieron borrar fotos de Storage:", err.message);
  }
}

/** Contenido de una foto guardada (para el PDF). */
async function readStored(storagePath, deps = {}) {
  const stream = deps.streamStoredObject || fileStorage.streamStoredObject;
  const file = await stream(storagePath);
  return readStreamToBuffer(file.stream);
}

/** ¿Es una ruta de este módulo? (lo que guardan las tablas). */
function isOwnPath(storagePath) {
  return typeof storagePath === "string" && storagePath.startsWith(`${STORAGE_PREFIX}/`);
}

module.exports = {
  MAX_EDGE,
  STORAGE_PREFIX,
  PhotoError,
  processImage,
  newFolder,
  storeAll,
  removeAll,
  readStored,
  isOwnPath,
};
