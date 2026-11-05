const { SCOPE_SETS } = require("../scopes");

// Permisos que ningún código revisa todavía: se muestran como «Aún sin efecto»
// en Gestión de Permisos. Al conectar uno, se le quita la marca (lo exige un test).
const SIN_EFECTO = "Vacaciones todavía decide con las reglas de antes (RRHH y los jefes del organigrama): este permiso aún no cambia nada.";

module.exports = {
  module: "vacaciones",
  label: "Vacaciones",
  feature: "vacations",
  permissions: [
    { key: "vacaciones.acceso", sinEfecto: SIN_EFECTO, label: "Entrar a Vacaciones" },
    { key: "vacaciones.solicitud.crear", sinEfecto: SIN_EFECTO, label: "Solicitar sus vacaciones" },
    { key: "vacaciones.solicitud.ver", label: "Ver solicitudes", scopes: SCOPE_SETS.PERSONAS },
    { key: "vacaciones.solicitud.aprobar", label: "Aprobar y rechazar solicitudes", scopes: SCOPE_SETS.EQUIPO },
    { key: "vacaciones.calendario.ver", sinEfecto: SIN_EFECTO, label: "Ver el calendario de vacaciones", scopes: SCOPE_SETS.PERSONAS },
    { key: "vacaciones.saldo.ver", sinEfecto: SIN_EFECTO, label: "Ver saldos y períodos", scopes: SCOPE_SETS.PERSONAS },
    { key: "vacaciones.saldo.ajustar", sinEfecto: SIN_EFECTO, label: "Ajustar saldos y récords", scopes: SCOPE_SETS.ELEGIDAS_O_TODO },
    { key: "vacaciones.historial.editar", sinEfecto: SIN_EFECTO, label: "Cargar y corregir el historial", scopes: SCOPE_SETS.ELEGIDAS_O_TODO },
    { key: "vacaciones.periodo.cortar", sinEfecto: SIN_EFECTO, label: "Hacer el corte de períodos" },
    { key: "vacaciones.reporte.exportar", sinEfecto: SIN_EFECTO, label: "Exportar reportes de vacaciones" },
    { key: "vacaciones.configuracion.editar", sinEfecto: SIN_EFECTO, label: "Cambiar la configuración de vacaciones" },
  ],
};
