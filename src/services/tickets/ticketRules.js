const path = require("path");
const {
  DEFAULT_TICKET_CATEGORY,
  normalizeTicketCategory,
} = require("../../constants/ticketCategories");
const { ticketPriorityToDb, ticketPriorityFromDb } = require("../../utils/schemaMappers");

/**
 * Reglas de un ticket de Soporte, sin base de datos ni correo: las comparten
 * el formulario, el asistente y los tests.
 */

const TICKET_PRIORITIES = Object.freeze(["low", "medium", "high"]);
const DEFAULT_TICKET_PRIORITY = "medium";
const MAX_TITLE_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 2000;
const MAX_ATTACHMENTS = 10;
const ATTACHMENT_KINDS = Object.freeze(["image", "video", "pdf", "doc"]);
const DOCUMENT_EXTENSIONS = Object.freeze([".pdf", ".doc", ".docx"]);

/** Prioridad guardable ("low" | "medium" | "high"); acepta también "Baja", "Media", "Alta". */
function normalizeTicketPriority(value) {
  const priority = ticketPriorityToDb(String(value ?? "").trim());
  return TICKET_PRIORITIES.includes(priority) ? priority : DEFAULT_TICKET_PRIORITY;
}

function ticketPriorityLabel(value) {
  return ticketPriorityFromDb(normalizeTicketPriority(value));
}

/** Tipo con el que se guarda un adjunto: mismo criterio que el formulario. */
function attachmentKind(mimeType = "", filename = "") {
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType === "application/pdf" || /\.pdf$/i.test(filename)) return "pdf";
  return "doc";
}

/** Imágenes, videos, PDF y Word: lo que acepta el formulario de ticket. */
function isAllowedAttachment(mimeType = "", filename = "") {
  if (mimeType.startsWith("image/") || mimeType.startsWith("video/")) return true;
  return DOCUMENT_EXTENSIONS.includes(path.extname(String(filename)).toLowerCase());
}

function withAttachmentExtension(baseName, originalName = "") {
  const ext = path.extname(String(originalName)).toLowerCase();
  return `${baseName}${/^\.[a-z0-9]{1,8}$/.test(ext) ? ext : ""}`;
}

/**
 * Nombre del adjunto en el bucket: <N° de ticket>_<n>.<ext>. El nombre
 * original se conserva aparte, para mostrarlo.
 */
function attachmentFileName(ticketId, index, originalName = "") {
  return withAttachmentExtension(`${ticketId}_${index}`, originalName);
}

/**
 * Adjunto de una respuesta: <N° de ticket>_<id de respuesta>_<n>.<ext>.
 * El id de la respuesta es el correlativo del hilo (1, 2, 3…), no un identity
 * global de ticket_replies.
 */
function replyAttachmentFileName(ticketId, replyOrdinal, fileIndex, originalName = "") {
  return withAttachmentExtension(
    `${ticketId}_${replyOrdinal}_${fileIndex}`,
    originalName,
  );
}

/**
 * Valida los archivos recibidos (multer) antes de crear el ticket: si uno no
 * sirve, no se crea nada.
 * @returns {{ ok: true } | { ok: false, error: string }}
 */
function validateAttachmentFiles(files, { maxBytes, maxFiles = MAX_ATTACHMENTS } = {}) {
  if (!Array.isArray(files) || !files.length) return { ok: true };
  if (files.length > maxFiles) {
    return { ok: false, error: `Puedes adjuntar hasta ${maxFiles} archivos.` };
  }
  for (const file of files) {
    if (!isAllowedAttachment(file.mimetype, file.originalname)) {
      return { ok: false, error: `«${file.originalname}» no es un tipo permitido. Usa imágenes, videos, PDF o Word.` };
    }
    if (maxBytes && file.size > maxBytes) {
      return { ok: false, error: `«${file.originalname}» supera el tamaño máximo permitido.` };
    }
  }
  return { ok: true };
}

/**
 * Valida y normaliza los datos de un ticket nuevo.
 * @returns {{ ok: true, ticket } | { ok: false, error: string }}
 */
function validateTicketInput({ title, description, category, priority } = {}) {
  const cleanTitle = String(title ?? "").trim();
  const cleanDescription = String(description ?? "").trim();

  if (!cleanTitle) return { ok: false, error: "El ticket necesita un resumen del problema." };
  if (cleanTitle.length > MAX_TITLE_CHARS) {
    return { ok: false, error: `El resumen no puede superar ${MAX_TITLE_CHARS} caracteres.` };
  }
  if (!cleanDescription) return { ok: false, error: "El ticket necesita una descripción del problema." };
  if (cleanDescription.length > MAX_DESCRIPTION_CHARS) {
    return { ok: false, error: `La descripción no puede superar ${MAX_DESCRIPTION_CHARS} caracteres.` };
  }

  return {
    ok: true,
    ticket: {
      title: cleanTitle,
      description: cleanDescription,
      category: normalizeTicketCategory(category) || DEFAULT_TICKET_CATEGORY,
      priority: normalizeTicketPriority(priority),
    },
  };
}

module.exports = {
  TICKET_PRIORITIES,
  DEFAULT_TICKET_PRIORITY,
  MAX_TITLE_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_ATTACHMENTS,
  ATTACHMENT_KINDS,
  normalizeTicketPriority,
  ticketPriorityLabel,
  attachmentKind,
  isAllowedAttachment,
  attachmentFileName,
  replyAttachmentFileName,
  validateAttachmentFiles,
  validateTicketInput,
};
