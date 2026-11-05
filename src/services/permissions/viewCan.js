const { decide } = require("./decide");

/**
 * `can` de las vistas:
 *
 *   can('noticias.noticia.crear')                              ¿tiene el permiso?
 *   can('vacaciones.solicitud.aprobar', { ownerId, areaId })   ¿sobre este registro?
 *   can.field('gastos.solicitud.campo.cuenta_bancaria')        ¿ve este dato?
 *
 * Conserva además las propiedades de los módulos que aún no tienen permisos
 * en el catálogo (`can.tickets_reply`…), que leen algunas vistas.
 */
function buildViewCan(perms, legacy = {}) {
  const can = (key, record) => decide(perms, key, { record: record || null });
  can.field = (key) => decide(perms, key);
  return Object.assign(can, legacy);
}

module.exports = { buildViewCan };
