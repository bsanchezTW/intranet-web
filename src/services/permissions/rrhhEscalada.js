/**
 * Cierra la escalada de RRHH-M (hallazgo A.4.4): quien edita personas no se
 * da más acceso del que tiene.
 *
 * Desde la fase 11 no hay rol ni nombres de área que den permisos: lo que se
 * vigila es la cuenta propia (estado, área, jefatura), el estado de un
 * superadmin y el correo de una cuenta con más permisos que quien edita.
 *
 * Devuelve null si la acción puede seguir, o un código si hay que rechazarla
 * como un permiso denegado.
 */

function mismoId(a, b) {
  if (a == null || a === "") return b == null || b === "";
  if (b == null || b === "") return false;
  return Number(a) === Number(b);
}

function normCorreo(value) {
  return String(value ?? "").trim().toLowerCase();
}

/** ¿Cambia el estado de la cuenta? (sólo si los dos lados lo traen). */
function cambiaEstado(antes, despues) {
  return typeof antes.active === "boolean" && typeof despues.active === "boolean" && antes.active !== despues.active;
}

/**
 * `objetivoSuperadmin`: la persona editada es superadmin. Nadie más le cambia
 * el estado: desactivarlo sería sacar al único que administra los permisos.
 *
 * `objetivoPrivilegiado`: la persona editada es superadmin o tiene algún
 * permiso que quien edita no tiene. Su correo es la llave de la cuenta (login
 * y «Olvidé mi contraseña»): quien lo cambia por uno propio se queda con esos
 * permisos. Sólo el superadmin lo cambia; cada uno sí puede corregir el suyo.
 */
function rechazoEscalada({
  superadmin = false,
  actorId = null,
  targetId = null,
  antes = {},
  despues = {},
  objetivoSuperadmin = false,
  objetivoPrivilegiado = false,
} = {}) {
  if (superadmin) return null;

  const propio = targetId != null && mismoId(actorId, targetId);
  if (propio && cambiaEstado(antes, despues)) return "propio-estado";
  if (propio && antes.areaId !== undefined && despues.areaId !== undefined
      && !mismoId(antes.areaId, despues.areaId)) {
    return "propio-area";
  }
  if (propio && despues.seDesignaJefe) return "propio-jefe";

  if (objetivoSuperadmin && cambiaEstado(antes, despues)) return "estado-superadmin";

  if (!propio && objetivoPrivilegiado && antes.email !== undefined && despues.email !== undefined
      && normCorreo(antes.email) !== normCorreo(despues.email)) {
    return "correo-privilegiado";
  }
  return null;
}

/** Qué permiso exige cada parte de POST /editar/:id. Compara contra lo guardado. */
function clavesDeEdicion({ datos = false, estado = false, area = false } = {}) {
  const claves = [];
  if (datos) claves.push("rrhh.colaborador.editar");
  if (estado) claves.push("rrhh.colaborador.activar");
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
    estado: typeof next.active === "boolean" && Boolean(prev.active) !== next.active,
    area: !mismoId(prev.work_area_id, next.work_area_id),
  };
}

module.exports = {
  rechazoEscalada,
  clavesDeEdicion,
  cambiosDeFicha,
  mismoId,
};
