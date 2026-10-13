/**
 * Área responsable del centro de gastos.
 *
 * Aprobar en la etapa final de una rendición o una solicitud de fondos no es
 * competencia de cualquier administrador: exige pertenecer a Finanzas **y**
 * tener rol Administrador. El área sola no basta (un asistente de Finanzas
 * consulta pero no liquida) y el rol solo tampoco (un administrador de
 * Marketing no debe ver las rendiciones de toda la empresa).
 *
 * El doble requisito se aplica en services/expenses/financeTeam.js; aquí sólo
 * vive el nombre del área. Para sumar otra área a Finanzas basta agregarla.
 *
 * Las áreas que dependen de Finanzas en el organigrama (Contabilidad,
 * Tesorería…) también cuentan: separarlas en sub-áreas no debe quitarles la
 * etapa de Finanzas a sus administradores.
 */

const { normalizeAreaName } = require("./workAreas");
const { descendantIds } = require("../services/workAreaTree");

const FINANCE_AREA_NAMES = ["finanzas", "administracion y finanzas"];

/** ¿Este nombre de área es el del departamento de Finanzas? */
function isFinanceAreaName(areaName) {
  const normalized = normalizeAreaName(areaName);
  return normalized.length > 0 && FINANCE_AREA_NAMES.includes(normalized);
}

/**
 * Ids de las áreas que cuentan como Finanzas: las que se llaman así y todas
 * las que cuelgan de ellas. `areas` son nodos { id, area_name, parent_area_id }.
 */
function financeAreaIds(areas) {
  const ids = new Set();
  for (const area of areas || []) {
    if (!isFinanceAreaName(area.area_name)) continue;
    ids.add(Number(area.id));
    for (const id of descendantIds(areas, area.id)) ids.add(Number(id));
  }
  return ids;
}

module.exports = {
  FINANCE_AREA_NAMES,
  isFinanceAreaName,
  financeAreaIds,
};
