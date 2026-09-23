/**
 * Copy de vacaciones visible al usuario. Las reglas de negocio viven en las
 * strategies; aquí solo el tono (sin citas legales).
 */

function formatDays(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return String(n);
  return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100);
}

const VACATION_MESSAGES = {
  invalidDates: "Revisa las fechas: alguna no es válida.",
  endBeforeStart: "La fecha de término no puede ser anterior a la de inicio.",
  noDays: "Elige al menos un día.",
  pastDates: "No puedes pedir vacaciones en fechas que ya pasaron.",
  overlap:
    "Esas fechas se cruzan con otra solicitud tuya que aún está activa.",

  minNotice(days) {
    return `Pide tus vacaciones con al menos ${formatDays(days)} días de anticipación.`;
  },
  insufficientBalance(requested, available) {
    return `No te alcanzan los días. Pediste ${formatDays(requested)} y te quedan ${formatDays(available)}.`;
  },
  insufficientPeriod(days) {
    return `No te alcanzan los días de este período para ${formatDays(days)} día(s).`;
  },

  protectedComplement:
    "Si ya usaste parte de tus 15 días seguidos, el resto debe ser de 7 u 8 días juntos.",
  flexibleExhausted:
    "Ya usaste los 15 días que se pueden pedir en tramos cortos. Este pedido no cabe ahí.",
  protectedNotEnough:
    "No te quedan suficientes días del bloque de 15 corridos para este tramo.",
  fractionInvalid:
    "Este tramo no se puede pedir así. Prueba con más días juntos o usa los días sueltos que te quedan.",
  fractionAckRequired:
    "Marca la casilla para confirmar que pides las vacaciones en partes.",
  policyWarning(suggestedMin, days) {
    return `La empresa recomienda pedir al menos ${formatDays(suggestedMin)} días juntos. Tu solicitud de ${formatDays(days)} día(s) igual es válida; confírmalo abajo si quieres continuar.`;
  },
  policyAckRequired:
    "Confirma abajo que leíste la recomendación de la empresa para poder enviar.",

  fractionAckLabel:
    "Confirmo que pido mis vacaciones en partes, no los 30 días seguidos.",
  policyAckLabel:
    "Entiendo la recomendación y quiero continuar con este tramo corto.",

  notEligibleYet:
    "Todavía no cumples un año de servicio, así que aún no tienes días para pedir. Al cumplir el año se te habilitan 30 días.",

  collaboratorNotFound: "No encontramos a ese colaborador.",
  collaboratorDeleted:
    "El colaborador fue eliminado: esta solicitud ya no se puede aprobar, sólo rechazar.",
  noHireDate: "No tienes una fecha de ingreso registrada. Contacta a RRHH.",
  noHireDateInfo:
    "No tienes una fecha de ingreso registrada. Contacta a RRHH para poder calcular tu saldo de vacaciones.",
  requestNotFound:
    "No encontramos esa solicitud. Puede que ya se haya actualizado.",
  onlyPendingApprove:
    "Esta solicitud ya no está pendiente, no se puede aprobar.",
  onlyPendingReject:
    "Esta solicitud ya no está pendiente, no se puede rechazar.",
  insufficientToApprove:
    "El colaborador no tiene días suficientes para aprobar esta solicitud.",
  rejectReasonRequired:
    "Escribe el motivo del rechazo para que el colaborador lo entienda.",
  cancelOthers: "Solo puedes cancelar tus propias solicitudes.",
  cancelAlreadyStarted:
    "Estas vacaciones ya empezaron, no se pueden cancelar.",
  cannotCancel: "Esta solicitud ya no se puede cancelar.",
  incompleteProfile:
    "Falta información de tu perfil para calcular los días. Contacta a RRHH.",

  defaultSuccess: "Listo.",
  requestSent: "Solicitud enviada. Queda pendiente de aprobación.",
  requestCancelled: "Solicitud cancelada.",
  requestApproved: "Solicitud aprobada.",
  requestRejected: "Solicitud rechazada.",
  sendFailed: "No se pudo enviar la solicitud. Inténtalo de nuevo.",
  cancelFailed: "No se pudo cancelar la solicitud. Inténtalo de nuevo.",
  loadMineFailed: "No pudimos cargar tus vacaciones. Inténtalo de nuevo.",
  loadGestionFailed:
    "No pudimos cargar la gestión de vacaciones. Inténtalo de nuevo.",
  loadDetailFailed:
    "No pudimos cargar el detalle del colaborador. Inténtalo de nuevo.",
  loadCalendarFailed: "No pudimos cargar el calendario. Inténtalo de nuevo.",
  loadHolidaysFailed: "No pudimos cargar los feriados. Inténtalo de nuevo.",
  adjustNeedPeriod: "Elige un período y una cantidad de días distinta de cero.",
  adjustNeedReason: "Escribe el motivo del ajuste.",
  adjustFailed: "No se pudo ajustar el saldo. Inténtalo de nuevo.",
  adjustOk: "Saldo ajustado correctamente.",
  recordNeedReason: "Indica el motivo cuando el récord no se cumple.",
  recordFailed: "No se pudo actualizar el récord vacacional. Inténtalo de nuevo.",
  recordOk: "Récord vacacional actualizado.",
  approveFailed: "No se pudo aprobar la solicitud. Inténtalo de nuevo.",
  rejectFailed: "No se pudo rechazar la solicitud. Inténtalo de nuevo.",
  holidayCountry(code) {
    return `Esta instancia solo administra feriados de ${code}.`;
  },
  holidayRequired: "País, fecha y nombre del feriado son obligatorios.",
  holidayAddFailed: "No se pudo agregar el feriado. Inténtalo de nuevo.",
  holidayDeleteFailed: "No se pudo eliminar el feriado. Inténtalo de nuevo.",
  holidayNotFound:
    "No encontramos ese feriado en el calendario de esta instancia.",
  holidayAdded: "Feriado agregado.",
  holidayDeleted: "Feriado eliminado.",
  saldoApiFailed: "No se pudo obtener el saldo.",
  previewFailed: "No se pudieron calcular los días. Inténtalo de nuevo.",
  previewValidateFailed: "No se pudo revisar la solicitud.",

  // --- Historial de vacaciones anteriores a la intranet --------------------
  historyNeedDays: "Indica cuántos días se tomó el colaborador (mayor que 0).",
  historyNeedYear: "Indica el año del período.",
  historyInvalidYear(min) {
    return `El año debe estar entre ${min} y el año en curso.`;
  },
  historyInvalidMonth: "El mes no es válido.",
  historyFutureMonth:
    "Ese mes todavía no llega. Las vacaciones futuras se piden como solicitud, no como historial.",
  historyNeedMonthOrDates:
    "Indica al menos el mes del período, o las fechas exactas si las tienes.",
  historyEndBeforeStart:
    "La fecha de término del período no puede ser anterior a la de inicio.",
  historyDaysMismatch(dateDays, declaredDays) {
    return `Las fechas cubren ${formatDays(dateDays)} día(s) y declaraste ${formatDays(declaredDays)}. Corrige una de las dos.`;
  },
  historyBeforeHire:
    "El período es anterior a la fecha de ingreso del colaborador.",
  historyAfterCutoff(cutoff) {
    return `El período es posterior a la fecha de corte (${cutoff}). A partir del corte las vacaciones se registran como solicitud, no como historial.`;
  },
  historyDuplicateWarning:
    "Ya existe un registro con el mismo trabajador, año, mes y cantidad de días.",
  historyDuplicateInBatch:
    "Hay otra fila igual en esta carga. Si fueron dos salidas distintas, déjalas; si no, quita una.",
  historyBatchEmpty: "Agrega al menos una salida con mes y días.",
  historyBatchHasErrors:
    "Hay filas con errores. Corrígelas: no se guardó ninguna para no dejar la carga a medias.",
  historyBatchTooLarge(max) {
    return `Carga hasta ${max} filas por vez.`;
  },
  historyBatchCreated(count) {
    return `Se registraron ${count} salida(s) y el saldo se recalculó.`;
  },
  historyNeedHireDate:
    "Registra primero la fecha de ingreso: sin ella no hay períodos a los que descontar los días.",
  historyNotFound: "No encontramos ese registro histórico.",
  historyCreated: "Período histórico registrado.",
  historyUpdated: "Período histórico actualizado.",
  historyDeleted: "Período histórico eliminado.",
  historyCreateFailed:
    "No fue posible guardar el período de vacaciones. Inténtalo nuevamente.",
  historyUpdateFailed:
    "No fue posible actualizar el período de vacaciones. Inténtalo nuevamente.",
  historyDeleteFailed:
    "No fue posible eliminar el período de vacaciones. Inténtalo nuevamente.",
  historyLoadFailed:
    "No pudimos cargar el historial de vacaciones. Inténtalo de nuevo.",

  // --- Saldo de referencia (conciliación con el Excel de RR.HH.) -----------
  referenceNeedDate: "Indica la fecha a la que corresponde el saldo.",
  referenceFutureDate: "La fecha del saldo de referencia no puede ser futura.",
  referenceNeedDays: "Indica el saldo en días (puede ser 0 o negativo).",
  referenceNotFound: "No encontramos ese saldo de referencia.",
  referenceSaved: "Saldo de referencia guardado.",
  referenceDeleted: "Saldo de referencia eliminado.",
  referenceFailed: "No se pudo guardar el saldo de referencia. Inténtalo de nuevo.",

  // --- Datos del cálculo (fecha de ingreso y documento) --------------------
  profileNeedHireDate: "Indica una fecha de ingreso válida.",
  profileFutureHireDate: "La fecha de ingreso no puede ser futura.",
  profileNeedReason: "Escribe el motivo del cambio: queda en la bitácora.",
  profileNoChanges: "No hay cambios que guardar.",
  profileDuplicateId: "Ese documento ya está registrado en otro colaborador.",
  profileBlockedPeriods:
    "Con esa fecha de ingreso desaparecerían períodos que ya tienen días aprobados en la intranet o ajustes. Revierte esos movimientos antes de cambiarla.",
  profileHistoryBeforeHire(count, date) {
    return `Hay ${count} salida(s) del historial anteriores al ${date}. Siguen descontándose; revísalas.`;
  },
  profileSaved: "Datos actualizados. Los períodos y el saldo se recalcularon.",
  profileFailed: "No se pudieron actualizar los datos. Inténtalo de nuevo.",
  periodsBlocked:
    "La fecha de ingreso cambió, pero hay períodos con días aprobados en la intranet que ya no calzan con ella. Los períodos no se recalcularon: revisa esas solicitudes o ajustes.",

  // --- Fecha de corte y exportación ----------------------------------------
  cutoffSaved: "Fecha de corte actualizada.",
  cutoffInvalid: "Indica una fecha de corte válida.",
  cutoffFailed: "No se pudo guardar la fecha de corte. Inténtalo de nuevo.",
  exportFailed: "No se pudo generar el archivo. Inténtalo de nuevo.",
  loadReportFailed: "No pudimos cargar el resumen. Inténtalo de nuevo.",
};

module.exports = { VACATION_MESSAGES, formatDays };
