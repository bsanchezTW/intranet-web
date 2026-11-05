const { EXPENSE_STATUS, EXPENSE_STAGE, EXPENSE_KIND } = require("../../constants/expenseStatuses");

/**
 * Quién hace qué en Fondos y rendiciones, con Gestión de Permisos. Pura:
 * recibe los permisos efectivos (`perms`, de resolver.js) y la fila.
 *
 *   gastos.solicitud.aprobar_jefatura   primera etapa, con alcance sobre el
 *                                       área congelada en la solicitud
 *   gastos.solicitud.aprobar_finanzas   segunda etapa
 *   gastos.solicitud.liquidar           cerrar el saldo de una rendición
 *   gastos.solicitud.ver                historial y detalle de otros
 *   gastos.solicitud.campo.cuenta_bancaria  ver la cuenta de destino
 *
 * Quién aprueba se decide en el momento, no queda fijado al crear: con
 * Jefatura «a su cargo» aprueban los jefes de la cadena; con el permiso
 * asignado a alguien, esa persona. El jefe guardado en la solicitud
 * (manager_user_id) queda sólo como dato. Sin nadie con permiso, el
 * superadmin (que lo tiene todo).
 *
 * Reglas que no dependen de los permisos: nadie resuelve ni liquida lo
 * propio, y la misma persona no firma las dos etapas.
 *
 * El RUT del solicitante no tiene permiso propio: lo ven quien pidió y
 * quienes pueden aprobar o rechazar la solicitud en alguna etapa.
 */

const KEYS = Object.freeze({
  ACCESO: "gastos.acceso",
  CREAR: "gastos.solicitud.crear",
  VER: "gastos.solicitud.ver",
  JEFATURA: "gastos.solicitud.aprobar_jefatura",
  FINANZAS: "gastos.solicitud.aprobar_finanzas",
  LIQUIDAR: "gastos.solicitud.liquidar",
  CUENTA: "gastos.solicitud.campo.cuenta_bancaria",
});

const COLUMNS = Object.freeze({ ownerColumn: "r.user_id", areaColumn: "r.work_area_id" });

function sameId(a, b) {
  return a != null && b != null && Number(a) === Number(b);
}

/** Registro para los alcances: de quién es y el área congelada al enviar. */
function recordOf(request) {
  return { ownerId: request.user_id, areaId: request.work_area_id };
}

function can(perms, key) {
  return Boolean(perms && perms.can(key));
}

function canOn(perms, key, request) {
  return Boolean(perms && perms.canOnRecord(key, recordOf(request)));
}

/** ¿Ve más que lo propio? (alcance de «Ver solicitudes» más allá de «lo propio»). */
function veOtras(perms) {
  const c = perms && typeof perms.coverage === "function" ? perms.coverage(KEYS.VER) : null;
  return Boolean(c && (c.all || c.areaIds.length));
}

/** ¿Tiene algo que hacer en «Gestión de solicitudes»? */
function esRevisor(perms) {
  return can(perms, KEYS.JEFATURA) || can(perms, KEYS.FINANZAS) || can(perms, KEYS.LIQUIDAR) || veOtras(perms);
}

/** ¿Es de Finanzas a efectos de la gestión (fondos vencidos, por liquidar)? */
function esFinanzas(perms) {
  return can(perms, KEYS.FINANZAS) || can(perms, KEYS.LIQUIDAR);
}

/** Etapa que este usuario puede resolver ahora ('manager' | 'finance') o null. */
function reviewerStage(request, userId, perms) {
  if (!request || sameId(request.user_id, userId)) return null;
  if (request.status === EXPENSE_STATUS.PENDING) {
    return canOn(perms, KEYS.JEFATURA, request) ? EXPENSE_STAGE.MANAGER : null;
  }
  if (request.status === EXPENSE_STATUS.APPROVED_MANAGER) {
    if (sameId(request.manager_reviewed_by, userId)) return null; // no firma las dos etapas
    return canOn(perms, KEYS.FINANZAS, request) ? EXPENSE_STAGE.FINANCE : null;
  }
  return null;
}

/** ¿Puede liquidar esta rendición? */
function puedeLiquidar(request, userId, perms) {
  return Boolean(
    request &&
      request.kind === EXPENSE_KIND.RENDICION &&
      request.status === EXPENSE_STATUS.APPROVED_FINANCE &&
      !request.settled_at &&
      !sameId(request.user_id, userId) &&
      canOn(perms, KEYS.LIQUIDAR, request),
  );
}

/** ¿Podría aprobarla o rechazarla en alguna etapa? (para el RUT). */
function puedeAprobarAlguna(request, userId, perms) {
  if (!request || sameId(request.user_id, userId)) return false;
  return canOn(perms, KEYS.JEFATURA, request) || canOn(perms, KEYS.FINANZAS, request);
}

/** ¿Ve el detalle? El dueño, quien la ve por alcance, quien puede resolverla o ya la firmó. */
function puedeVer(request, userId, perms) {
  if (!request) return false;
  const esDueno = sameId(request.user_id, userId);
  if (request.status === EXPENSE_STATUS.DRAFT) return esDueno;
  return (
    esDueno ||
    canOn(perms, KEYS.VER, request) ||
    puedeAprobarAlguna(request, userId, perms) ||
    canOn(perms, KEYS.LIQUIDAR, request) ||
    sameId(request.manager_reviewed_by, userId) ||
    sameId(request.finance_reviewed_by, userId) ||
    sameId(request.settled_by, userId)
  );
}

function veDocumento(request, userId, perms) {
  return sameId(request && request.user_id, userId) || puedeAprobarAlguna(request, userId, perms);
}

function veCuenta(request, userId, perms) {
  return sameId(request && request.user_id, userId) || Boolean(perms && perms.canSeeField(KEYS.CUENTA));
}

/** Quita de la fila lo que este usuario no debe ver (antes de pasarla a la vista). */
function ocultarSensibles(request, userId, perms) {
  if (!request) return request;
  const out = { ...request };
  if (!veDocumento(request, userId, perms)) {
    out.requester_document = null;
    out.requester_document_display = null;
  }
  if (!veCuenta(request, userId, perms)) {
    out.bank_code = null;
    out.bank_name = null;
    out.bank_account_type = null;
    out.bank_account_number = null;
  }
  return out;
}

/**
 * Filtro SQL de «por resolver»: pendientes de jefatura con alcance y
 * aprobadas por jefatura con alcance de Finanzas, nunca las propias ni las
 * que el mismo firmó en la primera etapa. Parámetros desde `firstParam`.
 */
function pendingFilter(perms, userId, firstParam = 1) {
  const params = [userId, EXPENSE_STATUS.PENDING, EXPENSE_STATUS.APPROVED_MANAGER];
  const me = `$${firstParam}`;
  const pend = `$${firstParam + 1}`;
  const aprobJef = `$${firstParam + 2}`;
  const jef = perms.sqlFilter(KEYS.JEFATURA, { ...COLUMNS, firstParam: firstParam + params.length });
  params.push(...jef.params);
  const fin = perms.sqlFilter(KEYS.FINANZAS, { ...COLUMNS, firstParam: firstParam + params.length });
  params.push(...fin.params);
  return {
    clause: `(r.user_id IS DISTINCT FROM ${me} AND (
        (r.status = ${pend} AND ${jef.clause})
        OR (r.status = ${aprobJef} AND r.manager_reviewed_by IS DISTINCT FROM ${me} AND ${fin.clause})))`,
    params,
  };
}

/** Historial de la gestión: lo que ve por alcance o ya firmó, sin borradores ni lo propio. */
function historyFilter(perms, userId, firstParam = 1) {
  const params = [userId];
  const me = `$${firstParam}`;
  const ver = perms.sqlFilter(KEYS.VER, { ...COLUMNS, firstParam: firstParam + params.length });
  params.push(...ver.params);
  return {
    clause: `(r.user_id IS DISTINCT FROM ${me} AND (
        r.manager_reviewed_by = ${me} OR r.finance_reviewed_by = ${me} OR r.settled_by = ${me}
        OR ${ver.clause}))`,
    params,
  };
}

/** Rendiciones por liquidar que alcanza, sin las propias. */
function settleFilter(perms, userId, firstParam = 1) {
  const params = [userId];
  const liq = perms.sqlFilter(KEYS.LIQUIDAR, { ...COLUMNS, firstParam: firstParam + 1 });
  params.push(...liq.params);
  return { clause: `(r.user_id IS DISTINCT FROM $${firstParam} AND ${liq.clause})`, params };
}

module.exports = {
  KEYS,
  recordOf,
  esRevisor,
  esFinanzas,
  reviewerStage,
  puedeLiquidar,
  puedeAprobarAlguna,
  puedeVer,
  veDocumento,
  veCuenta,
  ocultarSensibles,
  pendingFilter,
  historyFilter,
  settleFilter,
};
