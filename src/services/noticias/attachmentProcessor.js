// Orquesta la subida de un adjunto: valida, guarda el original y genera las
// derivadas que permiten mostrar el archivo embebido en vez de ofrecer una
// descarga (portada del PDF, HTML del Word, dimensiones de la imagen).
//
// Los archivos se suben recién al guardar la noticia, con el nombre
// <N° de noticia>_1, _2… (igual que tickets). Ninguna derivada es
// obligatoria: si falla, se registra y el adjunto se guarda igual.

const path = require("node:path");
const fs = require("node:fs/promises");
const fileStorage = require("../fileStorage");
const { UPLOAD_LIMITS_BYTES } = require("../../config/uploadLimits");
const attachmentModel = require("./attachmentModel");
const attachmentNames = require("./attachmentNames");
const documentCache = require("./documentCache");
const pdfRenderer = require("./pdfRenderer");
const wordRenderer = require("./wordRenderer");

const { KIND } = attachmentModel;
const {
  UPLOAD_FOLDER,
  PREVIEW_FOLDER,
  RENDER_FOLDER,
  WORD_MEDIA_FOLDER,
  MAX_ATTACHMENTS,
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
} = attachmentNames;

// Límites por tipo (MB). El editor valida en el cliente; esto es la garantía real.
const MAX_SIZE_MB = {
  [KIND.IMAGE]: 20,
  [KIND.PDF]: 40,
  [KIND.WORD]: 25,
  [KIND.VIDEO]: 200,
  [KIND.FILE]: 25,
};

const ACCEPTED_KINDS = new Set([KIND.IMAGE, KIND.PDF, KIND.WORD, KIND.VIDEO]);

class AttachmentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

function requireNewsTarget(noticiaId, index) {
  const id = Number(noticiaId);
  const n = Number(index);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AttachmentError("Falta el número de la noticia para nombrar el adjunto.");
  }
  if (!Number.isSafeInteger(n) || n <= 0) {
    throw new AttachmentError("Falta el correlativo del archivo en la noticia.");
  }
  return { id, index: n };
}

function isLocalNewsPath(ref) {
  if (!ref || isRemoteMediaUrl(ref)) return false;
  const relative = fileStorage.resolveStoredPath(ref);
  return Boolean(relative && relative.startsWith(`${UPLOAD_FOLDER}/`));
}

/**
 * Dimensiones de una imagen, para reservar el espacio en el layout y evitar
 * saltos de contenido (CLS) al cargar.
 */
async function readImageSize(buffer) {
  try {
    const { loadImage } = require("@napi-rs/canvas");
    const image = await loadImage(buffer);
    return { width: image.width, height: image.height };
  } catch (err) {
    console.warn("[Noticias] No se pudieron leer las dimensiones de la imagen:", err.message || err);
    return { width: null, height: null };
  }
}

async function processPdf(buffer, baseName, item) {
  const { pages, excerpt, preview, previews } = await pdfRenderer.analyze(buffer);
  item.pages = pages;
  item.excerpt = excerpt;

  const pagesToSave = previews?.length ? previews : preview ? [preview] : [];
  if (!pagesToSave.length) return;

  const savedPages = [];
  for (let i = 0; i < pagesToSave.length; i += 1) {
    const pagePreview = pagesToSave[i];
    try {
      const fileName = previewFileName(baseName, i + 1, pagesToSave.length, pagePreview.mime);
      const saved = await fileStorage.saveFileAs(
        pagePreview.buffer,
        PREVIEW_FOLDER,
        fileName,
        { contentType: pagePreview.mime || "image/jpeg" },
      );
      savedPages.push({
        path: saved.public_id,
        width: pagePreview.width,
        height: pagePreview.height,
        page: i + 1,
      });
    } catch (err) {
      console.warn(
        `[Noticias] No se pudo guardar la página ${i + 1} del PDF:`,
        err.message || err,
      );
    }
  }

  if (!savedPages.length) return;

  // La primera página sigue siendo la portada del visor (carga inmediata).
  item.preview_path = savedPages[0].path;
  item.preview_width = savedPages[0].width;
  item.preview_height = savedPages[0].height;
  // Todas las páginas: el correo las incrusta una tras otra.
  item.preview_pages = savedPages;
}

async function processWord(buffer, baseName, item) {
  const { html, excerpt } = await wordRenderer.render(buffer, {
    name: item.name,
    folder: WORD_MEDIA_FOLDER,
    imageFileName: (n, extension) => wordImageFileName(baseName, n, extension),
  });

  item.excerpt = excerpt;
  if (!html) return;

  try {
    const saved = await fileStorage.saveFileAs(
      Buffer.from(html, "utf8"),
      RENDER_FOLDER,
      renderFileName(baseName),
      { contentType: "text/html; charset=utf-8" },
    );
    item.html_path = saved.public_id;
    // Se precalienta la caché: la primera visita no espera una lectura remota.
    documentCache.set(saved.public_id, html);
  } catch (err) {
    console.warn("[Noticias] No se pudo guardar el HTML del Word:", err.message || err);
  }
}

async function saveOriginal(bufferOrPath, file, fileName, fromPath = false) {
  const options = { contentType: file.mimetype };
  if (fromPath) {
    return fileStorage.saveFileAsFromPath(bufferOrPath, UPLOAD_FOLDER, fileName, options);
  }
  return fileStorage.saveFileAs(bufferOrPath, UPLOAD_FOLDER, fileName, options);
}

/**
 * Procesa un archivo subido y devuelve el adjunto v2 listo para persistir.
 * El nombre en el bucket es <N° de noticia>_<n>.<ext>.
 */
async function processUpload(buffer, file, { noticiaId, index } = {}) {
  const { id, index: n } = requireNewsTarget(noticiaId, index);
  const name = file.originalname || "archivo";
  const kind = attachmentModel.kindFor(name, { mime: file.mimetype });

  if (!ACCEPTED_KINDS.has(kind)) {
    throw new AttachmentError(
      `Tipo de archivo no permitido: ${name}. Se aceptan imágenes, PDF, Word y video.`,
    );
  }

  const maxMb = MAX_SIZE_MB[kind];
  if (!fileStorage.validateFileSize(buffer, maxMb)) {
    throw new AttachmentError(`"${name}" supera el máximo de ${maxMb} MB para este tipo.`, 413);
  }

  const fileName = attachmentFileName(id, n, name);
  const saved = await saveOriginal(buffer, file, fileName);
  const baseName = stemOf(saved.fileName);

  const item = {
    v: 2,
    id: attachmentModel.generateId(),
    kind,
    name,
    url: saved.secure_url,
    public_id: saved.public_id,
    mime: saved.contentType || attachmentModel.mimeFor(name),
    size: buffer.length,
    alt: "",
    caption: "",
  };

  try {
    if (kind === KIND.IMAGE) {
      Object.assign(item, await readImageSize(buffer));
    } else if (kind === KIND.PDF) {
      await processPdf(buffer, baseName, item);
    } else if (kind === KIND.WORD) {
      await processWord(buffer, baseName, item);
    }
  } catch (err) {
    console.error(`[Noticias] Fallo procesando "${name}":`, err.message || err);
  }

  return attachmentModel.normalizeOne(item);
}

/**
 * Variante para Multer diskStorage. Los videos se envían desde disco por TUS
 * sin ocupar cientos de MiB en el heap; los demás tipos se leen como Buffer
 * porque sus renderizadores necesitan acceso aleatorio al contenido.
 */
async function processUploadedFile(file, { noticiaId, index } = {}) {
  if (!file?.path) {
    throw new AttachmentError("No se recibió un archivo temporal válido.");
  }
  const { id, index: n } = requireNewsTarget(noticiaId, index);
  const name = file.originalname || "archivo";
  const kind = attachmentModel.kindFor(name, { mime: file.mimetype });
  if (!ACCEPTED_KINDS.has(kind)) {
    throw new AttachmentError(
      `Tipo de archivo no permitido: ${name}. Se aceptan imágenes, PDF, Word y video.`,
    );
  }
  const maxMb = MAX_SIZE_MB[kind];
  if (!Number.isFinite(file.size) || file.size > maxMb * 1024 * 1024) {
    throw new AttachmentError(`"${name}" supera el máximo de ${maxMb} MB para este tipo.`, 413);
  }

  if (kind !== KIND.VIDEO) {
    const buffer = await fs.readFile(file.path);
    return processUpload(buffer, file, { noticiaId: id, index: n });
  }

  const fileName = attachmentFileName(id, n, name);
  const saved = await saveOriginal(file.path, file, fileName, true);
  return attachmentModel.normalizeOne({
    v: 2,
    id: attachmentModel.generateId(),
    kind,
    name,
    url: saved.secure_url,
    public_id: saved.public_id,
    mime: saved.contentType,
    size: file.size,
    alt: "",
    caption: "",
  });
}

function fileNameFromRemoteUrl(url, fallbackName) {
  try {
    const base = path.posix.basename(new URL(url).pathname);
    if (base && base !== "/" && /\.[a-z0-9]{1,8}$/i.test(base)) return base;
  } catch {
    // URL ilegible: usamos el nombre que ya tenía el adjunto.
  }
  return fallbackName || "archivo.jpg";
}

/**
 * Baja un archivo remoto para copiarlo al bucket de la instancia.
 */
async function downloadRemoteNewsFile(url, fallbackName = "archivo.jpg") {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "intranet-web-news-migration" },
  });
  if (!response.ok) {
    throw new AttachmentError(
      `No se pudo descargar el archivo remoto (${response.status}).`,
      502,
    );
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) {
    throw new AttachmentError("El archivo remoto está vacío.", 502);
  }
  if (buffer.length > UPLOAD_LIMITS_BYTES.NEWS_ATTACHMENT) {
    throw new AttachmentError("El archivo remoto supera el máximo permitido.", 413);
  }
  const contentType =
    String(response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim() || "application/octet-stream";
  return {
    buffer,
    contentType,
    originalName: fileNameFromRemoteUrl(url, fallbackName),
  };
}

async function importRemoteAttachment(item, noticiaId, index) {
  const downloaded = await downloadRemoteNewsFile(item.url, item.name);
  const imported = await processUpload(
    downloaded.buffer,
    {
      originalname: item.name || downloaded.originalName,
      mimetype: downloaded.contentType,
      size: downloaded.buffer.length,
    },
    { noticiaId, index },
  );
  return attachmentModel.normalizeOne({
    ...imported,
    id: item.id || imported.id,
    name: item.name || imported.name,
    alt: item.alt || "",
    caption: item.caption || "",
    order: item.order,
  });
}

async function importRemoteCover(noticiaId, imageUrl) {
  const downloaded = await downloadRemoteNewsFile(imageUrl, "portada.jpg");
  return saveCoverFile(
    {
      buffer: downloaded.buffer,
      originalname: downloaded.originalName,
      mimetype: downloaded.contentType,
    },
    noticiaId,
  );
}

async function saveCoverFile(file, noticiaId) {
  if (!file) return null;
  const id = Number(noticiaId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AttachmentError("Falta el número de la noticia para nombrar la portada.");
  }
  const originalName = file.originalname || "portada.jpg";
  const fileName = coverFileName(id, originalName);
  const options = { contentType: file.mimetype || "image/jpeg", upsert: true };
  const saved = file.path
    ? await fileStorage.saveFileAsFromPath(file.path, UPLOAD_FOLDER, fileName, options)
    : await fileStorage.saveFileAs(file.buffer, UPLOAD_FOLDER, fileName, options);
  return saved.secure_url;
}

/**
 * El plan que envía el editor: adjuntos ya guardados (public_id) intercalados
 * con huecos `{ nuevo: true }` que corresponden a `files`, en el mismo orden.
 */
function parseAttachmentPlan(rawPlan, files = []) {
  let plan = rawPlan;
  if (typeof plan === "string") {
    try {
      plan = JSON.parse(plan);
    } catch {
      plan = [];
    }
  }
  if (!Array.isArray(plan)) plan = [];

  const incoming = Array.isArray(files) ? files : [];
  let fileIndex = 0;
  const slots = [];

  for (const entry of plan) {
    if (!entry || typeof entry !== "object") continue;
    if (entry.nuevo) {
      const file = incoming[fileIndex];
      fileIndex += 1;
      if (!file) {
        throw new AttachmentError("Faltan archivos adjuntos en el envío.");
      }
      slots.push({ type: "new", file });
      continue;
    }
    const publicId = String(entry.public_id || "").trim();
    const url = String(entry.url || "").trim();
    if (!publicId && !url) continue;
    slots.push({ type: "existing", publicId, url });
  }

  if (fileIndex !== incoming.length) {
    throw new AttachmentError("Los archivos enviados no coinciden con la lista de adjuntos.");
  }
  if (slots.length > MAX_ATTACHMENTS) {
    throw new AttachmentError(`Puedes adjuntar hasta ${MAX_ATTACHMENTS} archivos.`);
  }
  return slots;
}

function lookupPrevious(previousItems, slot) {
  const byId = slot.publicId
    ? previousItems.find((item) => item.public_id === slot.publicId)
    : null;
  if (byId) return byId;
  if (slot.url) return previousItems.find((item) => item.url === slot.url) || null;
  return null;
}

function nextAttachmentIndex(noticiaId, items) {
  const max = items.reduce(
    (acc, item) => Math.max(acc, canonicalIndex(item.public_id || item.url, noticiaId) || 0),
    0,
  );
  return max + 1;
}

async function moveOwnedPath(fromRef, toPath) {
  const from = fileStorage.resolveStoredPath(fromRef);
  if (!from || from === toPath) return toPath;
  if (!from.startsWith(`${UPLOAD_FOLDER}/`)) return from;
  const moved = await fileStorage.moveFile(from, toPath);
  return moved.public_id;
}

async function retargetDerivatives(item, newBase) {
  const next = { ...item };

  if (item.html_path && isLocalNewsPath(item.html_path)) {
    const target = objectPath(RENDER_FOLDER, renderFileName(newBase));
    try {
      next.html_path = await moveOwnedPath(item.html_path, target);
    } catch (err) {
      console.warn("[Noticias] No se pudo renombrar el HTML del Word:", err.message || err);
    }
  }

  const pages = Array.isArray(item.preview_pages) ? item.preview_pages : [];
  if (pages.length) {
    const movedPages = [];
    for (const page of pages) {
      if (!page?.path || page.path === item.public_id || !isLocalNewsPath(page.path)) {
        movedPages.push(page);
        continue;
      }
      const ext = path.posix.extname(page.path) || ".jpg";
      const mime = ext === ".png" ? "image/png" : "image/jpeg";
      const fileName = previewFileName(newBase, page.page || movedPages.length + 1, pages.length, mime);
      try {
        const moved = await moveOwnedPath(page.path, objectPath(PREVIEW_FOLDER, fileName));
        movedPages.push({ ...page, path: moved });
      } catch (err) {
        console.warn("[Noticias] No se pudo renombrar una portada de PDF:", err.message || err);
        movedPages.push(page);
      }
    }
    next.preview_pages = movedPages;
    if (movedPages[0]?.path) {
      next.preview_path = movedPages[0].path;
      next.preview_width = movedPages[0].width || next.preview_width;
      next.preview_height = movedPages[0].height || next.preview_height;
    }
    return next;
  }

  if (
    item.preview_path &&
    item.preview_path !== item.public_id &&
    isLocalNewsPath(item.preview_path)
  ) {
    const ext = path.posix.extname(item.preview_path) || ".jpg";
    const mime = ext === ".png" ? "image/png" : "image/jpeg";
    const fileName = previewFileName(newBase, 1, 1, mime);
    try {
      next.preview_path = await moveOwnedPath(
        item.preview_path,
        objectPath(PREVIEW_FOLDER, fileName),
      );
    } catch (err) {
      console.warn("[Noticias] No se pudo renombrar la portada del PDF:", err.message || err);
    }
  }

  return next;
}

async function canonicalizeAttachment(item, noticiaId, index) {
  if (!item) return null;
  if (isRemoteMediaUrl(item.url)) {
    return importRemoteAttachment(item, noticiaId, index);
  }

  const currentPath = fileStorage.resolveStoredPath(item.public_id || item.url);
  if (!currentPath || !currentPath.startsWith(`${UPLOAD_FOLDER}/`)) return item;

  const targetName = attachmentFileName(noticiaId, index, item.name || currentPath);
  const targetPath = objectPath(UPLOAD_FOLDER, targetName);
  if (currentPath === targetPath) return item;

  try {
    const moved = await fileStorage.moveFile(currentPath, targetPath);
    const updated = {
      ...item,
      public_id: moved.public_id,
      url: moved.secure_url,
    };

    // En imágenes la vista previa ES el original: no hay derivada que mover.
    if (item.preview_path === currentPath) {
      updated.preview_path = moved.public_id;
    }
    if (Array.isArray(item.preview_pages)) {
      updated.preview_pages = item.preview_pages.map((page) =>
        page?.path === currentPath ? { ...page, path: moved.public_id } : page,
      );
    }

    const hasSeparatePreview =
      (item.preview_path && item.preview_path !== currentPath) ||
      (Array.isArray(item.preview_pages) &&
        item.preview_pages.some((page) => page?.path && page.path !== currentPath));
    const retargeted = hasSeparatePreview
      ? await retargetDerivatives(updated, stemOf(targetName))
      : updated;

    return attachmentModel.normalizeOne(retargeted);
  } catch (err) {
    console.warn(
      `[Noticias] No se pudo renombrar ${currentPath} → ${targetPath}:`,
      err.message || err,
    );
    return item;
  }
}

async function canonicalizeCover(noticiaId, imageUrl) {
  if (!imageUrl) return null;
  if (isRemoteMediaUrl(imageUrl)) {
    return importRemoteCover(noticiaId, imageUrl);
  }
  if (!isLocalNewsPath(imageUrl)) return imageUrl;

  const currentPath = fileStorage.resolveStoredPath(imageUrl);
  if (isCanonicalCoverName(currentPath, noticiaId)) {
    return fileStorage.getPublicUrl(currentPath);
  }

  const targetName = coverFileName(noticiaId, currentPath);
  const targetPath = objectPath(UPLOAD_FOLDER, targetName);
  if (currentPath === targetPath) return fileStorage.getPublicUrl(currentPath);

  try {
    const moved = await fileStorage.moveFile(currentPath, targetPath);
    return moved.secure_url;
  } catch (err) {
    console.warn(
      `[Noticias] No se pudo renombrar la portada ${currentPath}:`,
      err.message || err,
    );
    return imageUrl;
  }
}

async function persistCover({
  noticiaId,
  previousCover,
  coverFile,
  keepCoverUrl,
}) {
  if (coverFile) {
    const nextCover = await saveCoverFile(coverFile, noticiaId);
    if (
      previousCover &&
      previousCover !== nextCover &&
      isLocalNewsPath(previousCover)
    ) {
      const previousPath = fileStorage.resolveStoredPath(previousCover);
      const nextPath = fileStorage.resolveStoredPath(nextCover);
      if (previousPath && previousPath !== nextPath) {
        await fileStorage.deleteFile(previousCover).catch((err) => {
          console.warn("[Noticias] No se pudo borrar la portada anterior:", err.message || err);
        });
      }
    }
    return nextCover;
  }

  if (!keepCoverUrl) {
    if (previousCover && isLocalNewsPath(previousCover)) {
      await fileStorage.deleteFile(previousCover).catch((err) => {
        console.warn("[Noticias] No se pudo borrar la portada:", err.message || err);
      });
    }
    return null;
  }

  return canonicalizeCover(noticiaId, previousCover || keepCoverUrl);
}

/**
 * Sube los archivos nuevos, deja los existentes y nombra todo como
 * <N° de noticia>_n. Devuelve el JSON persistible y la portada.
 */
async function persistNewsMedia({
  noticiaId,
  previousAttachments = [],
  previousCover = null,
  planRaw,
  files = [],
  coverFile = null,
  keepCoverUrl = null,
}) {
  const id = Number(noticiaId);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new AttachmentError("Falta el número de la noticia para guardar los archivos.");
  }

  const previousItems = attachmentModel.normalize(previousAttachments);
  const slots = parseAttachmentPlan(planRaw, files);
  const kept = [];
  const usedPrevious = new Set();

  for (const slot of slots) {
    if (slot.type === "existing") {
      const current = lookupPrevious(previousItems, slot);
      if (!current) continue;
      usedPrevious.add(current.public_id);
      kept.push(current);
    }
  }

  let nextIndex = nextAttachmentIndex(id, kept);
  const nextItems = [];

  for (const slot of slots) {
    if (slot.type === "existing") {
      const current = lookupPrevious(previousItems, slot);
      if (!current) continue;
      const existingN = canonicalIndex(current.public_id || current.url, id);
      const index = existingN || nextIndex++;
      nextItems.push(await canonicalizeAttachment(current, id, index));
      continue;
    }

    const index = nextIndex++;
    nextItems.push(
      await processUploadedFile(slot.file, { noticiaId: id, index }),
    );
  }

  const image = await persistCover({
    noticiaId: id,
    previousCover,
    coverFile,
    keepCoverUrl,
  });

  const removed = previousItems.filter(
    (item) => item.public_id && !usedPrevious.has(item.public_id),
  );

  return {
    image,
    attachments: attachmentModel.serialize(nextItems.filter(Boolean)),
    items: nextItems.filter(Boolean),
    removed,
  };
}

async function canonicalizeNewsRecord({ id, image, attachments }) {
  return persistNewsMedia({
    noticiaId: id,
    previousAttachments: attachments,
    previousCover: image,
    planRaw: attachmentModel.normalize(attachments).map((item) => ({
      public_id: item.public_id,
      url: item.url,
    })),
    files: [],
    coverFile: null,
    keepCoverUrl: image,
  });
}

/**
 * Rutas de storage asociadas a un adjunto (original + derivadas).
 */
function collectAttachmentPaths(items) {
  const paths = [];

  attachmentModel.normalize(items).forEach((item) => {
    paths.push(item.public_id);
    if (item.url) paths.push(item.url);
    if (item.html_path) paths.push(item.html_path);
    // La vista previa de una imagen ES la imagen: no se borra dos veces.
    if (item.preview_path && item.preview_path !== item.public_id) {
      paths.push(item.preview_path);
    }
    if (Array.isArray(item.preview_pages)) {
      item.preview_pages.forEach((page) => {
        if (page?.path && page.path !== item.public_id && page.path !== item.preview_path) {
          paths.push(page.path);
        }
      });
    }
  });

  return paths.filter(Boolean);
}

/**
 * Adjuntos presentes en `previous` cuyo public_id ya no está en `next`.
 */
function findRemovedAttachments(previous, next) {
  const nextIds = new Set(
    attachmentModel
      .normalize(next)
      .map((item) => item.public_id)
      .filter(Boolean),
  );

  return attachmentModel
    .normalize(previous)
    .filter((item) => item.public_id && !nextIds.has(item.public_id));
}

/**
 * Extrae rutas de imágenes embebidas en el HTML renderizado de un Word.
 */
async function collectWordMediaPaths(items) {
  const paths = [];
  const wordItems = attachmentModel
    .normalize(items)
    .filter((item) => item.kind === KIND.WORD && item.html_path);

  for (const item of wordItems) {
    try {
      const html = await documentCache.getHtml(item.html_path);
      if (!html) continue;
      const matches = html.matchAll(/(?:src|href)=["']([^"']+)["']/gi);
      for (const match of matches) {
        const ref = match[1];
        const relative = fileStorage.resolveStoredPath(ref);
        if (relative && relative.startsWith(`${WORD_MEDIA_FOLDER}/`)) {
          paths.push(relative);
        }
      }
    } catch (err) {
      console.warn(
        "[Noticias] No se pudo inspeccionar HTML de Word para limpieza:",
        err.message || err,
      );
    }
  }

  return paths;
}

/**
 * Borra el original y todas sus derivadas. Se usa al eliminar una noticia
 * o adjuntos quitados en una edición, para no dejar huérfanos en Storage.
 */
async function deleteAttachmentFiles(items) {
  const normalized = attachmentModel.normalize(items);
  const paths = collectAttachmentPaths(normalized);
  const wordMedia = await collectWordMediaPaths(normalized);
  const result = await fileStorage.deleteFiles([...paths, ...wordMedia]);
  return result.deleted;
}

module.exports = {
  AttachmentError,
  UPLOAD_FOLDER,
  PREVIEW_FOLDER,
  RENDER_FOLDER,
  WORD_MEDIA_FOLDER,
  MAX_SIZE_MB,
  MAX_ATTACHMENTS,
  processUpload,
  processUploadedFile,
  parseAttachmentPlan,
  persistNewsMedia,
  persistCover,
  canonicalizeNewsRecord,
  canonicalizeCover,
  canonicalizeAttachment,
  deleteAttachmentFiles,
  findRemovedAttachments,
  collectAttachmentPaths,
  readImageSize,
};
