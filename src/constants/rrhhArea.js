/**
 * Área de Recursos Humanos.
 *
 * La sección Administración de RRHH (áreas, centros de costo, feriados,
 * gestión de vacaciones) y el alta o edición de colaboradores son de los
 * administradores de esta área, además de los de Informática. La regla vive
 * en services/access/staffAccess.js; aquí sólo el nombre, que en la base se
 * escribe a mano ("RRHH", "Recursos Humanos").
 *
 * Los nombres son por país (config/country.js → rrhhAreaNames): en Perú RRHH
 * lo lleva el área de la Administradora.
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
