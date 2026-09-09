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
 */

const { normalizeAreaName } = require("./workAreas");

const FINANCE_AREA_NAMES = ["finanzas", "administracion y finanzas"];

/** ¿Este nombre de área es el del departamento de Finanzas? */
function isFinanceAreaName(areaName) {
  const normalized = normalizeAreaName(areaName);
  return normalized.length > 0 && FINANCE_AREA_NAMES.includes(normalized);
}

module.exports = {
  FINANCE_AREA_NAMES,
  isFinanceAreaName,
};
