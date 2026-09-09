/**
 * Área responsable de la mesa de ayuda.
 *
 * Administrar tickets (asignar, responder como Soporte, cambiar prioridad o
 * cerrar) no depende del rol sino del área: sólo quien pertenece a Informática
 * gestiona. El rol sigue decidiendo el resto de la intranet.
 *
 * Los nombres se comparan sin acentos ni mayúsculas porque el área se escribe
 * a mano en `work_areas.area_name` y conviven "Informática", "Informatica" y
 * "TI". Para sumar otra área a la mesa de ayuda basta agregarla aquí.
 */

const SUPPORT_AREA_NAMES = ["informatica", "ti"];

/** Rango de marcas diacríticas combinantes que deja `normalize("NFD")`. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/** Minúsculas y sin diacríticos, para comparar nombres escritos a mano. */
function normalizeAreaName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .trim()
    .toLowerCase();
}

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
