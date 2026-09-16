/**
 * La conversación del asistente vive en la sesión del usuario, no en la BD:
 * hay una sola por persona y desaparece al cerrar sesión o cuando la sesión
 * expira. Se guardan sólo los últimos mensajes, que son también el contexto
 * que se le manda al modelo.
 */

const SESSION_KEY = "assistantConversation";
const MAX_HISTORY_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 2000;

function getHistory(session) {
  const messages = session && session[SESSION_KEY];
  return Array.isArray(messages) ? messages : [];
}

/** Agrega pregunta y respuesta juntas: el historial siempre parte con el usuario. */
function appendExchange(session, userText, assistantText) {
  if (!session) return;
  const messages = [
    ...getHistory(session),
    { role: "user", content: userText },
    { role: "assistant", content: assistantText },
  ];
  session[SESSION_KEY] = messages.slice(-MAX_HISTORY_MESSAGES);
}

function clearConversation(session) {
  if (session) delete session[SESSION_KEY];
}

module.exports = {
  MAX_HISTORY_MESSAGES,
  MAX_MESSAGE_CHARS,
  getHistory,
  appendExchange,
  clearConversation,
};
