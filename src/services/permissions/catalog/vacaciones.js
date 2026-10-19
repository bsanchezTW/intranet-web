const { SCOPE_SETS } = require("../scopes");

module.exports = {
  module: "vacaciones",
  label: "Vacaciones",
  feature: "vacations",
  permissions: [
    { key: "vacaciones.acceso", label: "Entrar a Vacaciones" },
    { key: "vacaciones.solicitud.crear", label: "Solicitar sus vacaciones" },
    { key: "vacaciones.solicitud.ver", label: "Ver solicitudes", scopes: SCOPE_SETS.PERSONAS },
    { key: "vacaciones.solicitud.aprobar", label: "Aprobar y rechazar solicitudes", scopes: SCOPE_SETS.EQUIPO },
    { key: "vacaciones.calendario.ver", label: "Ver el calendario de vacaciones", scopes: SCOPE_SETS.PERSONAS },
    { key: "vacaciones.saldo.ver", label: "Ver saldos y períodos", scopes: SCOPE_SETS.PERSONAS },
    { key: "vacaciones.saldo.ajustar", label: "Ajustar saldos y récords", scopes: SCOPE_SETS.ELEGIDAS_O_TODO },
    { key: "vacaciones.historial.editar", label: "Cargar y corregir el historial", scopes: SCOPE_SETS.ELEGIDAS_O_TODO },
    { key: "vacaciones.periodo.cortar", label: "Hacer el corte de períodos" },
    { key: "vacaciones.reporte.exportar", label: "Exportar reportes de vacaciones" },
    { key: "vacaciones.configuracion.editar", label: "Cambiar la configuración de vacaciones" },
  ],
};
