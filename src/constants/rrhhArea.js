/**
 * Área de Recursos Humanos, por su nombre ("RRHH", "Recursos Humanos").
 *
 * Desde la fase 11 el nombre de un área no da permisos: sólo lo usa el
 * arranque de Gestión de Permisos (bootstrap.js) para copiar quién gestionaba
 * RRHH en un país que todavía no lo corrió.
 */

const { normalizeAreaName } = require("./workAreas");
const { getCountryConfig } = require("../config/country");

/** Nombres normalizados del área de RRHH en `countryCode`. */
function rrhhAreaNames(countryCode) {
  return getCountryConfig(countryCode).rrhhAreaNames.map(normalizeAreaName);
}

/** ¿Este nombre de área es el de Recursos Humanos en `countryCode`? */
function isRrhhAreaName(areaName, countryCode) {
  const normalized = normalizeAreaName(areaName);
  return normalized.length > 0 && rrhhAreaNames(countryCode).includes(normalized);
}

module.exports = {
  rrhhAreaNames,
  isRrhhAreaName,
};
