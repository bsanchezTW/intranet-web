const { canLogin, isAdministrador, normalizeRole } = require("../../constants/roles");

/**
 * Reglas antiguas de los permisos ya migrados, para el modo sombra: mientras
 * perm_meta.mode = 'sombra', cada comprobación calcula la regla nueva y ésta,
 * decide con ésta y anota las diferencias (ver decide.js). Así se puede
 * migrar un módulo sin cambiarle nada a nadie y ver, antes de aplicar, a
 * quién le cambiaría qué.
 *
 * Al pasar a 'aplicar' este archivo deja de usarse; se borra en la fase de
 * limpieza junto con users.role.
 *
 * Cada regla recibe el contexto antiguo de la sesión
 * ({ active, admin, rrhhManager, workAreaId }) y, si la comprobación es
 * sobre un registro, el registro. Las reglas de las fases 0 a 4 sólo leen
 * active y admin.
 */

const ACTIVO = (ctx) => ctx.active;
const ADMIN = (ctx) => ctx.admin;

/** Carpeta de procedimientos o protocolos: todos entran a la sección; el área, la propia o un admin. */
function verCarpeta(ctx, record) {
  if (!ctx.active) return false;
  if (!record || record.areaId == null) return true;
  return Boolean(ctx.admin) || Number(record.areaId) === Number(ctx.workAreaId);
}

const LEGACY_RULES = Object.freeze({
  // Inicio: cualquier sesión activa; LinkedIn lo conecta un administrador.
  "inicio.acceso": ACTIVO,
  "inicio.accesos.personalizar": ACTIVO,
  "inicio.indicador_uf.ver": ACTIVO,
  "inicio.linkedin.ver": ACTIVO,
  "inicio.linkedin.configurar": ADMIN,

  // Noticias: leer todos, escribir los administradores (ROLES_ESCRITURA).
  "noticias.acceso": ACTIVO,
  "noticias.noticia.ver": ACTIVO,
  "noticias.noticia.crear": ADMIN,
  "noticias.noticia.editar": ADMIN,
  "noticias.noticia.eliminar": ADMIN,
  "noticias.noticia.destacar": ADMIN,
  "noticias.noticia.enviar_correo": ADMIN,

  // Eventos y galería (WRITE_ROLES).
  "eventos.acceso": ACTIVO,
  "eventos.evento.ver": ACTIVO,
  "eventos.evento.crear": ADMIN,
  "eventos.evento.editar": ADMIN,
  "eventos.evento.eliminar": ADMIN,
  "eventos.fotos.subir": ADMIN,
  "eventos.fotos.eliminar": ADMIN,

  // Cursos: el KPI estaba abierto a todos, con correos.
  "cursos.acceso": ACTIVO,
  "cursos.curso.ver": ACTIVO,
  "cursos.material.crear": ADMIN,
  "cursos.material.editar": ADMIN,
  "cursos.material.eliminar": ADMIN,
  "cursos.avance.ver": ACTIVO,
  "cursos.avance.campo.email": ACTIVO,

  // Apps.
  "apps.acceso": ACTIVO,
  "apps.app.ver": ACTIVO,
  "apps.app.crear": ADMIN,
  "apps.app.editar": ADMIN,
  "apps.app.eliminar": ADMIN,
  "apps.app.ordenar": ADMIN,
  "apps.app.notificar": ADMIN,

  // Casino.
  "casino.acceso": ACTIVO,
  "casino.menu.ver": ACTIVO,
  "casino.menu.editar": ADMIN,

  // Procesos. Subir, renombrar y eliminar: cualquier administrador, en cualquier carpeta.
  "procesos.acceso": ACTIVO,
  "procesos.procedimientos.ver": verCarpeta,
  "procesos.procedimientos.subir": ADMIN,
  "procesos.procedimientos.editar": ADMIN,
  "procesos.procedimientos.eliminar": ADMIN,
  "procesos.protocolos.ver": verCarpeta,
  "procesos.protocolos.subir": ADMIN,
  "procesos.protocolos.editar": ADMIN,
  "procesos.protocolos.eliminar": ADMIN,
  "procesos.reglamento.ver": ACTIVO,
  "procesos.reglamento.subir": ADMIN,
  "procesos.reglamento.editar": ADMIN,
  "procesos.reglamento.eliminar": ADMIN,
  "procesos.otros.ver": ACTIVO,
  "procesos.otros.subir": ADMIN,
  "procesos.otros.editar": ADMIN,
  "procesos.otros.eliminar": ADMIN,
  "procesos.sin_area.ver": ADMIN,
  "procesos.sin_area.administrar": ADMIN,

  // Directorio: el contacto personal (enmascarado) lo ve cualquier sesión activa.
  "rrhh.directorio.campo.contacto_personal": ACTIVO,
});

/**
 * Contexto antiguo de una sesión.
 * `rrhhManager` y `workAreaId` los llena el middleware de sesión (fases 5 y 6);
 * el fallback de requirePermission no los conoce y quedan en falso / null.
 */
function legacyContext(sessionUser, { rrhhManager = false, workAreaId = null } = {}) {
  if (!sessionUser) return { active: false, admin: false, rrhhManager: false, workAreaId: null };
  const role = normalizeRole(sessionUser.role);
  return {
    active: canLogin(role),
    admin: isAdministrador(role),
    rrhhManager: Boolean(rrhhManager),
    workAreaId: workAreaId ?? null,
  };
}

function hasLegacyRule(key) {
  return Object.prototype.hasOwnProperty.call(LEGACY_RULES, key);
}

module.exports = {
  LEGACY_RULES,
  legacyContext,
  hasLegacyRule,
};
