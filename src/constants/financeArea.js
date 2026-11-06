/**
 * Área de Finanzas, por su nombre (con las áreas que dependen de ella en el
 * organigrama: Contabilidad, Tesorería…).
 *
 * Desde la fase 11 el nombre de un área no da permisos: aprobar o liquidar
 * gastos sale de Gestión de Permisos. Sólo lo usa el arranque (bootstrap.js)
 * para copiar a Finanzas en un país que todavía no lo corrió.
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
