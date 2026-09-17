const { Readable } = require("node:stream");
const fs = require("node:fs/promises");
const { createClient } = require("@supabase/supabase-js");

const {
  DEFAULT_STORAGE_BUCKET,
  DEFAULT_MAX_FILE_SIZE_MB,
  DEFAULT_TUS_THRESHOLD_MB,
  DEFAULT_TUS_CHUNK_SIZE_MB,
  DEFAULT_LIST_PAGE_SIZE,
  DEFAULT_DELETE_BATCH_SIZE,
  getStorageConfig,
} = require("../config/storage");
const {
  normalizeRelativePath,
  requireFilePath,
  encodeObjectPath,
  inferContentType,
  validateContentType,
} = require("./storage/storagePath");
const {
  StorageServiceError,
  StorageNotFoundError,
  StorageConflictError,
  StorageValidationError,
  StoragePathError,
  StoragePartialFailureError,
  toStorageError,
} = require("./storage/storageErrors");

const MEBIBYTE = 1024 * 1024;
const DEFAULT_CACHE_CONTROL = "3600";
const TUS_VERSION = "1.0.0";

function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input;
  if (input instanceof ArrayBuffer) return Buffer.from(input);
  if (ArrayBuffer.isView(input)) {
    return Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  }
  throw new StorageValidationError("El archivo debe ser un Buffer o ArrayBuffer.", {
    code: "STORAGE_INVALID_FILE_BODY",
  });
}

function normalizeRuntimeConfig(config) {
  const supplied = config || getStorageConfig();
  return Object.freeze({
    ...supplied,
    bucket: supplied.bucket || DEFAULT_STORAGE_BUCKET,
    maxFileSizeBytes:
      supplied.maxFileSizeBytes || DEFAULT_MAX_FILE_SIZE_MB * MEBIBYTE,
    tusThresholdBytes:
      supplied.tusThresholdBytes || DEFAULT_TUS_THRESHOLD_MB * MEBIBYTE,
    tusChunkSizeBytes:
      supplied.tusChunkSizeBytes || DEFAULT_TUS_CHUNK_SIZE_MB * MEBIBYTE,
    listPageSize: supplied.listPageSize || DEFAULT_LIST_PAGE_SIZE,
    deleteBatchSize: supplied.deleteBatchSize || DEFAULT_DELETE_BATCH_SIZE,
  });
}

function createPrivateClient(config, fetchImpl) {
  if (!config.url || !config.key) {
    throw new StorageServiceError(
      "Supabase Storage requiere SUPABASE_URL y una clave privada.",
      { code: "STORAGE_CONFIGURATION_ERROR", statusCode: 500 },
    );
  }

  return createClient(config.url, config.key, {
    auth: {
      autoRefreshToken: false,
      detectSessionInUrl: false,
      persistSession: false,
    },
    ...(fetchImpl ? { global: { fetch: fetchImpl } } : {}),
  });
}

function buildAuthHeaders(key) {
  const headers = { apikey: key };
  // Las claves sb_secret_* no son JWT y Supabase indica que no deben enviarse
  // como Bearer. Las service_role legacy sí lo necesitan.
  if (key && !String(key).startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${key}`;
  }
  return headers;
}

function buildObjectUrl(config, relativePath) {
  if (!config.url) {
    throw new StorageServiceError(
      "SUPABASE_URL es necesaria para descargar por streaming.",
      { code: "STORAGE_STREAM_CONFIGURATION_ERROR", statusCode: 500 },
    );
  }
  const bucket = encodeURIComponent(config.bucket);
  return `${config.url.replace(/\/+$/, "")}/storage/v1/object/${bucket}/${encodeObjectPath(relativePath)}`;
}

function buildTusUrl(config) {
  if (!config.url || !config.key) {
    throw new StorageServiceError(
      "La subida resumible requiere SUPABASE_URL y una clave privada.",
      { code: "STORAGE_TUS_CONFIGURATION_ERROR", statusCode: 500 },
    );
  }
  return `${config.url.replace(/\/+$/, "")}/storage/v1/upload/resumable`;
}

function parseHeaderInteger(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

async function errorFromResponse(response, context = {}) {
  let message = `${response.status} ${response.statusText || "Error de Storage"}`.trim();
  let details;
  try {
    const raw = await response.text();
    if (raw) {
      try {
        details = JSON.parse(raw);
        message = details.message || details.error || message;
      } catch {
        details = raw.slice(0, 2000);
        message = details || message;
      }
    }
  } catch {
    // El cuerpo de error no siempre está disponible (p. ej. una respuesta mock).
  }

  const json = details && typeof details === "object" ? details : {};
  const jsonStatus = Number(json.statusCode);
  const looksMissing =
    jsonStatus === 404 ||
    json.error === "not_found" ||
    json.errorCode === "not_found" ||
    /object not found|not found|no such key/i.test(String(message));

  return toStorageError(
    {
      message,
      statusCode: looksMissing ? 404 : response.status,
      code: json.errorCode || json.code || (looksMissing ? "STORAGE_NOT_FOUND" : undefined),
      details,
    },
    context,
  );
}

function toDate(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isFolderEntry(item) {
  return !item?.id && !item?.metadata;
}

function mapListFile(item, folder) {
  const relativePath = folder ? `${folder}/${item.name}` : item.name;
  const createdAt = toDate(item.created_at || item.updated_at);
  const metadata = item.metadata || {};
  return {
    name: item.name,
    relativePath,
    created_at: createdAt,
    updated_at: toDate(item.updated_at),
    size: Number(metadata.size) || 0,
    contentType:
      metadata.mimetype || metadata.contentType || inferContentType(relativePath),
    storageId: item.id || null,
    etag: metadata.eTag || metadata.etag || null,
    metadata,
  };
}

function normalizeRange(range) {
  if (range === undefined || range === null || range === "") return null;
  if (typeof range === "string" && /^bytes=(?:\d+-\d*|-\d+)$/.test(range)) {
    return range;
  }
  if (typeof range === "object") {
    const start = range.start;
    const end = range.end;
    if (
      Number.isSafeInteger(start) &&
      start >= 0 &&
      (end === undefined || (Number.isSafeInteger(end) && end >= start))
    ) {
      return `bytes=${start}-${end ?? ""}`;
    }
  }
  throw new StorageValidationError("Rango HTTP inválido.", {
    code: "STORAGE_INVALID_RANGE",
  });
}

function normalizeCacheControl(value) {
  const clean = String(value ?? DEFAULT_CACHE_CONTROL).trim().toLowerCase();
  if (clean === "no-cache" || clean === "no-store") return "0";
  const maxAgeMatch = clean.match(/^(?:public,\s*)?max-age=(\d+)$/);
  const seconds = maxAgeMatch?.[1] || clean;
  if (!/^\d+$/.test(seconds)) {
    throw new StorageValidationError(
      "cacheControl debe ser una cantidad de segundos (por ejemplo, 3600).",
      { code: "STORAGE_INVALID_CACHE_CONTROL" },
    );
  }
  return seconds;
}

function normalizeOptionalLimit(limit) {
  if (limit === undefined || limit === null) return undefined;
  const parsed = Number(limit);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new StorageValidationError("El límite de listado debe ser un entero positivo.", {
      code: "STORAGE_INVALID_LIST_LIMIT",
    });
  }
  return parsed;
}

function encodeTusMetadata(metadata) {
  return Object.entries(metadata)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name, value]) => `${name} ${Buffer.from(String(value), "utf8").toString("base64")}`)
    .join(",");
}

function isTransient(error) {
  return Boolean(
    error?.retryable ||
      error?.statusCode === 409 ||
      error?.statusCode === 429 ||
      error?.statusCode >= 500,
  );
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createSupabaseStorageService(options = {}) {
  const config = normalizeRuntimeConfig(options.config);
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const client =
    options.client || createPrivateClient(config, options.clientFetchImpl || fetchImpl);
  const bucket = client.storage.from(config.bucket);
  const sleep = options.sleep || defaultSleep;
  const largeUploadHandler = options.largeUploadHandler;

  async function listChildren(folderRelative, { fileLimit } = {}) {
    const folder = normalizeRelativePath(folderRelative);
    const results = [];
    let offset = 0;
    let fileCount = 0;

    while (true) {
      let response;
      try {
        response = await bucket.list(folder, {
          limit: config.listPageSize,
          offset,
          sortBy: { column: "name", order: "asc" },
        });
      } catch (error) {
        throw toStorageError(error, { operation: "list", relativePath: folder });
      }

      if (response.error) {
        throw toStorageError(response.error, {
          operation: "list",
          relativePath: folder,
        });
      }

      const page = response.data || [];
      results.push(...page);
      fileCount += page.filter((item) => !isFolderEntry(item)).length;
      if (fileLimit && fileCount >= fileLimit) break;
      if (page.length < config.listPageSize) break;
      offset += page.length;
    }

    return results;
  }

  async function getTusOffset(uploadUrl, relativePath, signal, retryOptions = {}) {
    const maxRetries = retryOptions.maxRetries ?? 3;
    const retryDelays = retryOptions.retryDelays || [0, 500, 1500, 3000];
    let attempt = 0;

    while (true) {
      try {
        const response = await fetchImpl(uploadUrl, {
          method: "HEAD",
          headers: {
            ...buildAuthHeaders(config.key),
            "Tus-Resumable": TUS_VERSION,
          },
          signal,
        });
        if (!response.ok) {
          throw await errorFromResponse(response, {
            operation: "tus-head",
            relativePath,
          });
        }
        const offset = parseHeaderInteger(response.headers.get("upload-offset"));
        if (offset === undefined) {
          throw new StorageServiceError("TUS no devolvió Upload-Offset.", {
            code: "STORAGE_TUS_INVALID_RESPONSE",
            statusCode: 502,
            operation: "tus-head",
            relativePath,
          });
        }
        return offset;
      } catch (error) {
        const wrapped = toStorageError(error, {
          operation: "tus-head",
          relativePath,
        });
        if (!isTransient(wrapped) || attempt >= maxRetries) throw wrapped;
        const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)] || 0;
        if (delay) await sleep(delay);
        attempt += 1;
      }
    }
  }

  async function uploadWithTusSource(
    totalSize,
    relativePath,
    uploadOptions,
    readChunk,
  ) {
    if (typeof fetchImpl !== "function") {
      throw new StorageServiceError(
        "El runtime no ofrece fetch para realizar la subida resumible TUS.",
        { code: "STORAGE_TUS_UNAVAILABLE", statusCode: 500 },
      );
    }

    const endpoint = buildTusUrl(config);
    const creationHeaders = {
      ...buildAuthHeaders(config.key),
      "Tus-Resumable": TUS_VERSION,
      "Upload-Length": String(totalSize),
      "Upload-Metadata": encodeTusMetadata({
        bucketName: config.bucket,
        objectName: relativePath,
        contentType: uploadOptions.contentType,
        cacheControl: uploadOptions.cacheControl,
        metadata: uploadOptions.metadata
          ? JSON.stringify(uploadOptions.metadata)
          : undefined,
      }),
      "x-upsert": String(uploadOptions.upsert),
    };

    let creationResponse;
    try {
      creationResponse = await fetchImpl(endpoint, {
        method: "POST",
        headers: creationHeaders,
        signal: uploadOptions.signal,
      });
    } catch (error) {
      throw toStorageError(error, {
        operation: "tus-create",
        relativePath,
      });
    }

    if (!creationResponse.ok) {
      throw await errorFromResponse(creationResponse, {
        operation: "tus-create",
        relativePath,
      });
    }

    const location = creationResponse.headers.get("location");
    if (!location) {
      throw new StorageServiceError("TUS no devolvió la URL resumible.", {
        code: "STORAGE_TUS_INVALID_RESPONSE",
        statusCode: 502,
        operation: "tus-create",
        relativePath,
      });
    }

    const uploadUrl = new URL(location, endpoint).toString();
    let offset = parseHeaderInteger(creationResponse.headers.get("upload-offset")) || 0;
    const maxRetries = uploadOptions.maxRetries ?? 3;
    const retryDelays = uploadOptions.retryDelays || [0, 500, 1500, 3000];

    const loadChunk = async (start, end) => {
      const chunk = toBuffer(await readChunk(start, end));
      if (chunk.length !== end - start) {
        throw new StorageServiceError("No se pudo leer el fragmento TUS completo.", {
          code: "STORAGE_TUS_SOURCE_SHORT_READ",
          statusCode: 500,
          operation: "tus-read",
          relativePath,
        });
      }
      return chunk;
    };

    while (offset < totalSize) {
      const chunkEnd = Math.min(offset + config.tusChunkSizeBytes, totalSize);
      let chunk = await loadChunk(offset, chunkEnd);
      let attempt = 0;

      while (true) {
        try {
          const response = await fetchImpl(uploadUrl, {
            method: "PATCH",
            headers: {
              ...buildAuthHeaders(config.key),
              "Tus-Resumable": TUS_VERSION,
              "Upload-Offset": String(offset),
              "Content-Type": "application/offset+octet-stream",
            },
            body: chunk,
            signal: uploadOptions.signal,
          });

          if (!response.ok) {
            throw await errorFromResponse(response, {
              operation: "tus-patch",
              relativePath,
            });
          }

          const nextOffset = parseHeaderInteger(response.headers.get("upload-offset"));
          offset = nextOffset ?? chunkEnd;
          if (offset < chunkEnd || offset > totalSize) {
            throw new StorageServiceError("TUS devolvió un Upload-Offset inválido.", {
              code: "STORAGE_TUS_INVALID_OFFSET",
              statusCode: 502,
              operation: "tus-patch",
              relativePath,
            });
          }
          uploadOptions.onProgress?.(offset, totalSize);
          break;
        } catch (error) {
          const wrapped = toStorageError(error, {
            operation: "tus-patch",
            relativePath,
          });
          if (!isTransient(wrapped) || attempt >= maxRetries) throw wrapped;
          const delay = retryDelays[Math.min(attempt, retryDelays.length - 1)] || 0;
          if (delay) await sleep(delay);
          attempt += 1;
          offset = await getTusOffset(
            uploadUrl,
            relativePath,
            uploadOptions.signal,
            { maxRetries, retryDelays },
          );
          if (offset >= chunkEnd) break;
          chunk = await loadChunk(offset, chunkEnd);
        }
      }
    }

    return {
      id: null,
      path: relativePath,
      fullPath: `${config.bucket}/${relativePath}`,
      uploadUrl,
      resumable: true,
    };
  }

  async function uploadWithTus(buffer, relativePath, uploadOptions) {
    if (largeUploadHandler) {
      return largeUploadHandler({
        buffer,
        relativePath,
        contentType: uploadOptions.contentType,
        bucket: config.bucket,
        config,
        options: uploadOptions,
      });
    }
    return uploadWithTusSource(
      buffer.length,
      relativePath,
      uploadOptions,
      async (start, end) => buffer.subarray(start, end),
    );
  }

  async function uploadFile(fileBody, relativePath, rawOptions = {}) {
    const buffer = toBuffer(fileBody);
    const clean = requireFilePath(relativePath);
    const suppliedOptions =
      typeof rawOptions === "string" ? { contentType: rawOptions } : rawOptions;

    if (!buffer.length) {
      throw new StorageValidationError("Buffer de archivo vacío.", {
        code: "STORAGE_EMPTY_FILE",
        relativePath: clean,
      });
    }
    if (buffer.length > config.maxFileSizeBytes) {
      throw new StorageValidationError(
        `El archivo supera el máximo permitido de ${config.maxFileSizeBytes} bytes.`,
        {
          code: "STORAGE_FILE_TOO_LARGE",
          statusCode: 413,
          relativePath: clean,
          details: { size: buffer.length, maxFileSize: config.maxFileSizeBytes },
        },
      );
    }

    const contentType = validateContentType(
      suppliedOptions.contentType || inferContentType(clean, buffer),
    );
    const uploadOptions = {
      ...suppliedOptions,
      contentType,
      upsert: suppliedOptions.upsert !== false,
      cacheControl: normalizeCacheControl(suppliedOptions.cacheControl),
    };

    let data;
    if (buffer.length > config.tusThresholdBytes) {
      data = await uploadWithTus(buffer, clean, uploadOptions);
    } else {
      let response;
      try {
        response = await bucket.upload(clean, buffer, {
          contentType,
          upsert: uploadOptions.upsert,
          cacheControl: uploadOptions.cacheControl,
          ...(uploadOptions.metadata ? { metadata: uploadOptions.metadata } : {}),
        });
      } catch (error) {
        throw toStorageError(error, { operation: "upload", relativePath: clean });
      }
      if (response.error) {
        throw toStorageError(response.error, {
          operation: "upload",
          relativePath: clean,
        });
      }
      data = response.data || {};
    }

    return {
      storageId: data.id || null,
      relativePath: data.path || clean,
      path: data.path || clean,
      fullPath: data.fullPath || `${config.bucket}/${clean}`,
      contentType,
      size: buffer.length,
      bucket: config.bucket,
      resumable: Boolean(data.resumable),
    };
  }

  /**
   * Sube un archivo local sin cargarlo completo en memoria. Está pensado para
   * los temporales controlados por Multer; los objetos grandes se leen en
   * fragmentos TUS de 6 MiB.
   */
  async function uploadFileFromPath(localFilePath, relativePath, rawOptions = {}) {
    const clean = requireFilePath(relativePath);
    const suppliedOptions =
      typeof rawOptions === "string" ? { contentType: rawOptions } : rawOptions;
    let stats;
    try {
      stats = await fs.stat(localFilePath);
    } catch (error) {
      throw new StorageValidationError("No se pudo leer el archivo temporal.", {
        code: "STORAGE_INVALID_LOCAL_FILE",
        relativePath: clean,
        cause: error,
      });
    }
    if (!stats.isFile() || stats.size <= 0) {
      throw new StorageValidationError("El archivo temporal está vacío o no es regular.", {
        code: "STORAGE_INVALID_LOCAL_FILE",
        relativePath: clean,
      });
    }
    if (stats.size > config.maxFileSizeBytes) {
      throw new StorageValidationError(
        `El archivo supera el máximo permitido de ${config.maxFileSizeBytes} bytes.`,
        {
          code: "STORAGE_FILE_TOO_LARGE",
          statusCode: 413,
          relativePath: clean,
          details: { size: stats.size, maxFileSize: config.maxFileSizeBytes },
        },
      );
    }

    if (stats.size <= config.tusThresholdBytes) {
      const buffer = await fs.readFile(localFilePath);
      return uploadFile(buffer, clean, suppliedOptions);
    }

    const handle = await fs.open(localFilePath, "r");
    try {
      const sample = Buffer.alloc(Math.min(stats.size, 32));
      await handle.read(sample, 0, sample.length, 0);
      const contentType = validateContentType(
        suppliedOptions.contentType || inferContentType(clean, sample),
      );
      const uploadOptions = {
        ...suppliedOptions,
        contentType,
        upsert: suppliedOptions.upsert !== false,
        cacheControl: normalizeCacheControl(suppliedOptions.cacheControl),
      };
      const data = await uploadWithTusSource(
        stats.size,
        clean,
        uploadOptions,
        async (start, end) => {
          const chunk = Buffer.allocUnsafe(end - start);
          let totalRead = 0;
          while (totalRead < chunk.length) {
            const { bytesRead } = await handle.read(
              chunk,
              totalRead,
              chunk.length - totalRead,
              start + totalRead,
            );
            if (bytesRead === 0) break;
            totalRead += bytesRead;
          }
          return totalRead === chunk.length ? chunk : chunk.subarray(0, totalRead);
        },
      );
      return {
        storageId: data.id || null,
        relativePath: data.path || clean,
        path: data.path || clean,
        fullPath: data.fullPath || `${config.bucket}/${clean}`,
        contentType,
        size: stats.size,
        bucket: config.bucket,
        resumable: Boolean(data.resumable),
      };
    } finally {
      await handle.close();
    }
  }

  async function downloadFile(relativePath, options = {}) {
    const clean = requireFilePath(relativePath);
    let response;
    try {
      response = await bucket.download(
        clean,
        options.transform ? { transform: options.transform } : {},
        options.signal ? { signal: options.signal } : undefined,
      );
    } catch (error) {
      throw toStorageError(error, { operation: "download", relativePath: clean });
    }
    if (response.error) {
      throw toStorageError(response.error, {
        operation: "download",
        relativePath: clean,
      });
    }

    const payload = response.data;
    let buffer;
    if (Buffer.isBuffer(payload)) buffer = payload;
    else if (payload instanceof ArrayBuffer) buffer = Buffer.from(payload);
    else if (ArrayBuffer.isView(payload)) {
      buffer = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
    } else if (payload && typeof payload.arrayBuffer === "function") {
      buffer = Buffer.from(await payload.arrayBuffer());
    } else {
      throw new StorageServiceError("Supabase devolvió un archivo ilegible.", {
        code: "STORAGE_INVALID_DOWNLOAD",
        statusCode: 502,
        operation: "download",
        relativePath: clean,
      });
    }

    const responseType = String(payload?.type || "").trim();
    const contentType =
      responseType && responseType !== "application/octet-stream"
        ? responseType
        : inferContentType(clean, buffer);

    return {
      buffer,
      contentType,
      relativePath: clean,
      size: buffer.length,
    };
  }

  async function statFile(relativePath) {
    const clean = requireFilePath(relativePath);
    let response;
    try {
      response = await bucket.info(clean);
    } catch (error) {
      throw toStorageError(error, { operation: "stat", relativePath: clean });
    }
    if (response.error) {
      throw toStorageError(response.error, {
        operation: "stat",
        relativePath: clean,
      });
    }

    const data = response.data || {};
    const metadata = data.metadata || {};
    const lastModified = toDate(
      data.lastModified || data.updatedAt || metadata.lastModified,
    );
    return {
      name: clean.split("/").pop(),
      relativePath: clean,
      size: Number(data.size ?? metadata.size) || 0,
      contentType:
        data.contentType || metadata.mimetype || inferContentType(clean),
      created_at: toDate(data.createdAt),
      lastModified,
      etag: data.etag || metadata.eTag || metadata.etag || null,
      storageId: data.id || null,
      cacheControl: data.cacheControl || null,
      version: data.version || null,
      metadata,
    };
  }

  async function downloadStream(relativePath, options = {}) {
    const clean = requireFilePath(relativePath);
    if (typeof fetchImpl !== "function") {
      throw new StorageServiceError("El runtime no ofrece fetch para streaming.", {
        code: "STORAGE_STREAM_UNAVAILABLE",
        statusCode: 500,
      });
    }

    const range = normalizeRange(options.range);
    let response;
    try {
      response = await fetchImpl(buildObjectUrl(config, clean), {
        method: "GET",
        headers: {
          ...buildAuthHeaders(config.key),
          ...(range ? { Range: range } : {}),
        },
        signal: options.signal,
      });
    } catch (error) {
      throw toStorageError(error, { operation: "stream", relativePath: clean });
    }
    if (!response.ok) {
      throw await errorFromResponse(response, {
        operation: "stream",
        relativePath: clean,
      });
    }
    if (!response.body) {
      throw new StorageServiceError("Supabase devolvió una respuesta sin stream.", {
        code: "STORAGE_INVALID_STREAM",
        statusCode: 502,
        operation: "stream",
        relativePath: clean,
      });
    }

    const stream =
      typeof response.body.pipe === "function"
        ? response.body
        : Readable.fromWeb(response.body);

    return {
      stream,
      statusCode: response.status,
      relativePath: clean,
      contentType:
        response.headers.get("content-type") || inferContentType(clean),
      contentLength: parseHeaderInteger(response.headers.get("content-length")),
      contentRange: response.headers.get("content-range") || null,
      acceptRanges: response.headers.get("accept-ranges") || "bytes",
      etag: response.headers.get("etag") || null,
      lastModified: response.headers.get("last-modified") || null,
    };
  }

  async function deleteFile(relativePathOrUrl) {
    if (!relativePathOrUrl) return false;
    const clean = requireFilePath(relativePathOrUrl);
    let response;
    try {
      response = await bucket.remove([clean]);
    } catch (error) {
      const wrapped = toStorageError(error, {
        operation: "delete",
        relativePath: clean,
      });
      if (wrapped instanceof StorageNotFoundError) return false;
      throw wrapped;
    }
    if (response.error) {
      const wrapped = toStorageError(response.error, {
        operation: "delete",
        relativePath: clean,
      });
      if (wrapped instanceof StorageNotFoundError) return false;
      throw wrapped;
    }
    return Array.isArray(response.data) ? response.data.length > 0 : true;
  }

  /**
   * Mueve (renombra) un objeto dentro del bucket. Supabase no sobrescribe: si
   * el destino ya existe falla, y el origen queda intacto.
   */
  async function moveFile(fromRelative, toRelative) {
    const from = requireFilePath(fromRelative);
    const to = requireFilePath(toRelative);
    let response;
    try {
      response = await bucket.move(from, to);
    } catch (error) {
      throw toStorageError(error, { operation: "move", relativePath: from });
    }
    if (response.error) {
      throw toStorageError(response.error, { operation: "move", relativePath: from });
    }
    return { relativePath: to };
  }

  async function listFilesInFolder(folderRelative, { limit } = {}) {
    const normalizedLimit = normalizeOptionalLimit(limit);
    const folder = normalizeRelativePath(folderRelative);
    const children = await listChildren(folder, { fileLimit: normalizedLimit });
    const files = children
      .filter((item) => !isFolderEntry(item))
      .map((item) => mapListFile(item, folder))
      .sort((left, right) => {
        const leftTime = left.created_at?.getTime() || 0;
        const rightTime = right.created_at?.getTime() || 0;
        return rightTime - leftTime;
      });
    return normalizedLimit ? files.slice(0, normalizedLimit) : files;
  }

  async function listFilesRecursive(folderRelative = "", { limit } = {}) {
    const normalizedLimit = normalizeOptionalLimit(limit);
    const root = normalizeRelativePath(folderRelative);
    const pending = [root];
    const files = [];

    while (pending.length && (!normalizedLimit || files.length < normalizedLimit)) {
      const folder = pending.shift();
      const children = await listChildren(folder);
      for (const item of children) {
        const itemPath = folder ? `${folder}/${item.name}` : item.name;
        if (isFolderEntry(item)) pending.push(itemPath);
        else files.push(mapListFile(item, folder));
        if (normalizedLimit && files.length >= normalizedLimit) break;
      }
    }

    return files;
  }

  async function deleteFolder(folderRelative) {
    const folder = normalizeRelativePath(folderRelative);
    if (!folder) {
      throw new StorageValidationError(
        "Se rechaza eliminar la raíz completa del bucket.",
        { code: "STORAGE_DELETE_ROOT_FORBIDDEN" },
      );
    }
    const files = await listFilesRecursive(folder);
    if (!files.length) return false;

    const allPaths = files.map((file) => file.relativePath);
    const deletedPaths = [];
    for (let index = 0; index < allPaths.length; index += config.deleteBatchSize) {
      const batch = allPaths.slice(index, index + config.deleteBatchSize);
      let response;
      try {
        response = await bucket.remove(batch);
      } catch (error) {
        const wrapped = toStorageError(error, {
          operation: "delete-folder",
          relativePath: folder,
        });
        throw new StoragePartialFailureError(
          `No se pudo completar la eliminación de ${folder}.`,
          {
            cause: wrapped,
            statusCode: wrapped.statusCode,
            operation: "delete-folder",
            relativePath: folder,
            deletedPaths,
            pendingPaths: allPaths.slice(index),
          },
        );
      }
      if (response.error) {
        const wrapped = toStorageError(response.error, {
          operation: "delete-folder",
          relativePath: folder,
        });
        throw new StoragePartialFailureError(
          `No se pudo completar la eliminación de ${folder}.`,
          {
            cause: wrapped,
            statusCode: wrapped.statusCode,
            operation: "delete-folder",
            relativePath: folder,
            deletedPaths,
            pendingPaths: allPaths.slice(index),
          },
        );
      }
      deletedPaths.push(...batch);
    }
    return true;
  }

  // Supabase Storage no genera miniaturas de documentos. Mantener esta función
  // evita una rotura durante el refactor; los consumidores deben usar previews
  // persistidos o el rasterizador local.
  async function downloadThumbnail() {
    return null;
  }

  return Object.freeze({
    normalizeRelativePath,
    uploadFile,
    uploadFileFromPath,
    downloadFile,
    downloadStream,
    statFile,
    deleteFile,
    moveFile,
    deleteFolder,
    listFilesInFolder,
    listFilesRecursive,
    downloadThumbnail,
    bucketName: config.bucket,
  });
}

let defaultService;

function getDefaultService() {
  if (!defaultService) defaultService = createSupabaseStorageService();
  return defaultService;
}

function delegate(method) {
  return (...args) => getDefaultService()[method](...args);
}

module.exports = {
  normalizeRelativePath,
  inferContentType,
  createSupabaseStorageService,
  uploadFile: delegate("uploadFile"),
  uploadFileFromPath: delegate("uploadFileFromPath"),
  downloadFile: delegate("downloadFile"),
  downloadStream: delegate("downloadStream"),
  statFile: delegate("statFile"),
  deleteFile: delegate("deleteFile"),
  moveFile: delegate("moveFile"),
  deleteFolder: delegate("deleteFolder"),
  listFilesInFolder: delegate("listFilesInFolder"),
  listFilesRecursive: delegate("listFilesRecursive"),
  downloadThumbnail: delegate("downloadThumbnail"),
  StorageServiceError,
  StorageNotFoundError,
  StorageConflictError,
  StorageValidationError,
  StoragePathError,
  StoragePartialFailureError,
  toStorageError,
};
