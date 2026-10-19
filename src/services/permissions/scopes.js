/**
 * Alcances de un permiso: sobre qué registros vale.
 *
 *   propio   lo suyo
 *   mi_area  lo de su área de trabajo
 *   a_cargo  lo de las áreas que dirige y todo lo que cuelga de ellas
 *   areas    una lista de áreas elegidas (con o sin sus subáreas)
 *   todo     toda la empresa
 *
 * Un permiso sin alcance (crear una noticia, editar apps) se tiene o no se
 * tiene. El catálogo declara qué alcances admite cada permiso.
 */

const SCOPE = Object.freeze({
  PROPIO: "propio",
  MI_AREA: "mi_area",
  A_CARGO: "a_cargo",
  AREAS: "areas",
  TODO: "todo",
});

const ALL_SCOPES = Object.freeze(Object.values(SCOPE));

const SCOPE_LABELS = Object.freeze({
  propio: "Lo propio",
  mi_area: "Su área",
  a_cargo: "Áreas a su cargo",
  areas: "Áreas elegidas",
  todo: "Toda la empresa",
});

/** Juegos de alcances que se repiten en el catálogo. */
const SCOPE_SETS = Object.freeze({
  // Registros de personas: solicitudes, fichas, saldos.
  PERSONAS: ALL_SCOPES,
  // Lo de otros (aprobar, administrar): "lo propio" no tiene sentido.
  EQUIPO: Object.freeze([SCOPE.MI_AREA, SCOPE.A_CARGO, SCOPE.AREAS, SCOPE.TODO]),
  // Carpetas de Procesos: una por área.
  CARPETAS: Object.freeze([SCOPE.MI_AREA, SCOPE.A_CARGO, SCOPE.AREAS, SCOPE.TODO]),
  PROPIO_O_TODO: Object.freeze([SCOPE.PROPIO, SCOPE.TODO]),
  ELEGIDAS_O_TODO: Object.freeze([SCOPE.AREAS, SCOPE.TODO]),
});

function isScope(value) {
  return ALL_SCOPES.includes(value);
}

module.exports = {
  SCOPE,
  ALL_SCOPES,
  SCOPE_LABELS,
  SCOPE_SETS,
  isScope,
};
