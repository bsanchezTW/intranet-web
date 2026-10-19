const { SCOPE_SETS } = require("../scopes");

/**
 * Procedimientos y Protocolos tienen una carpeta por área: el alcance dice
 * cuáles (su área, las que dirige, unas elegidas o todas). Reglamento y
 * Otros son documentos generales, sin carpetas.
 */
function seccionPorArea(seccion, etiqueta) {
  return [
    { key: `procesos.${seccion}.ver`, label: `Ver ${etiqueta}`, scopes: SCOPE_SETS.CARPETAS },
    { key: `procesos.${seccion}.subir`, label: `Subir ${etiqueta}`, scopes: SCOPE_SETS.CARPETAS },
    { key: `procesos.${seccion}.editar`, label: `Renombrar ${etiqueta}`, scopes: SCOPE_SETS.CARPETAS },
    { key: `procesos.${seccion}.eliminar`, label: `Eliminar ${etiqueta}`, scopes: SCOPE_SETS.CARPETAS },
  ];
}

function seccionGeneral(seccion, etiqueta) {
  return [
    { key: `procesos.${seccion}.ver`, label: `Ver ${etiqueta}` },
    { key: `procesos.${seccion}.subir`, label: `Subir ${etiqueta}` },
    { key: `procesos.${seccion}.editar`, label: `Renombrar ${etiqueta}` },
    { key: `procesos.${seccion}.eliminar`, label: `Eliminar ${etiqueta}` },
  ];
}

module.exports = {
  module: "procesos",
  label: "Procesos",
  permissions: [
    { key: "procesos.acceso", label: "Entrar a Procesos" },
    ...seccionPorArea("procedimientos", "procedimientos"),
    ...seccionPorArea("protocolos", "protocolos"),
    ...seccionGeneral("reglamento", "el reglamento interno"),
    ...seccionGeneral("otros", "otros documentos"),
    { key: "procesos.sin_area.ver", label: "Ver documentos que quedaron sin área" },
    { key: "procesos.sin_area.administrar", label: "Renombrar y eliminar documentos sin área" },
  ],
};
