const { sendMail } = require("../mailer");
const { MAIL_SENDERS } = require("../../constants/mailSenders");
const { escapeHtml } = require("../emailLayout");
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
    senderName: MAIL_SENDERS.hr,
    heading: accumulationAlert
      ? "Nueva solicitud — alerta de acumulación"
      : "Nueva solicitud de vacaciones",
    cta: { href: "/RRHH/vacaciones/gestion", label: "Revisar solicitud" },
    html: `
      <p style="margin:0 0 16px 0;"><strong>${escapeHtml(fullName(user))}</strong> solicitó vacaciones.</p>
      <p style="margin:0 0 16px 0;">Período: ${rangeText(request)}</p>
      ${request.requester_notes ? `<p style="margin:0 0 16px 0;">Comentario: ${escapeHtml(request.requester_notes)}</p>` : ""}
      ${accumulationNote}
    `,
    text: `${fullName(user)} solicitó vacaciones: ${rangeText(request)}.`,
  });
}

/**
 * Constancia de vacaciones aprobadas → colaborador.
 *
 * Reemplaza el formato en papel que RR.HH. imprimía y hacía firmar: la
 * aceptación es la propia solicitud enviada desde la intranet, y el correo
 * queda como respaldo con el detalle y el saldo que le queda. Por eso lleva
 * número de solicitud y fechas completas, no solo un aviso.
 */
function approvalDetailTable({ request, balance }) {
  const filas = [
    ["N° de solicitud", `#${request.id}`],
    ["Desde", formatDisplay(request.start_date)],
    ["Hasta", formatDisplay(request.end_date)],
    ["Días de descanso", `${requestDays(request)} día(s) calendario`],
  ];
  if (balance && Number.isFinite(Number(balance.availableDays))) {
    filas.push(["Saldo restante", `${balance.availableDays} día(s)`]);
  }

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px 0;">
      ${filas
        .map(
          ([etiqueta, valor], i) => `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:13px;${i === 0 ? "border-top:1px solid #e5e7eb;" : ""}">${escapeHtml(etiqueta)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;color:#0f172a;font-size:13px;font-weight:700;text-align:right;${i === 0 ? "border-top:1px solid #e5e7eb;" : ""}">${escapeHtml(valor)}</td>
        </tr>`,
        )
        .join("")}
    </table>`;
}

function notifyApproved({ request, user, balance = null }) {
  // Sin usuario (colaborador eliminado) no hay a quién avisar.
  if (!user || !user.email) return Promise.resolve();
  return safeSend({
    to: user.email,
    subject: `Vacaciones aprobadas — solicitud #${request.id}`,
    senderName: MAIL_SENDERS.hr,
    heading: "Constancia de vacaciones aprobadas",
    cta: { href: "/RRHH/vacaciones/mis-vacaciones", label: "Ver mis vacaciones" },
    html: `
      <p style="margin:0 0 16px 0;">Hola ${escapeHtml(fullName(user))},</p>
      <p style="margin:0 0 16px 0;">
        Recursos Humanos <strong>aprobó</strong> tu solicitud de vacaciones. Este correo
        es tu constancia: guárdalo.
      </p>
      ${approvalDetailTable({ request, balance })}
      ${request.reviewer_notes ? `<p style="margin:0 0 16px 0;">Comentario de RR.HH.: ${escapeHtml(request.reviewer_notes)}</p>` : ""}
      <p style="margin:0;color:#64748b;font-size:13px;">
        Si necesitas cambiar estas fechas, cancela la solicitud en la intranet
        antes del día de inicio y crea una nueva.
      </p>
    `,
    text:
      `Tu solicitud de vacaciones #${request.id} fue aprobada. ` +
      `Del ${formatDisplay(request.start_date)} al ${formatDisplay(request.end_date)}, ` +
      `${requestDays(request)} día(s) calendario.`,
  });
}

/** Solicitud rechazada → colaborador (incluye motivo). */
function notifyRejected({ request, user }) {
  if (!user || !user.email) return Promise.resolve();
  return safeSend({
    to: user.email,
    subject: "Tu solicitud de vacaciones fue rechazada",
    senderName: MAIL_SENDERS.hr,
    heading: "Solicitud rechazada",
    cta: { href: "/RRHH/vacaciones/mis_vacaciones", label: "Ver mis vacaciones" },
    html: `
      <p style="margin:0 0 16px 0;">Hola ${escapeHtml(fullName(user))},</p>
      <p style="margin:0 0 16px 0;">Tu solicitud de vacaciones (${rangeText(request)}) fue <strong>rechazada</strong>.</p>
      <p style="margin:0;">Motivo: ${escapeHtml(request.reviewer_notes || "No especificado")}</p>
    `,
    text: `Tu solicitud de vacaciones (${rangeText(request)}) fue rechazada. Motivo: ${request.reviewer_notes || "No especificado"}.`,
  });
}

module.exports = {
  notifyNewRequest,
  notifyApproved,
  notifyRejected,
};
