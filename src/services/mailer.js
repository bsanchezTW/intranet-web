// src/services/mailer.js
const Brevo = require("@getbrevo/brevo");
const { getCountryConfig } = require("../config/country");
const { MAIL_SENDERS } = require("../constants/mailSenders");
const { wrapTransactionalHtml } = require("./emailLayout");

const EMAIL_FOOTER_TEXT = `
--------------------------------------------------
Este mensaje se envió de forma automática. No respondas a esta dirección; ingresa a la intranet para continuar.

Intranet Transworld
Transworld Power & Telcom
`;

const apiInstance = new Brevo.TransactionalEmailsApi();
const brevoApiKey = process.env.BREVO_API_KEY || process.env.SMTP_PASS || "";
apiInstance.setApiKey(
  Brevo.TransactionalEmailsApiApiKeys.apiKey,
  brevoApiKey,
);

function resolveMailFrom() {
  return String(getCountryConfig().noReplyEmail || "").trim();
}

function normalizeEmailList(value) {
  if (value == null || value === "") return [];
  const items = Array.isArray(value) ? value : [value];
  const emails = [];
  const seen = new Set();
  for (const item of items) {
    const email = String(item || "").trim().toLowerCase();
    if (!email || seen.has(email)) continue;
    seen.add(email);
    emails.push(email);
  }
  return emails;
}

const sendMail = async ({
  to,
  subject,
  text,
  html,
  bcc,
  skipFooter = false,
  skipLayout = false,
  senderName,
  heading,
  cta,
  preheader,
}) => {
  if (!brevoApiKey) {
    throw new Error(
      "Falta BREVO_API_KEY o SMTP_PASS (API key de Brevo) en las variables de entorno",
    );
  }
  const mailFrom = resolveMailFrom();
  if (!mailFrom) {
    throw new Error(
      "Falta noReplyEmail en la configuración de país (noreply@transworld.cl / .pe)",
    );
  }

  const toList = normalizeEmailList(to);
  if (!toList.length) {
    throw new Error("Falta destinatario para el correo");
  }

  const fromName = senderName || MAIL_SENDERS.intranet;
  const htmlContent = wrapTransactionalHtml({
    html,
    text,
    senderName: fromName,
    heading,
    cta,
    preheader: preheader || heading || subject,
    skipLayout,
  });

  const sendSmtpEmail = new Brevo.SendSmtpEmail();
  sendSmtpEmail.subject = subject;

  if (text) {
    sendSmtpEmail.textContent = skipFooter ? text : text + "\n\n" + EMAIL_FOOTER_TEXT;
  }

  if (htmlContent) {
    sendSmtpEmail.htmlContent = htmlContent;
  }

  sendSmtpEmail.sender = {
    name: fromName,
    email: mailFrom,
  };

  sendSmtpEmail.to = toList.map((email) => ({ email }));

  const bccList = normalizeEmailList(bcc).filter((email) => !toList.includes(email));
  if (bccList.length) {
    sendSmtpEmail.bcc = bccList.map((email) => ({ email }));
  }

  try {
    return await apiInstance.sendTransacEmail(sendSmtpEmail);
  } catch (error) {
    const detail = error?.response?.data || error?.body || error?.message;
    console.error("[Mailer] Error al enviar vía API de Brevo:", detail);
    throw error;
  }
};

module.exports = { sendMail, resolveMailFrom, normalizeEmailList };
