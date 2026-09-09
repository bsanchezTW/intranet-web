const db = require("../../db");
const {
  EXPENSE_STATUS,
  EXPENSE_KIND,
  EXPENSE_STAGE,
  isExpenseKind,
} = require("../../constants/expenseStatuses");
const { isAdministrador, normalizeRole } = require("../../constants/roles");
const { isIdPrimaryKeyCollision } = require("../../utils/idCollision");
const { currentCurrencyCode } = require("./expenseSchema");
const areaManager = require("./areaManager");
const financeTeam = require("./financeTeam");

/**
 * Reglas del centro de gastos.
 *
 * Igual que vacationRequestService, estas funciones devuelven { ok, error } en
 * vez de lanzar: la ruta traduce el error a un flash y nunca a un 500. Los
 * cambios de estado toman SELECT ... FOR UPDATE porque dos aprobaciones
 * simultáneas sobre la misma solicitud son perfectamente posibles (el jefe
 * desde la bandeja y un administrador desde el detalle).
 */

const MAX_ITEMS = 50;
const MAX_ATTACHMENTS = 10;

// ---------------------------------------------------------------------------
// Normalización de entrada
// ---------------------------------------------------------------------------

function parseAmount(value) {
  // El formulario manda "45.000" o "45000,50" según cómo teclee el usuario.
  // Se descartan separadores de miles y se acepta la coma como decimal.
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/\s/g, "")
    .replace(/\.(?=\d{3}\b)/g, "")
    .replace(",", ".");
  const n = Number(normalized);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100) / 100;
}

function parseText(value, maxLength) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!text) return null;
  return text.slice(0, maxLength);
}

function parseDate(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  return raw;
}

/**
 * Valida el desglose. El total NUNCA se toma del cliente: se recalcula aquí,
 * porque el formulario lo muestra sólo como conveniencia y un POST a mano
 * podría enviar cualquier cifra.
 */
function normalizeItems(rawItems) {
  if (!Array.isArray(rawItems)) return { ok: false, error: "Falta el desglose." };
  const items = [];

  for (const raw of rawItems.slice(0, MAX_ITEMS)) {
    const detail = parseText(raw && raw.detail, 300);
    const amount = parseAmount(raw && raw.amount);
    // Una fila totalmente vacía es la última del formulario, no un error.
    if (!detail && amount === null) continue;
    if (!detail) return { ok: false, error: "Cada ítem necesita un detalle." };
    if (amount === null) {
      return { ok: false, error: `El monto de «${detail}» no es válido.` };
    }
    items.push({ detail, amount, itemDate: parseDate(raw && raw.item_date) });
  }

  if (!items.length) {
    return { ok: false, error: "Agrega al menos un ítem al desglose." };
  }

  const total = items.reduce((sum, item) => sum + item.amount, 0);
  if (total <= 0) {
    return { ok: false, error: "El total debe ser mayor que cero." };
  }

  return { ok: true, items, total: Math.round(total * 100) / 100 };
}

function normalizeAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments)) return [];
  return rawAttachments
    .slice(0, MAX_ATTACHMENTS)
    .map((raw) => ({
      name: parseText(raw && raw.name, 200) || "Comprobante",
      url: String((raw && raw.url) || "").trim(),
      publicId: String((raw && raw.public_id) || "").trim() || null,
    }))
    .filter((a) => a.url.startsWith("/content/"));
}

// ---------------------------------------------------------------------------
// Creación
// ---------------------------------------------------------------------------

async function createRequest({
  user,
  kind,
  title,
  description,
  items: rawItems,
  attachments: rawAttachments,
  neededBy,
}) {
  if (!isExpenseKind(kind)) {
    return { ok: false, error: "Tipo de solicitud inválido." };
  }

  const parsedTitle = parseText(title, 200);
  if (!parsedTitle) {
    return { ok: false, error: "El asunto es obligatorio." };
  }

  const context = await areaManager.getUserAreaContext(user.id);
  if (!context.area) {
    return {
      ok: false,
      error: "No tienes un área asignada. Pídele a RRHH que te asigne una.",
    };
  }

  const approver = await areaManager.resolveApprover(user.id, context.area.id);
  if (!approver.ok) return approver;

  const normalized = normalizeItems(rawItems);
  if (!normalized.ok) return normalized;

  const attachments = normalizeAttachments(rawAttachments);
  if (kind === EXPENSE_KIND.RENDICION && !attachments.length) {
    return {
      ok: false,
      error: "Una rendición necesita al menos un comprobante adjunto.",
    };
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    // queryRetryIdCollision no acepta un client, así que el reintento del ID
    // aleatorio de 6 dígitos se hace aquí sobre la misma transacción.
    const inserted = await insertRequestWithRetry(client, {
      kind,
      userId: user.id,
      areaId: context.area.id,
      title: parsedTitle,
      description: parseText(description, 4000),
      currency: currentCurrencyCode(),
      total: normalized.total,
      neededBy: kind === EXPENSE_KIND.FONDOS ? parseDate(neededBy) : null,
      managerId: approver.managerId,
    });

    const requestId = inserted.id;

    await client.query(
      `INSERT INTO expense_request_items (request_id, item_date, detail, amount, sort_order)
       SELECT $1, d, det, amt, ord
         FROM UNNEST($2::date[], $3::text[], $4::numeric[], $5::int[])
           AS t(d, det, amt, ord)`,
      [
        requestId,
        normalized.items.map((i) => i.itemDate),
        normalized.items.map((i) => i.detail),
        normalized.items.map((i) => i.amount),
        normalized.items.map((_, index) => index),
      ],
    );

    if (attachments.length) {
      await client.query(
        `INSERT INTO expense_request_attachments (request_id, name, url, public_id)
         SELECT $1, n, u, p
           FROM UNNEST($2::text[], $3::text[], $4::text[]) AS t(n, u, p)`,
        [
          requestId,
          attachments.map((a) => a.name),
          attachments.map((a) => a.url),
          attachments.map((a) => a.publicId),
        ],
      );
    }

    await client.query("COMMIT");
    return {
      ok: true,
      request: inserted,
      requiresAdmin: approver.requiresAdmin,
      manager: approver.manager,
      area: context.area,
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * INSERT con reintento por colisión del ID aleatorio de 6 dígitos.
 *
 * db.queryRetryIdCollision no sirve aquí porque no acepta un client, y el
 * INSERT tiene que ir dentro de la misma transacción que los ítems. El
 * SAVEPOINT es imprescindible: en Postgres un error aborta la transacción
 * entera, así que sin él el segundo intento fallaría con "current transaction
 * is aborted".
 */
async function insertRequestWithRetry(client, data, maxAttempts = 8) {
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await client.query("SAVEPOINT insert_expense");
    try {
      const { rows } = await client.query(
        `INSERT INTO expense_requests
           (kind, user_id, work_area_id, title, description,
            currency_code, total_amount, needed_by, manager_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING *`,
        [
          data.kind,
          data.userId,
          data.areaId,
          data.title,
          data.description,
          data.currency,
          data.total,
          data.neededBy,
          data.managerId,
        ],
      );
      await client.query("RELEASE SAVEPOINT insert_expense");
      return rows[0];
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT insert_expense");
      if (!isIdPrimaryKeyCollision(err) || attempt === maxAttempts - 1) throw err;
    }
  }
  throw new Error("No fue posible generar un ID para la solicitud.");
}

// ---------------------------------------------------------------------------
// Transiciones de estado
// ---------------------------------------------------------------------------

/**
 * ¿Puede este usuario resolver la solicitud en su etapa actual?
 * Devuelve la etapa ('manager' | 'finance') o null.
 */
async function reviewerStageFor(request, user) {
  const isAdmin = isAdministrador(normalizeRole(user.role));

  if (request.status === EXPENSE_STATUS.PENDING) {
    // Solicitud del propio jefe del área: sólo un administrador la destraba.
    if (request.manager_user_id == null) {
      return isAdmin ? EXPENSE_STAGE.MANAGER : null;
    }
    if (Number(request.manager_user_id) === Number(user.id)) {
      return EXPENSE_STAGE.MANAGER;
    }
    return isAdmin ? EXPENSE_STAGE.MANAGER : null;
  }

  if (request.status === EXPENSE_STATUS.APPROVED_MANAGER) {
    return (await financeTeam.isFinanceApprover(user))
      ? EXPENSE_STAGE.FINANCE
      : null;
  }

  return null;
}

async function transition(requestId, user, { approve, notes }) {
  const id = Number(requestId);
  if (!Number.isInteger(id)) {
    return { ok: false, error: "Solicitud inválida." };
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      "SELECT * FROM expense_requests WHERE id = $1 FOR UPDATE",
      [id],
    );
    const request = rows[0];
    if (!request) {
      await client.query("ROLLBACK");
      return { ok: false, error: "La solicitud no existe." };
    }

    const stage = await reviewerStageFor(request, user);
    if (!stage) {
      await client.query("ROLLBACK");
      return {
        ok: false,
        error: "Esta solicitud no está esperando tu aprobación.",
      };
    }

    const reviewerNotes = parseText(notes, 2000);
    if (!approve && !reviewerNotes) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Indica el motivo del rechazo." };
    }

    const nextStatus = !approve
      ? EXPENSE_STATUS.REJECTED
      : stage === EXPENSE_STAGE.MANAGER
        ? EXPENSE_STATUS.APPROVED_MANAGER
        : EXPENSE_STATUS.APPROVED_FINANCE;

    const columnPrefix = stage === EXPENSE_STAGE.MANAGER ? "manager" : "finance";
    const { rows: updated } = await client.query(
      `UPDATE expense_requests
          SET status                 = $1,
              ${columnPrefix}_reviewed_by = $2,
              ${columnPrefix}_reviewed_at = NOW(),
              ${columnPrefix}_notes       = $3,
              rejected_stage         = $4,
              updated_at             = NOW()
        WHERE id = $5
        RETURNING *`,
      [nextStatus, user.id, reviewerNotes, approve ? null : stage, id],
    );

    await client.query("COMMIT");
    return { ok: true, request: updated[0], stage };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function approveRequest({ requestId, reviewer, notes }) {
  return transition(requestId, reviewer, { approve: true, notes });
}

function rejectRequest({ requestId, reviewer, notes }) {
  return transition(requestId, reviewer, { approve: false, notes });
}

/** Anular: sólo el dueño y sólo mientras nadie la ha resuelto. */
async function cancelRequest({ requestId, user }) {
  const id = Number(requestId);
  if (!Number.isInteger(id)) {
    return { ok: false, error: "Solicitud inválida." };
  }

  const { rows } = await db.query(
    `UPDATE expense_requests
        SET status = $1, updated_at = NOW()
      WHERE id = $2 AND user_id = $3 AND status = $4
      RETURNING *`,
    [EXPENSE_STATUS.CANCELLED, id, user.id, EXPENSE_STATUS.PENDING],
  );
  if (!rows.length) {
    return {
      ok: false,
      error: "Sólo puedes anular tus solicitudes que siguen pendientes.",
    };
  }
  return { ok: true, request: rows[0] };
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const LIST_SELECT = `
  SELECT r.*,
         w.area_name,
         w.color            AS area_color,
         u.first_name       AS requester_first_name,
         u.last_name        AS requester_last_name,
         u.email            AS requester_email,
         (SELECT COUNT(*)::int FROM expense_request_items i WHERE i.request_id = r.id)       AS item_count,
         (SELECT COUNT(*)::int FROM expense_request_attachments a WHERE a.request_id = r.id) AS attachment_count
    FROM expense_requests r
    LEFT JOIN work_areas w ON w.id = r.work_area_id
    JOIN users u ON u.id = r.user_id`;

async function listForUser(userId) {
  const { rows } = await db.query(
    `${LIST_SELECT} WHERE r.user_id = $1 ORDER BY r.created_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * Lo que este revisor debe resolver ahora.
 * Un administrador de Finanzas ve además las solicitudes de los propios jefes
 * (las que nacen sin manager_user_id), que si no quedarían sin destino.
 */
async function listPendingForReviewer(user) {
  const isAdmin = isAdministrador(normalizeRole(user.role));
  const isFinance = await financeTeam.isFinanceApprover(user);

  const { rows } = await db.query(
    `${LIST_SELECT}
      WHERE (r.status = $1 AND r.manager_user_id = $2)
         OR (r.status = $1 AND r.manager_user_id IS NULL AND $3)
         OR (r.status = $4 AND $5)
      ORDER BY r.created_at ASC`,
    [
      EXPENSE_STATUS.PENDING,
      user.id,
      isAdmin,
      EXPENSE_STATUS.APPROVED_MANAGER,
      isFinance,
    ],
  );
  return rows;
}

/** Todo lo que ya pasó por este revisor, más lo que gestiona su área. */
async function listHistoryForReviewer(user) {
  const isAdmin = isAdministrador(normalizeRole(user.role));
  const isFinance = await financeTeam.isFinanceApprover(user);
  const managedAreaIds = await areaManager.listManagedAreaIds(user.id);

  const { rows } = await db.query(
    `${LIST_SELECT}
      WHERE r.manager_reviewed_by = $1
         OR r.finance_reviewed_by = $1
         OR r.work_area_id = ANY($2::int[])
         OR $3
         OR ($4 AND r.status <> $5)
      ORDER BY r.created_at DESC
      LIMIT 500`,
    [
      user.id,
      managedAreaIds,
      isAdmin,
      isFinance,
      EXPENSE_STATUS.PENDING,
    ],
  );
  return rows;
}

async function getRequestDetail(requestId) {
  const id = Number(requestId);
  if (!Number.isInteger(id)) return null;

  const [requestResult, itemsResult, attachmentsResult] = await Promise.all([
    db.query(
      `${LIST_SELECT}
         WHERE r.id = $1`,
      [id],
    ),
    db.query(
      `SELECT id, item_date, detail, amount
         FROM expense_request_items
        WHERE request_id = $1
        ORDER BY sort_order ASC, id ASC`,
      [id],
    ),
    db.query(
      `SELECT id, name, url, public_id
         FROM expense_request_attachments
        WHERE request_id = $1
        ORDER BY id ASC`,
      [id],
    ),
  ]);

  const request = requestResult.rows[0];
  if (!request) return null;

  return {
    ...request,
    items: itemsResult.rows,
    attachments: attachmentsResult.rows,
  };
}

/** ¿Puede este usuario ver el detalle de esta solicitud? */
async function canViewRequest(request, user) {
  if (Number(request.user_id) === Number(user.id)) return true;
  if (isAdministrador(normalizeRole(user.role))) return true;
  if (Number(request.manager_user_id) === Number(user.id)) return true;
  if (await financeTeam.isFinanceApprover(user)) return true;
  const managedAreaIds = await areaManager.listManagedAreaIds(user.id);
  return managedAreaIds.includes(Number(request.work_area_id));
}

/** Contador para el badge de "Gestión de solicitudes". */
async function countPendingForReviewer(user) {
  try {
    return (await listPendingForReviewer(user)).length;
  } catch {
    return 0;
  }
}

module.exports = {
  createRequest,
  approveRequest,
  rejectRequest,
  cancelRequest,
  reviewerStageFor,
  listForUser,
  listPendingForReviewer,
  listHistoryForReviewer,
  getRequestDetail,
  canViewRequest,
  countPendingForReviewer,
  // exportados para tests
  parseAmount,
  normalizeItems,
  normalizeAttachments,
};
