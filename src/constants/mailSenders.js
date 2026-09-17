/**
 * Nombre visible del remitente. El From es siempre el noreply del país
 * (noreply@transworld.cl / .pe); esto sólo cambia cómo se lee el correo.
 */
const MAIL_SENDERS = {
  intranet: "Intranet Transworld",
  support: "Soporte Transworld",
  hr: "Recursos Humanos Transworld",
  finance: "Finanzas Transworld",
  news: "Noticias Transworld",
};

const MAIL_AREAS = {
  intranet: "Intranet",
  support: "Soporte",
  hr: "Recursos Humanos",
  finance: "Finanzas",
  news: "Noticias",
};

function areaFromSender(senderName) {
  const entry = Object.entries(MAIL_SENDERS).find(([, name]) => name === senderName);
  return MAIL_AREAS[entry ? entry[0] : "intranet"];
}

module.exports = { MAIL_SENDERS, MAIL_AREAS, areaFromSender };
