module.exports = {
  module: "letras",
  label: "Letras de cambio",
  feature: "billsOfExchange",
  permissions: [
    { key: "letras.acceso", label: "Entrar a Letras" },
    { key: "letras.letra.ver", label: "Ver letras y lotes" },
    { key: "letras.letra.crear", label: "Emitir letras" },
    { key: "letras.letra.editar", label: "Editar lotes" },
    { key: "letras.letra.eliminar", label: "Eliminar letras y lotes" },
    { key: "letras.letra.marcar_pagada", label: "Marcar letras como pagadas" },
    { key: "letras.letra.anular", label: "Anular letras" },
    { key: "letras.letra.exportar_pdf", label: "Descargar el PDF de letras y lotes" },
  ],
};
