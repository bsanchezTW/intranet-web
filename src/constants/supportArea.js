/**
 * Área de Informática (mesa de ayuda), por su nombre.
 *
 * Desde la fase 11 el nombre de un área no da permisos: la mesa de ayuda es
 * quien tiene «soporte.ticket.gestionar». Sólo lo usa el arranque de Gestión
 * de Permisos (bootstrap.js) para un país que todavía no lo corrió.
 *
 * La normalización de nombres vive en constants/workAreas porque es una
 * propiedad de las áreas, no de la mesa de ayuda: `area_name` se escribe a mano
 * y conviven "Informática", "Informatica" y "TI". Para sumar otra área a la
 * mesa de ayuda basta agregarla aquí.
 */

const { normalizeAreaName } = require("./workAreas");

const SUPPORT_AREA_NAMES = ["informatica", "ti"];

/** ¿Este nombre de área es el de la mesa de ayuda? */
function isSupportAreaName(areaName) {
  const normalized = normalizeAreaName(areaName);
  return normalized.length > 0 && SUPPORT_AREA_NAMES.includes(normalized);
}

module.exports = {
  SUPPORT_AREA_NAMES,
  normalizeAreaName,
  isSupportAreaName,
};
