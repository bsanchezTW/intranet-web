const { SCOPE_SETS } = require("../scopes");

module.exports = {
  module: "soporte",
  label: "Soporte",
  feature: "supportTickets",
  permissions: [
    { key: "soporte.acceso", label: "Entrar a Soporte" },
    { key: "soporte.ticket.crear", label: "Abrir tickets" },
    { key: "soporte.ticket.ver", label: "Ver tickets y sus adjuntos", scopes: SCOPE_SETS.PROPIO_O_TODO },
    { key: "soporte.ticket.responder", label: "Responder tickets", scopes: SCOPE_SETS.PROPIO_O_TODO },
    { key: "soporte.ticket.gestionar", label: "Asignar, priorizar y cerrar tickets" },
  ],
};
