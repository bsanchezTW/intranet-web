const { SCOPE_SETS } = require("../scopes");

/** Fondos por rendir y rendiciones de gastos: el mismo flujo de dos etapas. */
// Permisos que ningún código revisa todavía: se muestran como «Aún sin efecto»
// en Gestión de Permisos. Al conectar uno, se le quita la marca (lo exige un test).
const SIN_EFECTO = "Fondos y rendiciones todavía decide con las reglas de antes (jefes del organigrama y Finanzas): este permiso aún no cambia nada.";

module.exports = {
  module: "gastos",
  label: "Fondos y rendiciones",
  feature: "expenseRequests",
  permissions: [
    { key: "gastos.acceso", label: "Entrar a Fondos y rendiciones" },
    { key: "gastos.solicitud.crear", label: "Pedir fondos y rendir gastos" },
    { key: "gastos.solicitud.ver", label: "Ver solicitudes", scopes: SCOPE_SETS.PERSONAS },
    {
      key: "gastos.solicitud.aprobar_jefatura",
      label: "Aprobar la etapa de jefatura",
      scopes: SCOPE_SETS.EQUIPO,
    },
    {
      key: "gastos.solicitud.aprobar_finanzas",
      label: "Aprobar la etapa de Finanzas",
      scopes: SCOPE_SETS.EQUIPO,
    },
    { key: "gastos.solicitud.liquidar", label: "Liquidar rendiciones", scopes: SCOPE_SETS.EQUIPO },
    { key: "gastos.solicitud.exportar", sinEfecto: SIN_EFECTO, label: "Exportar solicitudes" },
    { key: "gastos.solicitud.campo.cuenta_bancaria", label: "Ver la cuenta bancaria de destino" },
    { key: "gastos.solicitud.campo.documento_identidad", sinEfecto: SIN_EFECTO, label: "Ver el RUT del solicitante" },
  ],
};
