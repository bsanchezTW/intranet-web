const db = require("../../db");
const { SLUG_SIN_AREA, GENERAL_AREA } = require("../documents/processDocumentStorage");
const { puedeVerDocumento } = require("../documents/processAccess");
const { sameEmail } = require("../../utils/email");

/**
 * Quién puede descargar cada archivo de /content.
 *
 * La URL de un archivo no es un secreto: queda en el HTML, en el historial y
 * en las respuestas del asistente. Por eso /content aplica la misma regla
 * que la página donde se publica el archivo:
 *
 *   documentos/<procedimientos|protocolos>/<id de área>/…
 *       → quien puede ver esa carpeta en Gestión de Permisos (puedeVerDocumento).
 *   gastos/<año>/<id de usuario>/<id de solicitud>_<n>…
 *       → el dueño o quien puede ver la rendición.
 *   tickets_adjuntos/<id de ticket>_…
 *       → quien puede ver ese ticket (soporte.ticket.ver).
 *   otra forma bajo gastos/ o tickets_adjuntos/
 *       → nadie: no corresponde a ningún registro.
 *   logistica/…
 *       → nadie por /content: las fotos de daños y las capturas de la
 *         revisión física las entrega /logistica, que revisa su permiso.
 *
 * El resto (noticias, eventos, apps, cursos, fotos de perfil) es contenido
 * para toda la intranet y basta con la sesión.
 */

const AREA_DOCUMENT = /^documentos\/(procedimientos|protocolos|reglamento|otros)\/([^/]+)\//;
const EXPENSE_ATTACHMENT = /^gastos\/\d{4}\/(\d+)\/(\d+_)?[^/]+$/;
const TICKET_ATTACHMENT = /^tickets_adjuntos\/(\d+)_[^/]+$/;

/** Qué regla le toca a una ruta ya normalizada. Pura. */
function classifyContentPath(relativePath) {
  const path = String(relativePath || "");

  const doc = AREA_DOCUMENT.exec(path);
  if (doc) return { kind: "area_document", section: doc[1], folder: doc[2] };

  const expense = EXPENSE_ATTACHMENT.exec(path);
  if (expense) {
    return {
      kind: "expense_attachment",
      ownerId: Number(expense[1]),
      requestId: expense[2] ? Number(expense[2].slice(0, -1)) : null,
    };
  }
  // Cualquier otra forma bajo gastos/ o tickets_adjuntos/ no es de ningún
  // registro conocido: no se sirve.
  if (path.startsWith("gastos/")) return { kind: "unmatched" };

  const ticket = TICKET_ATTACHMENT.exec(path);
  if (ticket) return { kind: "ticket_attachment", ticketId: Number(ticket[1]) };
  if (path.startsWith("tickets_adjuntos/")) return { kind: "unmatched" };

  if (path.startsWith("logistica/")) return { kind: "module_only" };

  return { kind: "open" };
}

/** Fila de documents, si el archivo está registrado. */
async function documentRow(relativePath) {
  const { rows } = await db.query(
    "SELECT work_area_id, doc_kind, type FROM documents WHERE public_id = $1 LIMIT 1",
    [relativePath],
  );
  return rows[0] || null;
}

async function canOpenExpenseAttachment(user, { ownerId, requestId }) {
  if (Number(user.id) === ownerId) return true;
  if (requestId == null) return false;

  const { rows } = await db.query(
    `SELECT id, user_id, status, manager_user_id, work_area_id, kind,
            manager_reviewed_by, finance_reviewed_by, settled_by, settled_at
       FROM expense_requests WHERE id = $1`,
    [requestId],
  );
  const request = rows[0];
  // El archivo vive en la carpeta del dueño: si la solicitud es de otro, el
  // nombre no corresponde y no se sirve.
  if (!request || Number(request.user_id) !== ownerId) return false;

  // Carga perezosa: el servicio de gastos arrastra media aplicación.
  const { canViewRequest } = require("../expenses/expenseRequestService");
  return canViewRequest(request, user);
}

/** Adjunto de ticket: quien puede ver ese ticket (soporte.ticket.ver, lo propio o todo). */
async function canOpenTicketAttachment(user, { ticketId }) {
  const permissions = require("../permissions/permissionService");
  const perms = await permissions.resolve(user);
  const c = perms.coverage("soporte.ticket.ver");
  if (!c) return false;
  if (c.all) return true;
  const { rows } = await db.query(
    "SELECT requester_email FROM support_tickets WHERE id = $1",
    [ticketId],
  );
  return rows.length > 0 && c.own && sameEmail(rows[0].requester_email, user.email);
}

/**
 * ¿Puede `user` (de sesión) descargar `relativePath`?
 * `perms` lo arma /content, que corre antes del middleware de permisos; sin
 * él se resuelven aquí.
 */
async function canAccessContent(user, relativePath, { perms = null } = {}) {
  if (!user) return false;
  const rule = classifyContentPath(relativePath);
  if (rule.kind === "open") return true;

  switch (rule.kind) {
    case "area_document": {
      const efectivos = perms || (await require("../permissions/permissionService").resolve(user));
      if (rule.section === "reglamento" || rule.section === "otros" || rule.folder === GENERAL_AREA) {
        return puedeVerDocumento(efectivos, { section: rule.section, folder: rule.folder });
      }
      // Vale la carpeta de su fila: un archivo migrado a `sin-area` puede
      // pertenecer hoy a un área (se reasignó después) y no se movió.
      const row = await documentRow(relativePath);
      const folder = row
        ? (row.work_area_id == null ? SLUG_SIN_AREA : String(row.work_area_id))
        : rule.folder;
      return puedeVerDocumento(efectivos, { section: rule.section, folder, row });
    }
    case "expense_attachment":
      return canOpenExpenseAttachment(user, rule);
    case "ticket_attachment":
      return canOpenTicketAttachment(user, rule);
    case "module_only":
      // Lo sirve su módulo (con su permiso), nunca /content.
      return false;
    default:
      // unmatched y cualquier forma desconocida.
      return false;
  }
}

module.exports = {
  classifyContentPath,
  canAccessContent,
  puedeVerDocumento,
};
