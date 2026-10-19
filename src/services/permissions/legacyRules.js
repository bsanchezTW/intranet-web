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
 * Cada regla recibe el contexto antiguo de la sesión ({ active, admin }) y,
 * si la comprobación es sobre un registro, el registro.
 */

const ACTIVO = (ctx) => ctx.active;
const ADMIN = (ctx) => ctx.admin;

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
});

/** Contexto antiguo de una sesión: rol activo y rol Administrador. */
function legacyContext(sessionUser) {
  if (!sessionUser) return { active: false, admin: false };
  const role = normalizeRole(sessionUser.role);
  return { active: canLogin(role), admin: isAdministrador(role) };
}

function hasLegacyRule(key) {
  return Object.prototype.hasOwnProperty.call(LEGACY_RULES, key);
}

module.exports = {
  LEGACY_RULES,
  legacyContext,
  hasLegacyRule,
};
