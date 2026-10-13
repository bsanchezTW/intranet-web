const db = require("../../db");
const fileStorage = require("../fileStorage");
const { sendMail } = require("../mailer");
const { MAIL_SENDERS } = require("../../constants/mailSenders");
const { escapeHtml } = require("../emailLayout");
const { UPLOAD_LIMITS_BYTES } = require("../../config/uploadLimits");
const { ticketCategoryLabel } = require("../../constants/ticketCategories");
const { supportAgentEmails } = require("./supportTeam");
const { ticketStatusFromDb } = require("../../utils/schemaMappers");
const { ticketModalUrl } = require("../../utils/ticketRedirect");
const {
  attachmentKind,
  attachmentFileName,
  replyAttachmentFileName,
  isAllowedAttachment,
  validateAttachmentFiles,
  validateTicketInput,
} = require("./ticketRules");

/**
 * Alta de tickets de Soporte y sus adjuntos.
 *
 * Una sola implementación para el modal de la intranet y para el asistente:
 * ambos validan igual, guardan igual y avisan a Soporte con el mismo correo.
 * Los archivos llegan con el formulario y se suben recién cuando el ticket
 * existe, con el nombre <N° de ticket>_1, _2…
 */

const ATTACHMENT_FOLDER = "tickets_adjuntos";
const MAX_MB = Math.round(UPLOAD_LIMITS_BYTES.TICKET_ATTACHMENT / (1024 * 1024));

/** Sólo enlaces http(s) en el correo: nada de javascript: ni data:. */
function safeHttpUrl(url) {
  const raw = String(url || "").trim();
  return /^https?:\/\//i.test(raw) ? raw : "#";
}

function parseAttachments(adjuntosJSON) {
  try {
    const list = adjuntosJSON ? JSON.parse(adjuntosJSON) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Correo en texto plano con la lista de adjuntos. */
function ticketMailText(mensaje, adjuntosJSON) {
  let texto = mensaje;
  const archivos = parseAttachments(adjuntosJSON);
  if (archivos.length > 0) {
    texto += `\n\n--- Adjuntos ---`;
    archivos.forEach((a) => {
      texto += `\n[${a.tipo}]: ${a.nombre} -> ${a.url}`;
    });
  }
  return texto;
}

/**
 * Correo HTML con la lista de adjuntos (el marco visual lo pone el mailer).
 * El mensaje lo escribe el usuario: se escapa para que no pueda meter enlaces
 * ni HTML con la apariencia oficial del correo.
 */
function ticketMailHtml(mensaje, adjuntosJSON) {
  let html = `<p style="margin:0 0 16px 0;">${escapeHtml(mensaje).replace(/\r?\n/g, "<br>")}</p>`;

  const archivos = parseAttachments(adjuntosJSON);
  if (archivos.length > 0) {
    html += `<div style="margin:20px 0 0 0; padding:16px; background-color:#f5f7fa; border:1px solid #e3e9f0; border-radius:10px;">`;
    html += `<p style="font-weight:700; margin:0 0 10px 0; color:#0b3a63;">Archivos adjuntos</p>`;
    html += `<ul style="list-style-type:none; padding:0; margin:0;">`;

    archivos.forEach((a) => {
      let label = "Archivo";
      if (a.tipo === "image") label = "Imagen";
      if (a.tipo === "video") label = "Video";

      html += `<li style="margin:0 0 8px 0;">
        <strong>[${label}]</strong>
        <a href="${escapeHtml(safeHttpUrl(a.url))}" target="_blank" style="color:#0f4c81; text-decoration:underline; font-weight:700;">
          ${escapeHtml(a.nombre || "Ver archivo")}
        </a>
      </li>`;
    });

    html += `</ul></div>`;
  }

  return html;
}

/** Nombre y correo del solicitante, desde la ficha y no desde el cliente. */
async function requesterFor(user) {
  const { rows } = await db.query(
    "SELECT first_name, last_name, email FROM users WHERE id = $1",
    [user.id],
  );
  const row = rows[0];
  if (row) {
    const name = [row.first_name, row.last_name].filter(Boolean).join(" ");
    return { name: name || row.email, email: row.email };
  }
  // El login de emergencia (id 0) no existe en `users`.
  return {
    name: user.nombre || user.username || "Usuario",
    email: user.email || user.username || null,
  };
}

/** Avisa al equipo de Informática. Si no hay correos, no se envía. */
async function notifyTicketTeam({ subject, text, html, heading, cta }) {
  const emails = await supportAgentEmails();
  if (!emails.length) {
    console.warn(
      "[Tickets] No hay usuarios de Informática con correo para notificar.",
    );
    return;
  }
  return sendMail({
    to: emails,
    subject,
    text,
    html,
    heading,
    cta,
    senderName: MAIL_SENDERS.support,
  }).catch(console.error);
}

function notifyNewTicket({ id, ticket, requester, adjuntosJSON }) {
  const mensaje =
    `Ticket generado por ${requester.name}\n\n` +
    `Título: ${ticket.title}\n\n` +
    `Categoría: ${ticketCategoryLabel(ticket.category)}\n\n` +
    `Descripción: ${ticket.description}`;
  notifyTicketTeam({
    subject: `Nuevo ticket #${id} — ${ticket.title}`,
    heading: "Nuevo ticket",
    cta: { href: ticketModalUrl(id), label: "Ver ticket" },
    text: ticketMailText(mensaje, adjuntosJSON),
    html: ticketMailHtml(mensaje, adjuntosJSON),
  });
}

/**
 * Sube los archivos de un ticket recién creado. Un archivo que falla no anula
 * el ticket: se informa para que el usuario lo agregue después.
 */
async function uploadTicketFiles(ticketId, files) {
  const attachments = [];
  const failed = [];
  for (const [index, file] of files.entries()) {
    const fileName = attachmentFileName(ticketId, index + 1, file.originalname);
    try {
      const saved = await fileStorage.saveFileAs(file.buffer, ATTACHMENT_FOLDER, fileName, {
        contentType: file.mimetype,
      });
      attachments.push({
        url: saved.secure_url,
        nombre: file.originalname,
        tipo: attachmentKind(file.mimetype, file.originalname),
      });
    } catch (err) {
      console.error(`[Tickets] No se pudo subir ${fileName}:`, err.message);
      failed.push(file.originalname);
    }
  }
  return { attachments, failed };
}

/**
 * Crea un ticket a nombre del usuario de sesión, sube sus archivos y avisa a
 * Soporte. `files` son los archivos que entrega multer (en memoria).
 * @returns {Promise<{ ok: true, id, ticket, attachments, failedAttachments } | { ok: false, error }>}
 */
async function createSupportTicket({ user, files = [], ...input }) {
  const validation = validateTicketInput(input);
  if (!validation.ok) return validation;
  const filesCheck = validateAttachmentFiles(files, { maxBytes: UPLOAD_LIMITS_BYTES.TICKET_ATTACHMENT });
  if (!filesCheck.ok) return filesCheck;

  const { ticket } = validation;
  const requester = await requesterFor(user);
  const { rows } = await db.queryRetryIdCollision(
    `INSERT INTO support_tickets (title, description, category, priority, status, requester_name, requester_email, attachments, read_by_admin, read_by_user)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, '[]', FALSE, TRUE)
     RETURNING id`,
    [ticket.title, ticket.description, ticket.category, ticket.priority, requester.name, requester.email],
  );
  const id = rows[0].id;

  const { attachments, failed } = await uploadTicketFiles(id, files);
  const adjuntosJSON = JSON.stringify(attachments);
  if (attachments.length) {
    await db.query("UPDATE support_tickets SET attachments = $1 WHERE id = $2", [adjuntosJSON, id]);
  }

  notifyNewTicket({ id, ticket, requester, adjuntosJSON });
  return { ok: true, id, ticket, attachments, failedAttachments: failed };
}

/** El id que tendrá la próxima respuesta de este ticket (MAX + 1). */
async function nextReplyOrdinal(ticketId) {
  const { rows } = await db.query(
    "SELECT COALESCE(MAX(id), 0)::int + 1 AS n FROM ticket_replies WHERE ticket_id = $1",
    [ticketId],
  );
  return rows[0]?.n || 1;
}

/**
 * Sube un archivo de una respuesta. El nombre es
 * <N° de ticket>_<id de la respuesta>_<n>.<ext>; el id lo asigna el trigger
 * correlativo del hilo. `anyType` admite planillas y texto, como el formulario.
 * @returns {Promise<{ ok: true, attachment, publicId } | { ok: false, error }>}
 */
async function saveTicketAttachment(file, { anyType = false, ticketId, fileIndex } = {}) {
  if (!file || !file.buffer || !file.buffer.length) {
    return { ok: false, error: "No se recibió el archivo." };
  }
  if (!anyType && !isAllowedAttachment(file.mimetype, file.originalname)) {
    return { ok: false, error: "Tipo de archivo no permitido. Usa imágenes, videos, PDF o Word." };
  }
  if (file.size > UPLOAD_LIMITS_BYTES.TICKET_ATTACHMENT) {
    return { ok: false, error: `El archivo supera el máximo de ${MAX_MB} MB.` };
  }

  const id = Number(ticketId);
  const index = Number(fileIndex);
  if (!Number.isSafeInteger(id) || id <= 0) {
    return { ok: false, error: "Falta el número de ticket para nombrar el adjunto." };
  }
  if (!Number.isSafeInteger(index) || index <= 0) {
    return { ok: false, error: "Falta el correlativo del archivo en la respuesta." };
  }

  const replyOrdinal = await nextReplyOrdinal(id);
  const fileName = replyAttachmentFileName(id, replyOrdinal, index, file.originalname);
  const saved = await fileStorage.saveFileAs(file.buffer, ATTACHMENT_FOLDER, fileName, {
    contentType: file.mimetype,
  });
  return {
    ok: true,
    publicId: saved.public_id,
    attachment: {
      url: saved.secure_url,
      nombre: file.originalname,
      tipo: attachmentKind(file.mimetype, file.originalname),
    },
  };
}

/** Tickets no cerrados del usuario, los más recientes primero. */
async function listOpenTicketsForUser(user, { limit = 5 } = {}) {
  const email = user && (user.email || user.username);
  if (!email) return [];
  const { rows } = await db.query(
    `SELECT id, title, category, status
       FROM support_tickets
      WHERE requester_email = $1 AND status <> 'closed'
      ORDER BY created_at DESC
      LIMIT $2`,
    [email, limit],
  );
  return rows.map((row) => ({
    id: row.id,
    titulo: row.title,
    categoria: ticketCategoryLabel(row.category),
    estado: ticketStatusFromDb(row.status),
    enlace: ticketModalUrl(row.id),
  }));
}

module.exports = {
  ticketMailText,
  ticketMailHtml,
  createSupportTicket,
  saveTicketAttachment,
  listOpenTicketsForUser,
  notifyTicketTeam,
};
