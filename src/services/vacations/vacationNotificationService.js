const { sendMail } = require("../mailer");
const { VACATION_CONFIG } = require("../../constants/vacationConfig");
const { formatDisplay } = require("../../utils/vacationDateUtils");
const { requestDays } = require("./vacationRequestService");

/**
 * Notificaciones por correo del módulo de vacaciones.
 * Nunca bloquean la operación: todos los envíos van con .catch.
 */

function fullName(user) {
  return [user.first_name, user.last_name].filter(Boolean).join(" ") || "Colaborador";
}

function rangeText(request) {
  return `${formatDisplay(request.start_date)} al ${formatDisplay(request.end_date)} (${requestDays(request)} día(s))`;
}

function safeSend(payload) {
  return sendMail(payload).catch((err) =>
    console.error("[Vacaciones] Error enviando correo:", err.message),
  );
}

/** Nueva solicitud → RRHH. Opcional: alerta de acumulación CL. */
function notifyNewRequest({ request, user, accumulationAlert = false }) {
  if (!VACATION_CONFIG.rrhhEmail) return Promise.resolve();
  const accumulationNote = accumulationAlert
    ? "<p><strong>Alerta:</strong> el colaborador acumula 2 o más períodos con saldo sin gozar (Chile).</p>"
    : "";
  return safeSend({
    to: VACATION_CONFIG.rrhhEmail,
    subject: accumulationAlert
      ? "Nueva solicitud de vacaciones — alerta de acumulación"
      : "Nueva solicitud de vacaciones",
    html: `
      <h3>Nueva solicitud de vacaciones</h3>
      <p><strong>${fullName(user)}</strong> solicitó vacaciones.</p>
      <p>Período: ${rangeText(request)}</p>
      ${request.requester_notes ? `<p>Comentario: ${request.requester_notes}</p>` : ""}
      ${accumulationNote}
      <p>Revisa la solicitud en la intranet: /RRHH/vacaciones/gestion</p>
    `,
    text: `${fullName(user)} solicitó vacaciones: ${rangeText(request)}.`,
  });
}

/** Solicitud aprobada → colaborador. */
function notifyApproved({ request, user }) {
  // Sin usuario (colaborador eliminado) no hay a quién avisar.
  if (!user || !user.email) return Promise.resolve();
  return safeSend({
    to: user.email,
    subject: "Tu solicitud de vacaciones fue aprobada",
    html: `
      <h3>Hola ${fullName(user)},</h3>
      <p>Tu solicitud de vacaciones fue <strong>aprobada</strong>.</p>
      <p>Período: ${rangeText(request)}</p>
      ${request.reviewer_notes ? `<p>Comentario de RRHH: ${request.reviewer_notes}</p>` : ""}
    `,
    text: `Tu solicitud de vacaciones (${rangeText(request)}) fue aprobada.`,
  });
}

/** Solicitud rechazada → colaborador (incluye motivo). */
function notifyRejected({ request, user }) {
  if (!user || !user.email) return Promise.resolve();
  return safeSend({
    to: user.email,
    subject: "Tu solicitud de vacaciones fue rechazada",
    html: `
      <h3>Hola ${fullName(user)},</h3>
      <p>Tu solicitud de vacaciones (${rangeText(request)}) fue <strong>rechazada</strong>.</p>
      <p>Motivo: ${request.reviewer_notes || "No especificado"}</p>
    `,
    text: `Tu solicitud de vacaciones (${rangeText(request)}) fue rechazada. Motivo: ${request.reviewer_notes || "No especificado"}.`,
  });
}

module.exports = {
  notifyNewRequest,
  notifyApproved,
  notifyRejected,
};
