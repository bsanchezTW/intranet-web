const { sendMail } = require("../mailer");
const { getCountryConfig, formatMoney } = require("../../config/country");
const {
  expenseKindLabel,
  expenseStageLabel,
} = require("../../constants/expenseStatuses");
const financeTeam = require("./financeTeam");

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
    `<p><strong>Asunto:</strong> ${request.title}</p>`,
    `<p><strong>Monto:</strong> ${formatMoney(request.total_amount)}</p>`,
  ];
  if (request.area_name) {
    parts.push(`<p><strong>Área:</strong> ${request.area_name}</p>`);
  }
  if (request.needed_by) {
    parts.push(
      `<p><strong>Requerido para:</strong> ${new Date(request.needed_by).toLocaleDateString(getCountryConfig().locale)}</p>`,
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
      html: `
        <h3>Hola ${manager.name},</h3>
        <p><strong>${fullName(user)}</strong> envió una solicitud que espera tu aprobación.</p>
        ${summary(request)}
        <p>Revísala en la intranet: ${detailUrl(request)}</p>
      `,
      text: `${fullName(user)} envió una solicitud por ${formatMoney(request.total_amount)} que espera tu aprobación.`,
    });
  }

  const emails = await financeTeam.financeApproverEmails();
  return safeSend({
    to: emails,
    subject: "Solicitud de gastos de una jefatura por aprobar",
    html: `
      <h3>Solicitud pendiente de aprobación administrativa</h3>
      <p><strong>${fullName(user)}</strong> es jefe de su área, así que su solicitud
         no puede autoaprobarse y requiere que la resuelva un administrador.</p>
      ${summary(request)}
      <p>Revísala en la intranet: /gastos/gestion</p>
    `,
    text: `${fullName(user)} (jefe de área) envió una solicitud por ${formatMoney(request.total_amount)}.`,
  });
}

/** Aprobada por la jefatura: pasa a la bandeja de Finanzas. */
async function notifyManagerApproved({ request }) {
  const emails = await financeTeam.financeApproverEmails();
  return safeSend({
    to: emails,
    subject: "Solicitud aprobada por jefatura, pendiente en Finanzas",
    html: `
      <h3>Solicitud aprobada por jefatura</h3>
      <p><strong>${requesterName(request)}</strong> tiene una solicitud aprobada por su jefatura
         y esperando revisión de Finanzas.</p>
      ${summary(request)}
      ${request.manager_notes ? `<p><strong>Comentario de la jefatura:</strong> ${request.manager_notes}</p>` : ""}
      <p>Revísala en la intranet: /gastos/gestion</p>
    `,
    text: `Solicitud de ${requesterName(request)} por ${formatMoney(request.total_amount)} aprobada por jefatura.`,
  });
}

/** Aprobación final de Finanzas → solicitante. */
function notifyFinanceApproved({ request, user }) {
  return safeSend({
    to: user.email,
    subject: "Tu solicitud fue aprobada por Finanzas",
    html: `
      <h3>Hola ${fullName(user)},</h3>
      <p>Tu solicitud fue <strong>aprobada por Finanzas</strong>.</p>
      ${summary(request)}
      ${request.finance_notes ? `<p><strong>Comentario de Finanzas:</strong> ${request.finance_notes}</p>` : ""}
    `,
    text: `Tu solicitud por ${formatMoney(request.total_amount)} fue aprobada por Finanzas.`,
  });
}

/** Rechazo en cualquiera de las dos etapas → solicitante, con el motivo. */
function notifyRejected({ request, user, stage }) {
  const notes =
    stage === "finance" ? request.finance_notes : request.manager_notes;
  return safeSend({
    to: user.email,
    subject: "Tu solicitud fue rechazada",
    html: `
      <h3>Hola ${fullName(user)},</h3>
      <p>Tu solicitud fue <strong>rechazada</strong> en la etapa de ${expenseStageLabel(stage)}.</p>
      ${summary(request)}
      ${notes ? `<p><strong>Motivo:</strong> ${notes}</p>` : ""}
      <p>Puedes corregirla y volver a enviarla desde la intranet.</p>
    `,
    text: `Tu solicitud por ${formatMoney(request.total_amount)} fue rechazada en ${expenseStageLabel(stage)}.`,
  });
}

module.exports = {
  notifyNewRequest,
  notifyManagerApproved,
  notifyFinanceApproved,
  notifyRejected,
};
