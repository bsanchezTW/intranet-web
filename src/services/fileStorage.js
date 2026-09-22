// Fachada de almacenamiento de archivos de la aplicación. El contrato público
// (/content, secure_url y public_id) no depende del proveedor físico.
const path = require("path");
const crypto = require("crypto");
const storage = require("./storage/storageService");
const { createSupabaseStorageService } = require("./supabaseStorageService");
const { getStorageConfig } = require("../config/storage");
const {
  countryStorageBuckets,
  defaultStorageBucketForCountry,
} = require("../config/supabaseProjects");

const SHARED_APP_OBJECT_PREFIXES = Object.freeze([
  "apps_icons/",
  "apps_instructivos/",
  "apps_qr/",
]);

// Fotos y videos de la galería compartida. El archivo queda en el bucket del
// país que lo subió; la otra intranet lo lee desde ahí.
const SHARED_EVENT_OBJECT_PREFIX = "eventos/";

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

function storageServiceForBucket(bucket, deps = {}) {
  const createService = deps.createService || createSupabaseStorageService;
  const config = deps.storageConfig || getStorageConfig();
  return createService({ config: { ...config, bucket } });
}

function isSharedAppObjectPath(relativePath) {
  const clean = String(relativePath || "");
  return SHARED_APP_OBJECT_PREFIXES.some((prefix) => clean.startsWith(prefix));
}

function isSharedEventObjectPath(relativePath) {
  const clean = String(relativePath || "");
  return clean === "eventos" || clean.startsWith(SHARED_EVENT_OBJECT_PREFIX);
}

function usesAllCountryBuckets(relativePath) {
  return isSharedAppObjectPath(relativePath) || isSharedEventObjectPath(relativePath);
}

function orderedCountryBuckets(deps = {}) {
  const buckets = countryStorageBuckets();
  const current =
    deps.storageConfig?.bucket || defaultStorageBucketForCountry(process.env.COUNTRY);
  if (!current || !buckets.includes(current)) return buckets;
  return [current, ...buckets.filter((bucket) => bucket !== current)];
}

function isMissingObjectError(err) {
  if (!err) return false;
  if (err.statusCode === 404) return true;
  const message = String(err.message || "");
  return (
    err.statusCode === 400 &&
    /not found|no such key|object not found/i.test(message)
  );
}

async function withSharedAppBuckets(relativePath, deps = {}, operation) {
  const clean = storage.normalizeRelativePath(relativePath);
  if (!usesAllCountryBuckets(clean)) {
    const buckets = orderedCountryBuckets(deps);
    const svc =
      deps.createService || deps.storageConfig
        ? storageServiceForBucket(buckets[0], deps)
        : storage;
    return operation(svc);
  }

  let lastError;
  for (const bucket of orderedCountryBuckets(deps)) {
    try {
      return await operation(storageServiceForBucket(bucket, deps));
    } catch (err) {
      lastError = err;
      if (!isMissingObjectError(err)) throw err;
    }
  }
  throw lastError;
}

async function streamStoredObject(relativePath, options = {}, deps = {}) {
  return withSharedAppBuckets(relativePath, deps, (svc) =>
    svc.downloadStream(relativePath, options),
  );
}

async function statStoredObject(relativePath, options = {}, deps = {}) {
  return withSharedAppBuckets(relativePath, deps, (svc) =>
    svc.statFile(relativePath, options),
  );
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
 * Sube el mismo objeto a los buckets de Chile y Perú. El catálogo de apps es
 * compartido: /content/... tiene que resolver en las dos instancias.
 */
async function saveFileInAllCountryBuckets(
  buffer,
  folder,
  originalFileName = "file",
  options = {},
  deps = {},
) {
  const fileName = generateFileName(originalFileName);
  const folderClean = storage.normalizeRelativePath(folder);
  const relativePath = folderClean ? `${folderClean}/${fileName}` : fileName;
  const uploaded = [];

  try {
    let first = null;
    for (const bucket of countryStorageBuckets()) {
      const result = await storageServiceForBucket(bucket, deps).uploadFile(
        buffer,
        relativePath,
        options,
      );
      uploaded.push({ bucket, relativePath });
      if (!first) first = result;
    }
    return mapUploadedFile(first || {}, relativePath, fileName, buffer.length, options);
  } catch (err) {
    await Promise.allSettled(
      uploaded.map(({ bucket, relativePath: objectPath }) =>
        storageServiceForBucket(bucket, deps).deleteFile(objectPath),
      ),
    );
    throw err;
  }
}

/**
 * Borra referencias de apps en todos los buckets de país. Un objeto ausente
 * en uno de ellos no aborta el lote.
 */
async function deleteFilesInAllCountryBuckets(publicIdsOrUrls = [], deps = {}) {
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

  let deleted = 0;
  let failed = 0;
  for (const bucket of countryStorageBuckets()) {
    const svc = storageServiceForBucket(bucket, deps);
    const results = await Promise.allSettled(
      uniquePaths.map((relativePath) => svc.deleteFile(relativePath)),
    );
    results.forEach((result) => {
      if (result.status === "fulfilled" && result.value) deleted += 1;
      else if (result.status === "rejected") failed += 1;
    });
  }

  return { deleted, failed, paths: uniquePaths };
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

/**
 * Igual que saveFileAs, pero lee desde un archivo temporal (videos grandes)
 * en vez de cargar el buffer completo en el heap.
 */
async function saveFileAsFromPath(localFilePath, folder, fileName, options = {}) {
  const cleanName = sanitizeBaseName(fileName);
  const folderClean = storage.normalizeRelativePath(folder);
  const relativePath = folderClean ? `${folderClean}/${cleanName}` : cleanName;
  const uploaded = await storage.uploadFileFromPath(
    localFilePath,
    relativePath,
    options,
  );
  return mapUploadedFile(
    uploaded,
    relativePath,
    cleanName,
    uploaded.size,
    options,
  );
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

async function deleteFile(publicIdOrUrl, deps = {}) {
  const relativePath = resolveStoredPath(publicIdOrUrl);
  if (!relativePath) return false;
  if (!isSharedEventObjectPath(relativePath)) {
    return storage.deleteFile(relativePath);
  }

  let deleted = false;
  for (const bucket of orderedCountryBuckets(deps)) {
    try {
      const ok = await storageServiceForBucket(bucket, deps).deleteFile(relativePath);
      if (ok) deleted = true;
    } catch (err) {
      if (!isMissingObjectError(err)) throw err;
    }
  }
  return deleted;
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

async function deleteFolder(folder, deps = {}) {
  const folderClean = storage.normalizeRelativePath(folder);
  if (!isSharedEventObjectPath(folderClean)) {
    return storage.deleteFolder(folderClean);
  }

  let deleted = false;
  for (const bucket of orderedCountryBuckets(deps)) {
    try {
      const ok = await storageServiceForBucket(bucket, deps).deleteFolder(folderClean);
      if (ok) deleted = true;
    } catch (err) {
      if (!isMissingObjectError(err)) throw err;
    }
  }
  return deleted;
}

function mapListedFile(item) {
  return {
    public_id: item.relativePath,
    secure_url: getPublicUrl(item.relativePath),
    url: getPublicUrl(item.relativePath),
    name: item.name,
    created_at: item.created_at,
    size: item.size,
    contentType: item.contentType,
    resource_type: getResourceType(item.name),
    storageId: item.storageId || item.relativePath,
  };
}

async function listFiles(folder, { limit } = {}, deps = {}) {
  const folderClean = storage.normalizeRelativePath(folder);
  if (!isSharedEventObjectPath(folderClean)) {
    const items = await storage.listFilesInFolder(folderClean, { limit });
    return items.map(mapListedFile);
  }

  const seen = new Set();
  const merged = [];
  for (const bucket of orderedCountryBuckets(deps)) {
    let items = [];
    try {
      items = await storageServiceForBucket(bucket, deps).listFilesInFolder(folderClean, {
        limit,
      });
    } catch (err) {
      if (!isMissingObjectError(err)) throw err;
    }
    for (const item of items) {
      if (!item?.relativePath || seen.has(item.relativePath)) continue;
      seen.add(item.relativePath);
      merged.push(item);
    }
  }

  merged.sort((left, right) => {
    const leftTime = new Date(left.created_at).getTime() || 0;
    const rightTime = new Date(right.created_at).getTime() || 0;
    return rightTime - leftTime;
  });
  const sliced = limit ? merged.slice(0, limit) : merged;
  return sliced.map(mapListedFile);
}

function validateFileSize(buffer, maxSizeMB = 100) {
  return buffer.length <= maxSizeMB * 1024 * 1024;
}

module.exports = {
  saveFile,
  saveFileInAllCountryBuckets,
  saveFileAs,
  saveFileAsFromPath,
  saveFileFromPath,
  deleteFile,
  deleteFiles,
  deleteFilesInAllCountryBuckets,
  streamStoredObject,
  statStoredObject,
  isSharedAppObjectPath,
  isSharedEventObjectPath,
  moveFile,
  deleteFolder,
  listFiles,
  getPublicUrl,
  validateFileSize,
  getResourceType,
  resolveStoredPath,
};
