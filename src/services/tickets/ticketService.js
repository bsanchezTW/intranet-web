const db = require("../../db");
const fileStorage = require("../fileStorage");
const { sendMail } = require("../mailer");
const { getCountryConfig } = require("../../config/country");
const { UPLOAD_LIMITS_BYTES } = require("../../config/uploadLimits");
const { ticketCategoryLabel } = require("../../constants/ticketCategories");
const { ticketStatusFromDb } = require("../../utils/schemaMappers");
const {
  attachmentKind,
  isAllowedAttachment,
  validateTicketInput,
} = require("./ticketRules");

/**
 * Alta de tickets de Soporte y sus adjuntos.
 *
 * Una sola implementación para el modal de la intranet y para el asistente:
 * ambos validan igual, guardan igual y avisan a Soporte con el mismo correo.
 */

const ATTACHMENT_FOLDER = "tickets_adjuntos";
const MAX_MB = Math.round(UPLOAD_LIMITS_BYTES.TICKET_ATTACHMENT / (1024 * 1024));

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

/** Correo HTML con la lista de adjuntos. */
function ticketMailHtml(mensaje, adjuntosJSON) {
  const previewText = mensaje.replace(/\n/g, " ").substring(0, 130) + "...";

  let html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin: 0; padding: 0; background-color: #ffffff;">

  <div style="display: none; max-height: 0px; overflow: hidden; opacity: 0; font-size: 0px; line-height: 0px; color: #ffffff;">
    ${previewText}
  </div>

  <div style="font-family: Arial, sans-serif; color: #333; line-height: 1.5; max-width: 650px; margin: 0 auto; padding: 15px;">
    <p>${mensaje.replace(/\n/g, "<br>")}</p>`;

  const archivos = parseAttachments(adjuntosJSON);
  if (archivos.length > 0) {
    html += `<div style="margin-top: 20px; padding: 15px; background-color: #f8f9fa; border: 1px solid #e9ecef; border-radius: 5px;">`;
    html += `<p style="font-weight: bold; margin-top: 0; margin-bottom: 10px;">Archivos Adjuntos:</p>`;
    html += `<ul style="list-style-type: none; padding: 0; margin: 0;">`;

    archivos.forEach((a) => {
      let label = "Archivo";
      if (a.tipo === "image") label = "Imagen";
      if (a.tipo === "video") label = "Video";

      html += `<li style="margin-bottom: 8px;">
        <strong>[${label}]:</strong>
        <a href="${a.url}" target="_blank" style="color: #0056b3; text-decoration: underline; font-weight: bold;">
          ${a.nombre || "Ver archivo"}
        </a>
      </li>`;
    });

    html += `</ul></div>`;
  }

  html += `
  </div>
</body>
</html>`;
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

function notifyNewTicket({ id, ticket, requester, adjuntosJSON }) {
  if (!process.env.ADMIN_NOTIFY_EMAIL) return;
  const mensaje =
    `Ticket generado por ${requester.name}\n\n` +
    `Título: ${ticket.title}\n\n` +
    `Categoría: ${ticketCategoryLabel(ticket.category)}\n\n` +
    `Descripción: ${ticket.description}`;
  sendMail({
    to: process.env.ADMIN_NOTIFY_EMAIL,
    subject: `Nuevo Ticket #${id}: ${ticket.title}`,
    text: ticketMailText(mensaje, adjuntosJSON),
    html: ticketMailHtml(mensaje, adjuntosJSON),
    bcc: getCountryConfig().supportEmail,
  }).catch(console.error);
}

/**
 * Crea un ticket a nombre del usuario de sesión y avisa a Soporte.
 * @returns {Promise<{ ok: true, id, ticket } | { ok: false, error }>}
 */
async function createSupportTicket({ user, ...input }) {
  const validation = validateTicketInput(input);
  if (!validation.ok) return validation;

  const { ticket } = validation;
  const requester = await requesterFor(user);
  const adjuntosJSON = JSON.stringify(ticket.attachments);

  const { rows } = await db.queryRetryIdCollision(
    `INSERT INTO support_tickets (title, description, category, priority, status, requester_name, requester_email, attachments, read_by_admin, read_by_user)
     VALUES ($1, $2, $3, $4, 'open', $5, $6, $7, FALSE, TRUE)
     RETURNING id`,
    [ticket.title, ticket.description, ticket.category, ticket.priority, requester.name, requester.email, adjuntosJSON],
  );

  const id = rows[0].id;
  notifyNewTicket({ id, ticket, requester, adjuntosJSON });
  return { ok: true, id, ticket };
}

/**
 * Sube un archivo a la carpeta de adjuntos de tickets.
 * `anyType` conserva el comportamiento de las respuestas de Soporte, que no
 * restringían el tipo.
 * @returns {Promise<{ ok: true, attachment, publicId } | { ok: false, error }>}
 */
async function saveTicketAttachment(file, { anyType = false } = {}) {
  if (!file || !file.buffer || !file.buffer.length) {
    return { ok: false, error: "No se recibió el archivo." };
  }
  if (!anyType && !isAllowedAttachment(file.mimetype, file.originalname)) {
    return { ok: false, error: "Tipo de archivo no permitido. Usa imágenes, videos, PDF o Word." };
  }
  if (file.size > UPLOAD_LIMITS_BYTES.TICKET_ATTACHMENT) {
    return { ok: false, error: `El archivo supera el máximo de ${MAX_MB} MB.` };
  }

  const saved = await fileStorage.saveFile(file.buffer, ATTACHMENT_FOLDER, file.originalname);
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
    enlace: `/sistemas/tickets/${row.id}`,
  }));
}

module.exports = {
  ticketMailText,
  ticketMailHtml,
  createSupportTicket,
  saveTicketAttachment,
  listOpenTicketsForUser,
};
