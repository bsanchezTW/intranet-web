const { isAdministrador, normalizeRole } = require("../../constants/roles");
const { isSupportAreaName } = require("../../constants/supportArea");

/**
 * Cierra la escalada de RRHH-M (hallazgo A.4.4). Corre también en sombra.
 * `isSupportAreaName` es temporal: la jefatura de Informática deja de dar
 * acceso total en la fase 11, y este caso se va con ella.
 *
 * Devuelve null si la acción puede seguir, o un código si hay que rechazarla
 * como un permiso denegado.
 */

function mismoId(a, b) {
  if (a == null || a === "") return b == null || b === "";
  if (b == null || b === "") return false;
  return Number(a) === Number(b);
}

function rechazoEscalada({
  superadmin = false,
  actorId = null,
  targetId = null,
  antes = {},
  despues = {},
  areaNombre = null,
} = {}) {
  if (superadmin) return null;

  const propio = targetId != null && mismoId(actorId, targetId);
  if (propio && antes.role != null && despues.role != null
      && normalizeRole(antes.role) !== normalizeRole(despues.role)) {
    return "propio-rol";
  }
  if (propio && antes.areaId !== undefined && despues.areaId !== undefined
      && !mismoId(antes.areaId, despues.areaId)) {
    return "propio-area";
  }
  if (propio && despues.seDesignaJefe) return "propio-jefe";

  if (antes.role != null && despues.role != null
      && isAdministrador(antes.role) !== isAdministrador(despues.role)) {
    return "rol-administrador";
  }

  if (despues.designaJefe && isSupportAreaName(areaNombre)) return "jefe-informatica";
  return null;
}

/** Qué permiso exige cada parte de POST /editar/:id. Compara contra lo guardado. */
function clavesDeEdicion({ datos = false, rol = false, area = false } = {}) {
  const claves = [];
  if (datos) claves.push("rrhh.colaborador.editar");
  if (rol) claves.push("rrhh.colaborador.activar");
  if (area) claves.push("organigrama.area.editar_miembros");
  return claves;
}

function norm(value) {
  return String(value ?? "").trim();
}

function normFecha(value) {
  if (value == null || value === "") return "";
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  const s = String(value).trim();
  return s.length >= 10 ? s.slice(0, 10) : s;
}

function cambiosDeFicha(prev, next) {
  const texto = ["first_name", "last_name", "email", "phone", "personal_email", "work_phone", "national_id"];
  const datos = texto.some((campo) => norm(prev[campo]) !== norm(next[campo]))
    || normFecha(prev.birth_date) !== normFecha(next.birth_date)
    || normFecha(prev.hire_date) !== normFecha(next.hire_date)
    || Boolean(next.cambiaFoto);
  return {
    datos,
    rol: normalizeRole(prev.role) !== normalizeRole(next.role),
    area: !mismoId(prev.work_area_id, next.work_area_id),
  };
}

module.exports = {
  rechazoEscalada,
  clavesDeEdicion,
  cambiosDeFicha,
  mismoId,
};
