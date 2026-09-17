const path = require("node:path");
const {
  detectMimeFromMagicBytes,
  MIME_BY_EXTENSION,
} = require("../storage/storagePath");

/** Carpeta de documentos legacy cuyo slug no correspondía a ningún área. */
const SLUG_SIN_AREA = "sin-area";
const GENERAL_AREA = "general";

const SECCION_POR_KIND = Object.freeze({
  procedimiento: "procedimientos",
  protocolo: "protocolos",
});

function isCloudinaryUrl(url) {
  return /(^https?:\/\/)?([^/]*\.)?cloudinary\.com\b/i.test(String(url || "").trim());
}

function isStoredContentUrl(url) {
  return String(url || "").trim().startsWith("/content/");
}

function seccionForDocumentRow(row = {}) {
  if (row.doc_kind && SECCION_POR_KIND[row.doc_kind]) {
    return SECCION_POR_KIND[row.doc_kind];
  }
  const type = String(row.type || "").trim().toLowerCase();
  if (type === "reglamento" || type.startsWith("reglamento")) return "reglamento";
  if (type.startsWith("protocolo")) return "protocolos";
  if (type.startsWith("procedimiento")) return "procedimientos";
  return "otros";
}

function areaSegmentForDocument(seccion, workAreaId) {
  if (seccion === "reglamento" || seccion === "otros") return GENERAL_AREA;
  if (workAreaId == null || workAreaId === "") return SLUG_SIN_AREA;
  return String(workAreaId);
}

/**
 * Misma carpeta que usa POST /procesos/:seccion/:area/upload.
 * `area` es el id de work_areas, `general` o `sin-area`.
 */
function folderForUpload(seccion, area) {
  const section = String(seccion || "").trim();
  const folderArea = String(area || "").trim() || GENERAL_AREA;
  if (!section) throw new Error("Falta la sección del documento.");
  return `documentos/${section}/${folderArea}`;
}

function folderForRow(table, row = {}) {
  if (table === "other_documents") {
    return folderForUpload("otros", GENERAL_AREA);
  }
  const seccion = seccionForDocumentRow(row);
  return folderForUpload(seccion, areaSegmentForDocument(seccion, row.work_area_id));
}

function extensionFromContentType(contentType) {
  const mime = String(contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (!mime || mime === "application/octet-stream") return "";
  for (const [ext, mapped] of Object.entries(MIME_BY_EXTENSION)) {
    if (mapped.split(";", 1)[0].trim().toLowerCase() === mime) return ext;
  }
  return "";
}

function extensionFromBuffer(buffer) {
  const fromMagic = extensionFromContentType(detectMimeFromMagicBytes(buffer));
  if (fromMagic) return fromMagic;
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) return "";
  if (buffer[0] === 0xd0 && buffer[1] === 0xcf && buffer[2] === 0x11 && buffer[3] === 0xe0) {
    return ".doc";
  }
  if (buffer.subarray(0, 2).toString("latin1") !== "PK") return "";
  const inside = buffer.toString("latin1");
  if (inside.includes("word/")) return ".docx";
  if (inside.includes("xl/")) return ".xlsx";
  if (inside.includes("ppt/")) return ".pptx";
  return ".zip";
}

function pathnameOf(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  try {
    if (/^https?:\/\//i.test(raw)) {
      return decodeURIComponent(new URL(raw).pathname);
    }
  } catch {
    return raw.split(/[?#]/, 1)[0];
  }
  return raw.split(/[?#]/, 1)[0];
}

/**
 * Conserva el id de Cloudinary (corto y único) y le pone extensión real.
 * Así `documents.public_id` (varchar 100) no se pasa y re-ejecutar es idempotente.
 */
function fileNameForLegacyObject({ url, publicId, contentType, buffer } = {}) {
  let base = "";
  let ext = "";
  for (const candidate of [url, publicId]) {
    const name = path.posix.basename(pathnameOf(candidate));
    if (!name) continue;
    if (!base) base = name;
    const found = path.extname(name).toLowerCase();
    if (found) {
      base = name;
      ext = found;
      break;
    }
  }

  const fromBytes = extensionFromBuffer(buffer);
  if (fromBytes) ext = fromBytes;
  else if (!ext) ext = extensionFromContentType(contentType);

  const stemSource = ext && base.toLowerCase().endsWith(ext) ? base.slice(0, -ext.length) : base;
  const stem =
    String(stemSource || "archivo")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9._-]+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "archivo";

  return `${stem}${ext || ""}`;
}

function destinationPath(table, row, fileName) {
  return `${folderForRow(table, row)}/${fileName}`;
}

module.exports = {
  SLUG_SIN_AREA,
  GENERAL_AREA,
  isCloudinaryUrl,
  isStoredContentUrl,
  seccionForDocumentRow,
  areaSegmentForDocument,
  folderForUpload,
  folderForRow,
  fileNameForLegacyObject,
  destinationPath,
  extensionFromContentType,
};
