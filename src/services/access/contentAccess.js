const db = require("../../db");
const { isAdministrador, normalizeRole } = require("../../constants/roles");
const { SLUG_SIN_AREA, GENERAL_AREA } = require("../documents/processDocumentStorage");
const { currentWorkAreaId } = require("./accountStatus");
const { puedeVerDocumento } = require("../documents/processAccess");

/**
 * Quién puede descargar cada archivo de /content.
 *
 * La URL de un archivo no es un secreto: queda en el HTML, en el historial y
 * en las respuestas del asistente. Por eso /content aplica la misma regla
 * que la página donde se publica el archivo:
 *
 *   documentos/<procedimientos|protocolos>/<id de área>/…
 *       → la carpeta de Procesos: su área o un administrador. `sin-area`, sólo
 *         administradores. `general` (reglamento, otros), todos.
 *   gastos/<año>/<id de usuario>/<id de solicitud>_<n>…
 *       → el dueño o quien puede ver la rendición.
 *   tickets_adjuntos/<id de ticket>_…
 *       → quien abrió el ticket, un administrador o la mesa de ayuda.
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
  // Cualquier otra forma bajo gastos/ no es de nadie conocido: nadie más que
  // un administrador la necesita.
  if (path.startsWith("gastos/")) return { kind: "admin_only" };

  const ticket = TICKET_ATTACHMENT.exec(path);
  if (ticket) return { kind: "ticket_attachment", ticketId: Number(ticket[1]) };
  if (path.startsWith("tickets_adjuntos/")) return { kind: "admin_only" };

  return { kind: "open" };
}

/**
 * Regla de la carpeta de Procesos (la misma de GET /procesos/:seccion/:area).
 * `userAreaId` es el área vigente del usuario.
 */
function canOpenAreaFolder({ folder, isAdmin, userAreaId }) {
  if (folder === GENERAL_AREA) return true;
  if (isAdmin) return true;
  if (folder === SLUG_SIN_AREA) return false;
  return userAreaId != null && String(userAreaId) === folder;
}

/**
 * Carpeta que vale para el documento: la de su fila, si la tiene. Un archivo
 * migrado a `sin-area` puede pertenecer hoy a un área (se reasignó después) y
 * el archivo no se movió.
 */
async function documentFolder(relativePath, folder) {
  const row = await documentRow(relativePath);
  if (!row) return folder;
  return row.work_area_id == null ? SLUG_SIN_AREA : String(row.work_area_id);
}

/** Fila de documents, si el archivo está registrado. */
async function documentRow(relativePath) {
  const { rows } = await db.query(
    "SELECT work_area_id, doc_kind, type FROM documents WHERE public_id = $1 LIMIT 1",
    [relativePath],
  );
  return rows[0] || null;
}

async function userAreaIdFor(user) {
  const current = await currentWorkAreaId(user.id);
  return current === undefined ? user.work_area_id ?? null : current;
}

async function canOpenExpenseAttachment(user, { ownerId, requestId }) {
  if (Number(user.id) === ownerId) return true;
  if (requestId == null) return false;

  const { rows } = await db.query(
    `SELECT id, user_id, status, manager_user_id, work_area_id
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

async function canOpenTicketAttachment(user, { ticketId }, isAdmin) {
  if (isAdmin) return true;
  const { rows } = await db.query(
    "SELECT requester_email FROM support_tickets WHERE id = $1",
    [ticketId],
  );
  if (!rows.length) return false;
  if (user.email && rows[0].requester_email === user.email) return true;
  const { isSupportAgent } = require("../tickets/supportTeam");
  return isSupportAgent(user);
}

/**
 * ¿Puede `user` (de sesión) descargar `relativePath`?
 * `perms` y `legacyCtx` los arma /content, que corre antes del middleware
 * de sesión. Sin ellos, la carpeta de Procesos sigue la regla anterior
 * (canOpenAreaFolder) para no dejar la descarga abierta.
 */
async function canAccessContent(user, relativePath, { perms = null, legacyCtx = null } = {}) {
  if (!user) return false;
  const rule = classifyContentPath(relativePath);
  if (rule.kind === "open") return true;

  const isAdmin = isAdministrador(normalizeRole(user.role));
  switch (rule.kind) {
    case "area_document": {
      if (perms && legacyCtx) {
        if (rule.section === "reglamento" || rule.section === "otros" || rule.folder === GENERAL_AREA) {
          return puedeVerDocumento(perms, legacyCtx, { section: rule.section, folder: rule.folder });
        }
        const row = await documentRow(relativePath);
        const folder = row
          ? (row.work_area_id == null ? SLUG_SIN_AREA : String(row.work_area_id))
          : rule.folder;
        return puedeVerDocumento(perms, legacyCtx, { section: rule.section, folder, row });
      }
      if (rule.folder === GENERAL_AREA || isAdmin) return true;
      return canOpenAreaFolder({
        folder: await documentFolder(relativePath, rule.folder),
        isAdmin,
        userAreaId: await userAreaIdFor(user),
      });
    }
    case "expense_attachment":
      // Fases 7 y 8: comprobantes de gastos, con la regla de hoy.
      return canOpenExpenseAttachment(user, rule);
    case "ticket_attachment":
      // Fases 7 y 8: adjuntos de tickets, con la regla de hoy.
      return canOpenTicketAttachment(user, rule, isAdmin);
    case "admin_only":
      // Fases 7 y 8: lo que no calza en una carpeta conocida sigue en el administrador.
      return isAdmin;
    default:
      return false;
  }
}

module.exports = {
  classifyContentPath,
  canOpenAreaFolder,
  canAccessContent,
  puedeVerDocumento,
};
