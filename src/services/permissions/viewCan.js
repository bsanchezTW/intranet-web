const { decide } = require("./decide");

/**
 * `can` de las vistas:
 *
 *   can('noticias.noticia.crear')                              ¿tiene el permiso?
 *   can('vacaciones.solicitud.aprobar', { ownerId, areaId })   ¿sobre este registro?
 *   can.field('gastos.solicitud.campo.cuenta_bancaria')        ¿ve este dato?
 *
 * Pasa por decide(): en modo sombra responde lo de siempre para los permisos
 * ya migrados. Mientras cada módulo se migra, conserva además las
 * propiedades antiguas (`can.cursos_write`…) que aún leen algunas vistas.
 */
function buildViewCan(perms, legacy = {}, { legacyCtx = null, path = null } = {}) {
  const can = (key, record) => decide(perms, key, legacyCtx, { record: record || null, path });
  can.field = (key) => decide(perms, key, legacyCtx, { path });
  return Object.assign(can, legacy);
}

module.exports = { buildViewCan };
