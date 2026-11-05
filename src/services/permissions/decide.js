/**
 * La única decisión de permisos de la intranet: Gestión de Permisos.
 *
 * Durante la migración hubo un modo sombra, en que decidían las reglas
 * antiguas y la nueva sólo se anotaba. Se quitó el 2026-11-05: lo que se
 * cambia en /permisos vale en la siguiente petición.
 *
 *   decide(perms, "noticias.noticia.crear")
 *   decide(perms, "vacaciones.solicitud.aprobar", { record: { ownerId, areaId } })
 */
function decide(perms, key, { record = null } = {}) {
  if (!perms) return false;
  return record ? perms.canOnRecord(key, record) : perms.can(key);
}

/** Filtro SQL de un listado con alcance (ver EffectivePermissions.sqlFilter). */
function scopeFilter(perms, key, columns) {
  return perms.sqlFilter(key, columns);
}

module.exports = { decide, scopeFilter };
