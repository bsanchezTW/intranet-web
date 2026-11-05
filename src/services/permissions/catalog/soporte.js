const { SCOPE_SETS } = require("../scopes");

// Permisos que ningún código revisa todavía: se muestran como «Aún sin efecto»
// en Gestión de Permisos. Al conectar uno, se le quita la marca (lo exige un test).
const SIN_EFECTO = "Soporte todavía decide con las reglas de antes (el equipo de Informática y el rol Administrador): este permiso aún no cambia nada.";

module.exports = {
  module: "soporte",
  label: "Soporte",
  feature: "supportTickets",
  permissions: [
    { key: "soporte.acceso", sinEfecto: SIN_EFECTO, label: "Entrar a Soporte" },
    { key: "soporte.ticket.crear", sinEfecto: SIN_EFECTO, label: "Abrir tickets" },
    { key: "soporte.ticket.ver", sinEfecto: SIN_EFECTO, label: "Ver tickets y sus adjuntos", scopes: SCOPE_SETS.PROPIO_O_TODO },
    { key: "soporte.ticket.responder", sinEfecto: SIN_EFECTO, label: "Responder tickets", scopes: SCOPE_SETS.PROPIO_O_TODO },
    { key: "soporte.ticket.gestionar", sinEfecto: SIN_EFECTO, label: "Asignar, priorizar y cerrar tickets" },
  ],
};
