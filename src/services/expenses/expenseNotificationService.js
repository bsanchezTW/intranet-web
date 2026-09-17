const { sendMail } = require("../mailer");
const { MAIL_SENDERS } = require("../../constants/mailSenders");
const { escapeHtml } = require("../emailLayout");
const { formatMoney } = require("../../config/country");
const {
  expenseKindLabel,
  expenseStageLabel,
} = require("../../constants/expenseStatuses");
const financeTeam = require("./financeTeam");
const { fundBalance } = require("./expenseFundService");

/**
 * Notificaciones por correo del centro de gastos.
 * Nunca bloquean la operación: todos los envíos van con .catch, igual que en
 * vacationNotificationService. Una aprobación no puede fallar porque Brevo esté
 * caído o porque falten credenciales en el entorno local.
 */

function fullName(user) {
  return (
    [user.first_name, user.last_name].filter(Boolean).join(" ") || "Colaborador"
  );
}

function requesterName(request) {
  return (
    [request.requester_first_name, request.requester_last_name]
      .filter(Boolean)
      .join(" ") || "Un colaborador"
  );
}

function safeSend(payload) {
  if (!payload.to || (Array.isArray(payload.to) && !payload.to.length)) {
    return Promise.resolve();
  }
  return sendMail(payload).catch((err) =>
    console.error("[Gastos] Error enviando correo:", err.message),
  );
}

function detailUrl(request) {
  return `/gastos/${request.id}`;
}

function summary(request) {
  const parts = [
    `<p><strong>Tipo:</strong> ${expenseKindLabel(request.kind)}</p>`,
    `<p><strong>Asunto:</strong> ${escapeHtml(request.title)}</p>`,
    `<p><strong>Monto:</strong> ${formatMoney(request.total_amount)}</p>`,
  ];
  if (request.area_name) {
    parts.push(`<p><strong>Área:</strong> ${escapeHtml(request.area_name)}</p>`);
  }
  if (request.kind === "rendicion") {
    parts.push(
      request.fund_request_id
        ? `<p><strong>Rinde la solicitud de fondos:</strong> #${request.fund_request_id} (${formatMoney(request.assigned_amount)})</p>`
        : "<p><strong>Rinde:</strong> sin fondo (reembolso)</p>",
    );
  }
  return parts.join("\n");
}

/**
 * Solicitud recién enviada.
 * Si el solicitante es el jefe del área, la solicitud nace sin aprobador y la
 * resuelve un administrador: en ese caso se avisa a Finanzas, que es quien
 * tiene la bandeja a la vista.
 */
async function notifyNewRequest({ request, user, manager }) {
  if (manager && manager.email) {
    return safeSend({
      to: manager.email,
      subject: `Nueva ${expenseKindLabel(request.kind).toLowerCase()} por aprobar`,
      senderName: MAIL_SENDERS.finance,
      heading: `Nueva ${expenseKindLabel(request.kind).toLowerCase()} por aprobar`,
      cta: { href: detailUrl(request), label: "Revisar solicitud" },
      html: `
        <p style="margin:0 0 16px 0;">Hola ${escapeHtml(manager.name)},</p>
        <p style="margin:0 0 16px 0;"><strong>${escapeHtml(fullName(user))}</strong> envió una solicitud que espera tu aprobación.</p>
        ${summary(request)}
      `,
      text: `${fullName(user)} envió una solicitud por ${formatMoney(request.total_amount)} que espera tu aprobación.`,
    });
  }

  const emails = await financeTeam.financeApproverEmails();
  return safeSend({
    to: emails,
    subject: "Solicitud de gastos de una jefatura por aprobar",
    senderName: MAIL_SENDERS.finance,
    heading: "Solicitud de jefatura por aprobar",
    cta: { href: "/gastos/gestion", label: "Ir a gestión de gastos" },
    html: `
      <p style="margin:0 0 16px 0;"><strong>${escapeHtml(fullName(user))}</strong> es jefe de su área, así que su solicitud
         no puede autoaprobarse y requiere que la resuelva un administrador.</p>
      ${summary(request)}
    `,
    text: `${fullName(user)} (jefe de área) envió una solicitud por ${formatMoney(request.total_amount)}.`,
  });
}

/** Aprobada por la jefatura: pasa a la bandeja de Finanzas. */
async function notifyManagerApproved({ request }) {
  const emails = await financeTeam.financeApproverEmails();
  return safeSend({
    to: emails,
    subject: "Solicitud aprobada por jefatura, pendiente de revisión",
    senderName: MAIL_SENDERS.finance,
    heading: "Aprobada por jefatura",
    cta: { href: "/gastos/gestion", label: "Ir a gestión de gastos" },
    html: `
      <p style="margin:0 0 16px 0;"><strong>${escapeHtml(requesterName(request))}</strong> tiene una solicitud aprobada por su jefatura
         y esperando revisión de Finanzas.</p>
      ${summary(request)}
      ${request.manager_notes ? `<p style="margin:16px 0 0 0;"><strong>Comentario de la jefatura:</strong> ${escapeHtml(request.manager_notes)}</p>` : ""}
    `,
    text: `Solicitud de ${requesterName(request)} por ${formatMoney(request.total_amount)} aprobada por jefatura.`,
  });
}

/** Aprobación final de Finanzas → solicitante. */
function notifyFinanceApproved({ request, user }) {
  // Colaborador eliminado: la solicitud sigue su curso, pero no hay a quién avisar.
  if (!user) return Promise.resolve();
  return safeSend({
    to: user.email,
    subject: "Tu solicitud fue aprobada por Finanzas",
    senderName: MAIL_SENDERS.finance,
    heading: "Solicitud aprobada",
    cta: { href: detailUrl(request), label: "Ver solicitud" },
    html: `
      <p style="margin:0 0 16px 0;">Hola ${escapeHtml(fullName(user))},</p>
      <p style="margin:0 0 16px 0;">Tu solicitud fue <strong>aprobada por Finanzas</strong>.</p>
      ${summary(request)}
      ${request.finance_notes ? `<p style="margin:16px 0 0 0;"><strong>Comentario de Finanzas:</strong> ${escapeHtml(request.finance_notes)}</p>` : ""}
    `,
    text: `Tu solicitud por ${formatMoney(request.total_amount)} fue aprobada por Finanzas.`,
  });
}

/** Rechazo en cualquiera de las dos etapas → solicitante, con el motivo. */
function notifyRejected({ request, user, stage }) {
  if (!user) return Promise.resolve();
  const notes =
    stage === "finance" ? request.finance_notes : request.manager_notes;
  return safeSend({
    to: user.email,
    subject: "Tu solicitud fue rechazada",
    senderName: MAIL_SENDERS.finance,
    heading: "Solicitud rechazada",
    cta: { href: detailUrl(request), label: "Ver solicitud" },
    html: `
      <p style="margin:0 0 16px 0;">Hola ${escapeHtml(fullName(user))},</p>
      <p style="margin:0 0 16px 0;">Tu solicitud fue <strong>rechazada</strong> en la etapa de ${expenseStageLabel(stage)}.</p>
      ${summary(request)}
      ${notes ? `<p style="margin:16px 0 0 0;"><strong>Motivo:</strong> ${escapeHtml(notes)}</p>` : ""}
      <p style="margin:16px 0 0 0;">Puedes corregirla y volver a enviarla desde la intranet.</p>
    `,
    text: `Tu solicitud por ${formatMoney(request.total_amount)} fue rechazada en ${expenseStageLabel(stage)}.`,
  });
}

/** Finanzas liquidó la rendición: el saldo ya se devolvió o se pagó. */
function notifySettled({ request, user }) {
  if (!user) return Promise.resolve();
  const balance = fundBalance(request.total_amount, request.assigned_amount);
  const detalle =
    balance.sentido === "devolver"
      ? `Finanzas registró tu devolución de ${formatMoney(balance.monto)}.`
      : `Finanzas registró el pago de ${formatMoney(balance.monto)} a tu favor.`;
  return safeSend({
    to: user.email,
    subject: "Tu rendición fue liquidada",
    senderName: MAIL_SENDERS.finance,
    heading: "Rendición liquidada",
    cta: { href: detailUrl(request), label: "Ver rendición" },
    html: `
      <p style="margin:0 0 16px 0;">Hola ${escapeHtml(fullName(user))},</p>
      <p style="margin:0 0 16px 0;">Tu rendición <strong>#${request.id}</strong> quedó <strong>liquidada</strong>. ${detalle}</p>
      ${summary(request)}
      ${request.settlement_notes ? `<p style="margin:16px 0 0 0;"><strong>Comentario de Finanzas:</strong> ${escapeHtml(request.settlement_notes)}</p>` : ""}
    `,
    text: `Tu rendición #${request.id} fue liquidada. ${detalle}`,
  });
}

module.exports = {
  notifyNewRequest,
  notifyManagerApproved,
  notifyFinanceApproved,
  notifyRejected,
  notifySettled,
};
