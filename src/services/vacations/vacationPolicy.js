/**
 * Quién hace qué en Vacaciones, con Gestión de Permisos. Pura: recibe los
 * permisos efectivos (`perms`, de resolver.js) y la fila.
 *
 *   vacaciones.acceso                 entrar
 *   vacaciones.solicitud.crear        pedir las propias
 *   vacaciones.solicitud.ver          gestión: solicitudes de otros (alcance)
 *   vacaciones.solicitud.aprobar      aprobar y rechazar (alcance)
 *   vacaciones.calendario.ver         calendario (alcance)
 *   vacaciones.saldo.ver              resumen y ficha de saldos (alcance)
 *   vacaciones.saldo.ajustar          ajustes, récord, datos y referencia
 *   vacaciones.historial.editar       cargar y corregir el historial
 *   vacaciones.periodo.cortar         recalcular períodos y saldo
 *   vacaciones.reporte.exportar       exportaciones a Excel
 *   vacaciones.configuracion.editar   fecha de corte del historial
 *
 * El alcance se mide con el área ACTUAL de la persona (las solicitudes no
 * congelan el área). Quién aprueba se decide en el momento: con Jefatura «a
 * su cargo», los jefes de la cadena; o quien lo tenga asignado. Nadie
 * resuelve lo propio. Sin nadie con permiso, el superadmin. RRHH gestiona
 * saldos y reportes, pero aprueba sólo si se le asigna «Aprobar».
 */

const KEYS = Object.freeze({
  ACCESO: "vacaciones.acceso",
  CREAR: "vacaciones.solicitud.crear",
  VER: "vacaciones.solicitud.ver",
  APROBAR: "vacaciones.solicitud.aprobar",
  CALENDARIO: "vacaciones.calendario.ver",
  SALDO_VER: "vacaciones.saldo.ver",
  SALDO_AJUSTAR: "vacaciones.saldo.ajustar",
  HISTORIAL: "vacaciones.historial.editar",
  RECALCULAR: "vacaciones.periodo.cortar",
  EXPORTAR: "vacaciones.reporte.exportar",
  CONFIGURAR: "vacaciones.configuracion.editar",
});

function sameId(a, b) {
  return a != null && b != null && Number(a) === Number(b);
}

/** Registro para los alcances: de quién es y su área (actual). */
function recordOf(row) {
  return { ownerId: row.user_id != null ? row.user_id : row.id, areaId: row.work_area_id };
}

function can(perms, key) {
  return Boolean(perms && perms.can(key));
}

function canOn(perms, key, row) {
  return Boolean(perms && perms.canOnRecord(key, recordOf(row)));
}

/** ¿Alcanza más que lo propio? */
function veOtros(perms, key) {
  const c = perms && typeof perms.coverage === "function" ? perms.coverage(key) : null;
  return Boolean(c && (c.all || c.areaIds.length));
}

/** ¿Entra a la gestión de RRHH (solicitudes o saldos de otros)? */
function veGestion(perms) {
  return veOtros(perms, KEYS.VER) || veOtros(perms, KEYS.SALDO_VER);
}

/** ¿Aprueba algo? (bandeja «Aprobar vacaciones»). */
function aprueba(perms) {
  return can(perms, KEYS.APROBAR);
}

/** ¿Puede aprobar o rechazar esta solicitud? */
function puedeRevisar(request, userId, perms) {
  if (!request || sameId(request.user_id, userId)) return false;
  return canOn(perms, KEYS.APROBAR, request);
}

/** Sobre una persona (fila de users o con user_id): ¿la acción vale? */
function sobrePersona(perms, key, persona) {
  return canOn(perms, key, persona);
}

/** Filtro SQL de pendientes que puede aprobar, sin las propias. */
function pendingFilter(perms, userId, firstParam = 1) {
  const params = [userId];
  const f = perms.sqlFilter(KEYS.APROBAR, { ownerColumn: "r.user_id", areaColumn: "u.work_area_id", firstParam: firstParam + 1 });
  params.push(...f.params);
  return { clause: `(r.user_id IS DISTINCT FROM $${firstParam} AND ${f.clause})`, params };
}

/** Filtro SQL de «Ver solicitudes» para la gestión. */
function verFilter(perms, firstParam = 1) {
  return perms.sqlFilter(KEYS.VER, { ownerColumn: "r.user_id", areaColumn: "u.work_area_id", firstParam });
}

module.exports = {
  KEYS,
  recordOf,
  veOtros,
  veGestion,
  aprueba,
  puedeRevisar,
  sobrePersona,
  pendingFilter,
  verFilter,
};
