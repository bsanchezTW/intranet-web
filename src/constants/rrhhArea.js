/**
 * Área de Recursos Humanos.
 *
 * La sección Administración de RRHH (áreas, centros de costo, feriados,
 * gestión de vacaciones) y el alta o edición de colaboradores son de los
 * administradores de esta área, además de los de Informática. La regla vive
 * en services/access/staffAccess.js; aquí sólo el nombre, que en la base se
 * escribe a mano ("RRHH", "Recursos Humanos").
 */

const { normalizeAreaName } = require("./workAreas");

const RRHH_AREA_NAMES = ["rrhh", "recursos humanos"];

/** ¿Este nombre de área es el de Recursos Humanos? */
function isRrhhAreaName(areaName) {
  const normalized = normalizeAreaName(areaName);
  return normalized.length > 0 && RRHH_AREA_NAMES.includes(normalized);
}

module.exports = {
  RRHH_AREA_NAMES,
  isRrhhAreaName,
};
