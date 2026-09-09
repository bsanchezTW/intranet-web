/**
 * Área responsable de la mesa de ayuda.
 *
 * Administrar tickets (asignar, responder como Soporte, cambiar prioridad o
 * cerrar) no depende del rol sino del área: sólo quien pertenece a Informática
 * gestiona. El rol sigue decidiendo el resto de la intranet.
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
