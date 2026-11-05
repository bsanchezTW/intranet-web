// Permisos que ningún código revisa todavía: se muestran como «Aún sin efecto»
// en Gestión de Permisos. Al conectar uno, se le quita la marca (lo exige un test).
const SIN_EFECTO = "Letras todavía decide con las reglas de antes (personal de Finanzas): este permiso aún no cambia nada.";

module.exports = {
  module: "letras",
  label: "Letras de cambio",
  feature: "billsOfExchange",
  permissions: [
    { key: "letras.acceso", sinEfecto: SIN_EFECTO, label: "Entrar a Letras" },
    { key: "letras.letra.ver", sinEfecto: SIN_EFECTO, label: "Ver letras y lotes" },
    { key: "letras.letra.crear", sinEfecto: SIN_EFECTO, label: "Emitir letras" },
    { key: "letras.letra.editar", sinEfecto: SIN_EFECTO, label: "Editar lotes" },
    { key: "letras.letra.eliminar", sinEfecto: SIN_EFECTO, label: "Eliminar letras y lotes" },
    { key: "letras.letra.marcar_pagada", sinEfecto: SIN_EFECTO, label: "Marcar letras como pagadas" },
    { key: "letras.letra.anular", sinEfecto: SIN_EFECTO, label: "Anular letras" },
    { key: "letras.letra.exportar_pdf", sinEfecto: SIN_EFECTO, label: "Descargar el PDF de letras y lotes" },
  ],
};
