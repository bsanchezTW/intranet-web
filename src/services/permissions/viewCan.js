/**
 * `can` de las vistas:
 *
 *   can('noticias.noticia.crear')                      ¿tiene el permiso?
 *   can('vacaciones.solicitud.aprobar', { ownerId, areaId })   ¿sobre este registro?
 *   can.field('gastos.solicitud.campo.cuenta_bancaria')        ¿ve este dato?
 *
 * Mientras cada módulo se migra, conserva las propiedades antiguas
 * (`can.noticias_write`…) con las reglas de siempre: las vistas que aún las
 * leen siguen funcionando igual.
 */
function buildViewCan(perms, legacy = {}) {
  const can = (key, record) => (record ? perms.canOnRecord(key, record) : perms.can(key));
  can.field = (key) => perms.canSeeField(key);
  return Object.assign(can, legacy);
}

module.exports = { buildViewCan };
