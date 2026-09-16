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

/** Lista de adjuntos { url, nombre, tipo } saneada. Lo que no tiene URL se descarta. */
function normalizeAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item.url === "string" && item.url.trim())
    .slice(0, MAX_ATTACHMENTS)
    .map((item) => ({
      url: item.url.trim(),
      nombre: String(item.nombre || "archivo").slice(0, 200),
      tipo: ATTACHMENT_KINDS.includes(item.tipo) ? item.tipo : "doc",
    }));
}

/**
 * Valida y normaliza los datos de un ticket nuevo.
 * @returns {{ ok: true, ticket } | { ok: false, error: string }}
 */
function validateTicketInput({ title, description, category, priority, attachments } = {}) {
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
      attachments: normalizeAttachments(attachments),
    },
  };
}

module.exports = {
  TICKET_PRIORITIES,
  DEFAULT_TICKET_PRIORITY,
  MAX_TITLE_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_ATTACHMENTS,
  normalizeTicketPriority,
  ticketPriorityLabel,
  attachmentKind,
  isAllowedAttachment,
  normalizeAttachments,
  validateTicketInput,
};
