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
};

module.exports = { VACATION_MESSAGES, formatDays };
