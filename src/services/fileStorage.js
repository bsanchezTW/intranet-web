// Fachada de almacenamiento de archivos de la aplicación. El contrato público
// (/content, secure_url y public_id) no depende del proveedor físico.
const path = require("path");
const crypto = require("crypto");
const storage = require("./storage/storageService");

function getPublicUrl(relativePath) {
  const clean = storage.normalizeRelativePath(relativePath);
  const encoded = clean
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  return `/content/${encoded}`;
}

function sanitizeBaseName(name) {
  return String(name)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "archivo";
}

function generateFileName(originalFileName = "file") {
  const timestamp = Date.now();
  const random = crypto.randomBytes(4).toString("hex");
  const ext = path.extname(originalFileName).toLowerCase() || "";
  const baseName = sanitizeBaseName(path.basename(originalFileName, ext));
  return `${baseName}-${timestamp}-${random}${ext}`;
}

function getResourceType(fileName) {
  const ext = path.extname(fileName).toLowerCase();
  if ([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".avif"].includes(ext)) {
    return "image";
  }
  if ([".mp4", ".webm", ".avi", ".mov", ".mkv", ".m4v"].includes(ext)) {
    return "video";
  }
  return "raw";
}

function mapUploadedFile(uploaded, relativePath, fileName, fallbackSize, options) {
  return {
    secure_url: getPublicUrl(relativePath),
    public_id: relativePath,
    url: getPublicUrl(relativePath),
    fileName,
    storageId: uploaded.storageId || uploaded.path || relativePath,
    contentType: uploaded.contentType || options.contentType || "application/octet-stream",
    size: uploaded.size ?? fallbackSize,
    resource_type: getResourceType(fileName),
  };
}

/**
 * Guarda un buffer en el storage privado de la instancia.
 * @param {{contentType?: string, cacheControl?: string, upsert?: boolean}} options
 * @returns {Promise<{secure_url: string, public_id: string, url: string,
 *   fileName: string, storageId: string|null, contentType: string, size: number,
 *   resource_type: string}>}
 */
async function saveFile(buffer, folder, originalFileName = "file", options = {}) {
  const fileName = generateFileName(originalFileName);
  const folderClean = storage.normalizeRelativePath(folder);
  const relativePath = folderClean ? `${folderClean}/${fileName}` : fileName;

  const uploaded = await storage.uploadFile(buffer, relativePath, options);
  return mapUploadedFile(uploaded, relativePath, fileName, buffer.length, options);
}

/**
 * Guarda un buffer con un nombre exacto, sin sufijo aleatorio (p. ej. los
 * adjuntos de tickets, <N° de ticket>_1.png). Quien llama garantiza que el
 * nombre es único.
 */
async function saveFileAs(buffer, folder, fileName, options = {}) {
  const cleanName = sanitizeBaseName(fileName);
  const folderClean = storage.normalizeRelativePath(folder);
  const relativePath = folderClean ? `${folderClean}/${cleanName}` : cleanName;

  const uploaded = await storage.uploadFile(buffer, relativePath, options);
  return mapUploadedFile(uploaded, relativePath, cleanName, buffer.length, options);
}

async function saveFileFromPath(
  localFilePath,
  folder,
  originalFileName = "file",
  options = {},
) {
  const fileName = generateFileName(originalFileName);
  const folderClean = storage.normalizeRelativePath(folder);
  const relativePath = folderClean ? `${folderClean}/${fileName}` : fileName;
  const uploaded = await storage.uploadFileFromPath(
    localFilePath,
    relativePath,
    options,
  );
  return mapUploadedFile(
    uploaded,
    relativePath,
    fileName,
    uploaded.size,
    options,
  );
}

/**
 * Resuelve public_id, /content/... o /media/<firma>/... a la clave del bucket.
 * Las rutas legacy /uploads/ no viven en Supabase y se ignoran.
 */
function resolveStoredPath(publicIdOrUrl) {
  if (!publicIdOrUrl) return "";
  const raw = String(publicIdOrUrl).trim();
  if (!raw) return "";
  if (raw.startsWith("/uploads/") || raw.includes("/uploads/")) return "";
  try {
    return storage.normalizeRelativePath(raw);
  } catch {
    return "";
  }
}

async function deleteFile(publicIdOrUrl) {
  const relativePath = resolveStoredPath(publicIdOrUrl);
  if (!relativePath) return false;
  return storage.deleteFile(relativePath);
}

/**
 * Borra varias referencias de storage. Deduplica rutas y no falla el lote
 * completo si un objeto ya no existe o una ruta es inválida.
 * @returns {Promise<{deleted: number, failed: number, paths: string[]}>}
 */
async function deleteFiles(publicIdsOrUrls = []) {
  const uniquePaths = [];
  const seen = new Set();

  for (const ref of publicIdsOrUrls) {
    const relativePath = resolveStoredPath(ref);
    if (!relativePath || seen.has(relativePath)) continue;
    seen.add(relativePath);
    uniquePaths.push(relativePath);
  }

  if (!uniquePaths.length) {
    return { deleted: 0, failed: 0, paths: [] };
  }

  const results = await Promise.allSettled(
    uniquePaths.map((relativePath) => storage.deleteFile(relativePath)),
  );

  let deleted = 0;
  let failed = 0;
  results.forEach((result) => {
    if (result.status === "fulfilled" && result.value) deleted += 1;
    else if (result.status === "rejected") failed += 1;
  });

  return { deleted, failed, paths: uniquePaths };
}

/**
 * Mueve un archivo dentro del storage y devuelve su nueva referencia pública.
 * Falla si el destino ya existe.
 * @returns {Promise<{secure_url: string, url: string, public_id: string}>}
 */
async function moveFile(fromPublicIdOrUrl, toRelativePath) {
  const from = resolveStoredPath(fromPublicIdOrUrl);
  const to = storage.normalizeRelativePath(toRelativePath);
  if (!from || !to) throw new Error("Ruta de archivo inválida para mover.");
  await storage.moveFile(from, to);
  return { secure_url: getPublicUrl(to), url: getPublicUrl(to), public_id: to };
}

async function deleteFolder(folder) {
  return storage.deleteFolder(folder);
}

async function listFiles(folder, { limit } = {}) {
  const folderClean = storage.normalizeRelativePath(folder);
  const items = await storage.listFilesInFolder(folderClean, { limit });

  return items.map((item) => ({
    public_id: item.relativePath,
    secure_url: getPublicUrl(item.relativePath),
    url: getPublicUrl(item.relativePath),
    name: item.name,
    created_at: item.created_at,
    size: item.size,
    contentType: item.contentType,
    resource_type: getResourceType(item.name),
    storageId: item.storageId || item.relativePath,
  }));
}

function validateFileSize(buffer, maxSizeMB = 100) {
  return buffer.length <= maxSizeMB * 1024 * 1024;
}

module.exports = {
  saveFile,
  saveFileAs,
  saveFileFromPath,
  deleteFile,
  deleteFiles,
  moveFile,
  deleteFolder,
  listFiles,
  getPublicUrl,
  validateFileSize,
  getResourceType,
  resolveStoredPath,
};
