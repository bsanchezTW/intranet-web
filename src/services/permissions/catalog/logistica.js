const { SCOPE_SETS } = require("../scopes");

/**
 * Logística: hojas de ruta y checklist de vehículos (antes planillas Excel).
 *
 * Nace con permisos y sin regla antigua: no hay nada de hoy que conservar,
 * así que también en modo sombra decide Gestión de Permisos (sólo el
 * superadmin lo ve hasta que se asigne). Cada módulo suma aquí sus acciones
 * a medida que se construyen.
 *
 * "Lo propio" de un checklist es lo que la persona registró: quien sólo
 * registra ve lo suyo, y Logística lo de toda la flota.
 */
module.exports = {
  module: "logistica",
  label: "Logística",
  feature: "logistics",
  permissions: [
    { key: "logistica.acceso", label: "Entrar a Logística" },
    { key: "logistica.vehiculo.ver", label: "Ver la flota de vehículos" },
    { key: "logistica.vehiculo.administrar", label: "Agregar, editar y dar de baja vehículos" },
    { key: "logistica.hoja_ruta.ver", label: "Ver hojas de ruta" },
    {
      key: "logistica.checklist.ver",
      label: "Ver e imprimir checklists de vehículos",
      scopes: SCOPE_SETS.PROPIO_O_TODO,
    },
    { key: "logistica.checklist.crear", label: "Registrar checklists de vehículos" },
    { key: "logistica.checklist.anular", label: "Anular checklists de vehículos" },
    { key: "logistica.plantilla.administrar", label: "Editar los ítems del checklist" },
  ],
};
