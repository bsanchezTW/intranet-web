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

/** Nueva solicitud → jefe que la aprueba según el organigrama. */
function notifyApprover({ request, user, approver }) {
  if (!approver || !approver.email) return Promise.resolve();
  return safeSend({
    to: approver.email,
    subject: "Solicitud de vacaciones por aprobar",
    senderName: MAIL_SENDERS.hr,
    heading: "Tienes una solicitud de vacaciones por aprobar",
    cta: { href: "/RRHH/vacaciones/aprobaciones", label: "Revisar solicitud" },
    html: `
      <p style="margin:0 0 16px 0;"><strong>${escapeHtml(fullName(user))}</strong> solicitó vacaciones y te toca aprobarlas.</p>
      <p style="margin:0 0 16px 0;">Período: ${rangeText(request)}</p>
      ${request.requester_notes ? `<p style="margin:0 0 16px 0;">Comentario: ${escapeHtml(request.requester_notes)}</p>` : ""}
    `,
    text: `${fullName(user)} solicitó vacaciones (${rangeText(request)}) y te toca aprobarlas.`,
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
    cta: { href: "/RRHH/vacaciones/mis-vacaciones", label: "Ver mis vacaciones" },
    html: `
      <p style="margin:0 0 16px 0;">Hola ${escapeHtml(fullName(user))},</p>
      <p style="margin:0 0 16px 0;">Tu solicitud de vacaciones (${rangeText(request)}) fue <strong>rechazada</strong>.</p>
      <p style="margin:0;">Motivo: ${escapeHtml(request.reviewer_notes || "No especificado")}</p>
    `,
    text: `Tu solicitud de vacaciones (${rangeText(request)}) fue rechazada. Motivo: ${request.reviewer_notes || "No especificado"}.`,
  });
}

/**
 * Aviso manual de días vencidos → colaborador.
 *
 * Lo envía RR.HH. con un botón desde la ficha o el resumen: "vencido" es el
 * saldo de años ya cumplidos que el colaborador todavía no toma. Detalla cada
 * período con su plazo legal (art. 23) y marca los que ya lo pasaron.
 *
 * `periods` son períodos mapeados para la vista (mapVacationPeriodForView).
 * Arma el correo sin enviarlo, para poder probarlo solo.
 */
function buildPendingReminder({ user, summary, periods = [], note = "" }) {
  const pendientes = periods.filter((p) => !p.inProgress && Number(p.available) > 0);
  const fueraDePlazo = pendientes.filter((p) => p.overdue);
  const dias = Number(summary.availableDays);

  const filas = pendientes
    .map((p, i) => {
      const borde = i === 0 ? "border-top:1px solid #e5e7eb;" : "";
      const plazo = p.overdue
        ? `<span style="color:#b42318;font-weight:700;">Fuera de plazo (desde el ${escapeHtml(p.enjoyByFmt || "")})</span>`
        : p.enjoyByFmt
          ? `Tomar antes del ${escapeHtml(p.enjoyByFmt)}`
          : "—";
      return `
        <tr>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;${borde}color:#0f172a;font-size:13px;">Período ${escapeHtml(p.periodLabel)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;${borde}color:#0f172a;font-size:13px;font-weight:700;text-align:right;">${escapeHtml(String(p.available))} día(s)</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;${borde}color:#64748b;font-size:13px;text-align:right;">${plazo}</td>
        </tr>`;
    })
    .join("");

  const nota = String(note || "").trim();
  const avisoPlazo = fueraDePlazo.length
    ? `<p style="margin:0 0 16px 0;color:#b42318;">Parte de estos días ya pasó el plazo legal para gozarlos. Coordina tus fechas con tu jefatura y solicítalos cuanto antes.</p>`
    : "";

  return {
    to: user.email,
    subject: `Tienes ${dias} día(s) de vacaciones vencidos por tomar`,
    senderName: MAIL_SENDERS.hr,
    heading: "Tienes vacaciones vencidas por tomar",
    cta: { href: "/RRHH/vacaciones/mis-vacaciones", label: "Solicitar vacaciones" },
    html: `
      <p style="margin:0 0 16px 0;">Hola ${escapeHtml(fullName(user))},</p>
      <p style="margin:0 0 16px 0;">
        Recursos Humanos te recuerda que tienes <strong>${escapeHtml(String(dias))} día(s) de vacaciones vencidos</strong>:
        son días de años de servicio ya cumplidos que todavía no has tomado y debes tomar.
      </p>
      ${filas ? `<table role="presentation" cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 16px 0;">${filas}</table>` : ""}
      ${avisoPlazo}
      ${nota ? `<p style="margin:0 0 16px 0;">Mensaje de RR.HH.: ${escapeHtml(nota)}</p>` : ""}
      <p style="margin:0;color:#64748b;font-size:13px;">
        Puedes solicitarlos desde la intranet, en «Mis vacaciones».
      </p>
    `,
    text:
      `Hola ${fullName(user)}, tienes ${dias} día(s) de vacaciones vencidos que debes tomar. ` +
      pendientes
        .map((p) => `Período ${p.periodLabel}: ${p.available} día(s)${p.overdue ? " (fuera de plazo legal)" : p.enjoyByFmt ? ` (tomar antes del ${p.enjoyByFmt})` : ""}.`)
        .join(" ") +
      (nota ? ` Mensaje de RR.HH.: ${nota}` : "") +
      " Solicítalos desde la intranet, en «Mis vacaciones».",
  };
}

/**
 * Envía el aviso de días vencidos. A diferencia de las demás notificaciones,
 * aquí el correo ES la operación: si falla, el error sube para que RR.HH. lo vea.
 */
function sendPendingReminder(args) {
  return sendMail(buildPendingReminder(args));
}

module.exports = {
  notifyNewRequest,
  notifyApprover,
  notifyApproved,
  notifyRejected,
  buildPendingReminder,
  sendPendingReminder,
};
