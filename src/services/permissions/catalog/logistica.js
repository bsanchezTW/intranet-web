const { SCOPE_SETS } = require("../scopes");

/**
 * Logística: Gestión de flota (vehículos, revisión mecánica, revisión física
 * e historial) y hojas de ruta.
 *
 * Nació con permisos: sólo el superadmin lo ve hasta que se asigne. Cada
 * parte suma aquí sus acciones a medida que se construye.
 *
 * Las claves `checklist.*` son las de la revisión mecánica (el «Check list
 * diario»): se conservan aunque cambió el nombre, para no perder las
 * asignaciones. "Lo propio" es lo que la persona registró: quien sólo
 * registra ve lo suyo, y Logística lo de toda la flota. La revisión física
 * sigue la misma regla con sus claves `fisica.*`; reparar un daño es aparte.
 *
 * En las hojas de ruta "lo propio" es además la hoja donde la persona va de
 * conductor o peoneta: Logística puede abrirla por el conductor. Completar
 * lo propio es `crear`; completar y cerrar la de otros, `administrar`.
 */
module.exports = {
  module: "logistica",
  label: "Logística",
  feature: "logistics",
  permissions: [
    { key: "logistica.acceso", label: "Entrar a Logística" },
    { key: "logistica.vehiculo.ver", label: "Ver Gestión de flota" },
    { key: "logistica.vehiculo.administrar", label: "Agregar, editar y dar de baja vehículos" },
    {
      key: "logistica.hoja_ruta.ver",
      label: "Ver e imprimir hojas de ruta",
      scopes: SCOPE_SETS.PROPIO_O_TODO,
    },
    {
      key: "logistica.hoja_ruta.crear",
      label: "Abrir hojas de ruta y completar las propias",
    },
    {
      key: "logistica.hoja_ruta.administrar",
      label: "Completar y cerrar las hojas de ruta de cualquier conductor",
    },
    {
      key: "logistica.hoja_ruta.anular",
      label: "Anular hojas de ruta",
    },
    {
      key: "logistica.checklist.ver",
      label: "Ver e imprimir revisiones mecánicas",
      scopes: SCOPE_SETS.PROPIO_O_TODO,
    },
    { key: "logistica.checklist.crear", label: "Registrar revisiones mecánicas" },
    { key: "logistica.checklist.anular", label: "Anular revisiones mecánicas" },
    { key: "logistica.plantilla.administrar", label: "Editar los ítems de la revisión mecánica" },
    {
      key: "logistica.fisica.ver",
      label: "Ver e imprimir revisiones físicas",
      scopes: SCOPE_SETS.PROPIO_O_TODO,
    },
    { key: "logistica.fisica.crear", label: "Registrar revisiones físicas y sus daños" },
    { key: "logistica.fisica.anular", label: "Anular revisiones físicas" },
    { key: "logistica.danio.reparar", label: "Marcar daños como reparados" },
  ],
};
