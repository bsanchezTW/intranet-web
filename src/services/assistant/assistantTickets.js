const crypto = require("crypto");
const { ticketCategoryLabel } = require("../../constants/ticketCategories");
const { ticketPriorityLabel, validateTicketInput } = require("../tickets/ticketRules");

/**
 * Estado de tickets del asistente, guardado en la sesión del usuario.
 *
 *   - Adjuntos pendientes: archivos que el usuario subió en el chat. Ya están
 *     en el bucket de tickets; se suman al próximo borrador.
 *   - Borrador: lo arma el modelo con draft_support_ticket. En Soporte no se
 *     crea nada hasta que el usuario pulsa «Crear ticket» en la tarjeta, y el
 *     borrador sólo existe en la sesión de quien lo armó.
 */

const ATTACHMENTS_KEY = "assistantAttachments";
const DRAFT_KEY = "assistantTicketDraft";
const MAX_PENDING_ATTACHMENTS = 5;

function getPendingAttachments(session) {
  const list = session && session[ATTACHMENTS_KEY];
  return Array.isArray(list) ? list : [];
}

function addPendingAttachment(session, attachment) {
  const pending = getPendingAttachments(session);
  if (pending.length >= MAX_PENDING_ATTACHMENTS) {
    return { ok: false, error: `Puedes adjuntar hasta ${MAX_PENDING_ATTACHMENTS} archivos por ticket.` };
  }
  const item = { id: crypto.randomUUID(), ...attachment };
  session[ATTACHMENTS_KEY] = [...pending, item];
  return { ok: true, attachment: item };
}

function removePendingAttachment(session, id) {
  const pending = getPendingAttachments(session);
  const next = pending.filter((item) => item.id !== id);
  session[ATTACHMENTS_KEY] = next;
  return next.length !== pending.length;
}

function getTicketDraft(session, id) {
  const draft = session && session[DRAFT_KEY];
  return draft && draft.id === id ? draft : null;
}

/**
 * Arma (o rehace) el borrador. Los adjuntos pendientes pasan al borrador y
 * se conservan los que ya tenía uno anterior.
 */
function saveTicketDraft(session, input) {
  const previous = session[DRAFT_KEY];
  const validation = validateTicketInput({
    ...input,
    attachments: [...((previous && previous.attachments) || []), ...getPendingAttachments(session)],
  });
  if (!validation.ok) return validation;

  const draft = { id: crypto.randomUUID(), ...validation.ticket };
  session[DRAFT_KEY] = draft;
  session[ATTACHMENTS_KEY] = [];
  return { ok: true, draft };
}

function clearTicketDraft(session) {
  if (session) delete session[DRAFT_KEY];
}

/** Descarta el borrador; sus adjuntos vuelven a quedar pendientes. */
function discardTicketDraft(session, id) {
  const draft = getTicketDraft(session, id);
  if (!draft) return false;
  clearTicketDraft(session);
  session[ATTACHMENTS_KEY] = draft.attachments
    .slice(0, MAX_PENDING_ATTACHMENTS)
    .map((attachment) => ({ id: crypto.randomUUID(), ...attachment }));
  return true;
}

/** Empezar de nuevo: sin borrador ni adjuntos pendientes. */
function clearTicketState(session) {
  if (!session) return;
  delete session[DRAFT_KEY];
  delete session[ATTACHMENTS_KEY];
}

/** Lo que ve el cliente de un adjunto (sin la URL del bucket). */
function publicAttachment({ id, nombre, tipo }) {
  return { id, nombre, tipo };
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
    attachments: draft.attachments.map(({ nombre, tipo }) => ({ nombre, tipo })),
  };
}

module.exports = {
  MAX_PENDING_ATTACHMENTS,
  getPendingAttachments,
  addPendingAttachment,
  removePendingAttachment,
  getTicketDraft,
  saveTicketDraft,
  clearTicketDraft,
  discardTicketDraft,
  clearTicketState,
  publicAttachment,
  publicDraft,
};
