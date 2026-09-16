const crypto = require("crypto");
const { ticketCategoryLabel } = require("../../constants/ticketCategories");
const {
  ATTACHMENT_KINDS,
  ticketPriorityLabel,
  validateTicketInput,
} = require("../tickets/ticketRules");

/**
 * Borrador de ticket del asistente, guardado en la sesión de quien lo armó.
 *
 * Lo arma el modelo con draft_support_ticket; en Soporte no se crea nada hasta
 * que el usuario pulsa «Crear ticket» en la tarjeta. Los archivos adjuntos no
 * pasan por aquí: quedan en el navegador y se suben recién al confirmar.
 */

const DRAFT_KEY = "assistantTicketDraft";
const SESSION_ID_KEY = "assistantSessionId";
const MAX_CHAT_ATTACHMENTS = 5;

function saveTicketDraft(session, input) {
  const validation = validateTicketInput(input);
  if (!validation.ok) return validation;
  const draft = { id: crypto.randomUUID(), ...validation.ticket };
  session[DRAFT_KEY] = draft;
  return { ok: true, draft };
}

function getTicketDraft(session, id) {
  const draft = session && session[DRAFT_KEY];
  return draft && draft.id === id ? draft : null;
}

function clearTicketDraft(session) {
  if (session) delete session[DRAFT_KEY];
}

/**
 * Identificador de la sesión para el navegador. Los adjuntos guardados allí
 * con otro identificador son de una sesión anterior y se descartan.
 */
function assistantSessionId(session) {
  if (!session[SESSION_ID_KEY]) session[SESSION_ID_KEY] = crypto.randomUUID();
  return session[SESSION_ID_KEY];
}

/** Adjuntos que declara el cliente en un turno: sólo nombre y tipo, acotados. */
function sanitizeChatAttachments(list) {
  if (!Array.isArray(list)) return [];
  return list
    .filter((item) => item && typeof item.nombre === "string" && item.nombre.trim())
    .slice(0, MAX_CHAT_ATTACHMENTS)
    .map((item) => ({
      nombre: item.nombre.trim().slice(0, 120),
      tipo: ATTACHMENT_KINDS.includes(item.tipo) ? item.tipo : "doc",
    }));
}

/** Datos de la tarjeta del borrador. */
function publicDraft(draft) {
  return {
    id: draft.id,
    title: draft.title,
    description: draft.description,
    category: draft.category,
    categoryLabel: ticketCategoryLabel(draft.category),
    priority: draft.priority,
    priorityLabel: ticketPriorityLabel(draft.priority),
  };
}

module.exports = {
  MAX_CHAT_ATTACHMENTS,
  saveTicketDraft,
  getTicketDraft,
  clearTicketDraft,
  assistantSessionId,
  sanitizeChatAttachments,
  publicDraft,
};
