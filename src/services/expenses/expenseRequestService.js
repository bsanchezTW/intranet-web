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
const costCenters = require("../costCenters/costCenterService");
const { formatNationalId } = require("../../utils/nationalId");
const { getDocumentConfig } = require("../../config/country");
const {
  MAX_LODGING_DAYS,
  isExpenseCategory,
  categoryRequiresDays,
} = require("../../constants/expenseCategories");
const bankAccounts = require("./bankAccountService");
const funds = require("./expenseFundService");

/**
 * Reglas del centro de gastos.
 *
 * Igual que vacationRequestService, estas funciones devuelven { ok, error } en
 * vez de lanzar: la ruta traduce el error a un flash y nunca a un 500. Los
 * cambios de estado toman SELECT ... FOR UPDATE porque dos aprobaciones
 * simultáneas sobre la misma solicitud son perfectamente posibles (el jefe
 * desde la bandeja y un administrador desde el detalle).
 *
 * Borradores: una solicitud en estado 'draft' es privada de su dueño, se valida
 * con manga ancha (se guarda lo que haya) y sólo al enviarla pasa por las
 * reglas completas, se congela la ficha y se resuelve el aprobador.
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

function parseDays(value) {
  const raw = String(value ?? "").trim();
  if (!/^\d{1,3}$/.test(raw)) return null;
  const n = Number(raw);
  return n >= 1 && n <= MAX_LODGING_DAYS ? n : null;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
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
    const category = String((raw && raw.category) || "").trim();
    // Una fila totalmente vacía es la última del formulario, no un error.
    if (!detail && amount === null && !category) continue;
    if (!detail) return { ok: false, error: "Cada ítem necesita un detalle." };
    if (amount === null) {
      return { ok: false, error: `El monto de «${detail}» no es válido.` };
    }
    if (!isExpenseCategory(category)) {
      return { ok: false, error: `Elige la categoría de «${detail}».` };
    }

    // Los días sólo tienen sentido en hospedaje; en cualquier otra categoría se
    // descartan aunque el cliente los mande.
    let days = null;
    if (categoryRequiresDays(category)) {
      days = parseDays(raw && raw.days);
      if (!days) {
        return {
          ok: false,
          error: `Indica cuántos días de hospedaje cubre «${detail}» (entre 1 y ${MAX_LODGING_DAYS}).`,
        };
      }
    }

    items.push({
      detail,
      amount,
      category,
      days,
      itemDate: parseDate(raw && raw.item_date),
    });
  }

  if (!items.length) {
    return { ok: false, error: "Agrega al menos un ítem al desglose." };
  }

  const total = items.reduce((sum, item) => sum + item.amount, 0);
  if (total <= 0) {
    return { ok: false, error: "El total debe ser mayor que cero." };
  }

  return { ok: true, items, total: roundMoney(total) };
}

/**
 * Desglose de un borrador: se conserva toda línea con algo escrito, aunque esté
 * a medias. Lo que no valida se guarda vacío —el detalle como '' y el monto
 * como NULL, no 0, para que al retomarlo se vea tal como quedó— y
 * normalizeItems lo exigirá al enviar.
 */
function normalizeDraftItems(rawItems) {
  if (!Array.isArray(rawItems)) return { items: [], total: 0 };
  const items = [];

  for (const raw of rawItems.slice(0, MAX_ITEMS)) {
    const detail = parseText(raw && raw.detail, 300);
    const amount = parseAmount(raw && raw.amount);
    const rawCategory = String((raw && raw.category) || "").trim();
    const category = isExpenseCategory(rawCategory) ? rawCategory : null;
    const itemDate = parseDate(raw && raw.item_date);
    if (!detail && amount === null && !category && !itemDate) continue;

    items.push({
      detail: detail || "",
      amount,
      category,
      days: categoryRequiresDays(category) ? parseDays(raw && raw.days) : null,
      itemDate,
    });
  }

  const total = items.reduce((sum, item) => sum + (item.amount || 0), 0);
  return { items, total: roundMoney(total) };
}

/**
 * Período de gastos, opcional. Si el formulario no lo trae (o trae sólo un
 * extremo), se completa con las fechas del desglose, igual que en el cliente.
 * Sin fechas en ningún lado queda vacío: una suscripción no tiene período.
 */
function normalizePeriod(rawStart, rawEnd, items) {
  let start = parseDate(rawStart);
  let end = parseDate(rawEnd);

  const dates = (items || [])
    .map((item) => item.itemDate)
    .filter(Boolean)
    .sort();
  if (!start && dates.length) start = dates[0];
  if (!end && dates.length) end = dates[dates.length - 1];
  if (start && !end) end = start;
  if (end && !start) start = end;

  if (!start) return { ok: true, start: null, end: null };
  if (start > end) {
    return { ok: false, error: "El período de gastos termina antes de empezar." };
  }
  return { ok: true, start, end };
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
// Comprobantes en el bucket
// ---------------------------------------------------------------------------

/** Días sin cambios tras los que un borrador se elimina solo. */
const DRAFT_TTL_DAYS = 30;

/**
 * Clave de bucket de un comprobante subido por este usuario, o null.
 *
 * /gastos/adjuntos/upload los deja siempre en gastos/<año>/<userId>/. Fuera de
 * esa carpeta un comprobante no es suyo: no se acepta en su solicitud y, sobre
 * todo, nunca se borra por una acción suya. Sin esta barrera, adjuntar a un
 * borrador la ruta de un comprobante ajeno y descartarlo lo eliminaría.
 */
function ownUploadPath(userId, ref) {
  const parsed = parseUploadPath(ref);
  const id = Number(userId);
  return parsed && Number.isInteger(id) && parsed.userId === id ? parsed.path : null;
}

const UPLOAD_PATH = /^gastos\/\d{4}\/(\d+)\/([^/]+)$/;

/** Ruta de bucket de un comprobante de gastos, con su dueño y nombre, o null. */
function parseUploadPath(ref) {
  let path = String(ref || "")
    .trim()
    .replace(/^\/?content\//, "")
    .replace(/^\/+/, "");
  // getPublicUrl codifica cada segmento de la URL; la clave del bucket no.
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  if (!path || path.split("/").includes("..")) return null;
  const match = UPLOAD_PATH.exec(path);
  return match ? { path, userId: Number(match[1]), fileName: match[2] } : null;
}

// Nombre definitivo: <id de 8 dígitos>_<n><ext>. Un nombre temporal nunca lo
// cumple: generateFileName le agrega marca de tiempo y sufijo aleatorio.
const FINAL_NAME = /^(\d{8})_(\d+)(\.[a-z0-9]{1,8})?$/;

/** El n de "76587612_2.pdf" si el archivo ya es de esta solicitud; si no, null. */
function finalAttachmentNumber(requestId, fileName) {
  const match = FINAL_NAME.exec(String(fileName || ""));
  if (!match || Number(match[1]) !== Number(requestId)) return null;
  return Number(match[2]);
}

function finalAttachmentName(requestId, n, fileName) {
  const ext = /(\.[a-z0-9]{1,8})$/i.exec(String(fileName || ""));
  return `${requestId}_${n}${ext ? ext[1].toLowerCase() : ""}`;
}

/**
 * ¿Puede este comprobante ir en esta solicitud? Tiene que ser del usuario y,
 * si ya tiene nombre definitivo, de esta misma solicitud: renombrarlo aquí
 * dejaría a la otra apuntando a un archivo que ya no existe.
 */
function acceptsAttachment(userId, requestId, attachment) {
  const path = attachmentPath(userId, attachment);
  if (!path) return false;
  const match = FINAL_NAME.exec(parseUploadPath(path).fileName);
  return !match || (requestId != null && Number(match[1]) === Number(requestId));
}

function attachmentPath(userId, attachment) {
  if (!attachment) return null;
  return (
    ownUploadPath(userId, attachment.publicId || attachment.public_id) ||
    ownUploadPath(userId, attachment.url)
  );
}

/**
 * Borrado de objetos del bucket, siempre después del COMMIT: si la transacción
 * falla, los archivos siguen ahí. Un fallo del bucket sólo deja un huérfano, y
 * no debe tumbar la acción del usuario.
 */
async function removeStoredFiles(paths) {
  const unique = [...new Set(paths.filter(Boolean))];
  if (!unique.length) return 0;
  try {
    // Carga diferida: el cliente de storage no hace falta para validar datos
    // y así los tests de normalización no dependen de él.
    const fileStorage = require("../fileStorage");
    const result = await fileStorage.deleteFiles(unique);
    if (result.failed) {
      console.error(`[Gastos] ${result.failed} comprobante(s) no se pudieron borrar del bucket.`);
    }
    return result.deleted;
  } catch (err) {
    console.error("[Gastos] No se pudieron borrar comprobantes:", err.message);
    return 0;
  }
}

/**
 * Comprobantes subidos que no llegaron a guardarse: el usuario los quitó o
 * cerró el formulario sin guardar. Sólo se borran los de su carpeta que no
 * estén asociados a ninguna solicitud.
 */
async function discardUploads({ user, refs }) {
  if (!Array.isArray(refs)) return { ok: true, deleted: 0 };
  const paths = [
    ...new Set(
      refs
        .slice(0, MAX_ATTACHMENTS * 2)
        .map((ref) => ownUploadPath(user.id, ref))
        .filter(Boolean),
    ),
  ];
  if (!paths.length) return { ok: true, deleted: 0 };

  const { rows } = await db.query(
    `SELECT url, public_id
       FROM expense_request_attachments
      WHERE public_id = ANY($1::text[]) OR url = ANY($2::text[])`,
    [paths, paths.map((path) => `/content/${path}`)],
  );
  const inUse = new Set(rows.map((a) => attachmentPath(user.id, a)));
  const free = paths.filter((path) => !inUse.has(path));

  await removeStoredFiles(free);
  return { ok: true, deleted: free.length };
}

/**
 * Renombra los comprobantes a su nombre definitivo <id>_<n><ext>.
 *
 * La numeración es estable: los que ya lo tienen conservan su número y los
 * nuevos toman el siguiente. Renumerar en cada guardado obligaría a mover
 * archivos sobre nombres ocupados, y el bucket no sobrescribe al mover.
 * Cada movimiento se anota en `moves` al hacerse, para poder deshacerlo si
 * el guardado falla a medio camino.
 */
async function renameAttachments(userId, requestId, attachments, moves) {
  const fileStorage = require("../fileStorage");
  const files = attachments.map((a) => parseUploadPath(attachmentPath(userId, a)));
  let next =
    files.reduce(
      (max, file) => Math.max(max, finalAttachmentNumber(requestId, file && file.fileName) || 0),
      0,
    ) + 1;

  const renamed = [];
  for (let i = 0; i < attachments.length; i += 1) {
    const file = files[i];
    if (!file || finalAttachmentNumber(requestId, file.fileName)) {
      renamed.push(attachments[i]);
      continue;
    }
    const folder = file.path.slice(0, file.path.lastIndexOf("/"));
    const target = `${folder}/${finalAttachmentName(requestId, next, file.fileName)}`;
    next += 1;
    const moved = await fileStorage.moveFile(file.path, target);
    moves.push({ from: file.path, to: target });
    renamed.push({ ...attachments[i], url: moved.secure_url, publicId: moved.public_id });
  }
  return renamed;
}

/** Devuelve los archivos a su nombre anterior, del último al primero. */
async function revertMoves(moves) {
  if (!moves.length) return;
  const fileStorage = require("../fileStorage");
  for (const move of moves.slice().reverse()) {
    try {
      await fileStorage.moveFile(move.to, move.from);
    } catch (err) {
      console.error("[Gastos] No se pudo deshacer el renombre de un comprobante:", err.message);
    }
  }
}

/** Horas de gracia para un archivo recién subido antes de darlo por abandonado. */
const ORPHAN_UPLOAD_GRACE_HOURS = 24;

/**
 * Barrido del bucket: borra los archivos de gastos/ con más de 24 h que no
 * pertenecen a ninguna solicitud. Son los que se subieron y nunca se guardaron
 * (siguen con su nombre temporal) y cualquier resto de un borrado fallido. La
 * gracia protege lo que alguien tiene subido en un formulario abierto.
 */
async function purgeOrphanUploads({ graceHours = ORPHAN_UPLOAD_GRACE_HOURS, now = Date.now() } = {}) {
  const storage = require("../storage/storageService");
  const files = await storage.listFilesRecursive("gastos");
  const limit = now - graceHours * 3600 * 1000;

  const candidates = files
    .filter((file) => file.created_at && file.created_at.getTime() < limit)
    .map((file) => parseUploadPath(file.relativePath))
    .filter(Boolean)
    .map((file) => file.path);
  if (!candidates.length) return { scanned: files.length, deleted: 0 };

  const inUse = new Set();
  for (let i = 0; i < candidates.length; i += 500) {
    const chunk = candidates.slice(i, i + 500);
    const { rows } = await db.query(
      `SELECT url, public_id
         FROM expense_request_attachments
        WHERE public_id = ANY($1::text[]) OR url = ANY($2::text[])`,
      [chunk, chunk.map((path) => `/content/${path}`)],
    );
    rows.forEach((row) => {
      [row.public_id, row.url].forEach((ref) => {
        const file = parseUploadPath(ref);
        if (file) inUse.add(file.path);
      });
    });
  }

  const orphans = candidates.filter((path) => !inUse.has(path));
  const deleted = await removeStoredFiles(orphans);
  return { scanned: files.length, deleted };
}

/**
 * Elimina los borradores sin cambios hace más de `days` días, con sus líneas,
 * adjuntos y archivos. Lo corre un job diario (app.js).
 */
async function purgeStaleDrafts(days = DRAFT_TTL_DAYS) {
  const client = await db.getClient();
  let files = [];
  let drafts = 0;
  try {
    await client.query("BEGIN");

    // SKIP LOCKED: un borrador que alguien está guardando en este instante
    // acaba de tocarse y no debe borrarse.
    const { rows: stale } = await client.query(
      `SELECT id, user_id
         FROM expense_requests
        WHERE status = $1
          AND updated_at < NOW() - make_interval(days => $2::int)
        FOR UPDATE SKIP LOCKED`,
      [EXPENSE_STATUS.DRAFT, days],
    );
    if (!stale.length) {
      await client.query("ROLLBACK");
      return { drafts: 0, files: 0 };
    }

    const ids = stale.map((row) => row.id);
    const ownerOf = new Map(stale.map((row) => [Number(row.id), row.user_id]));
    const { rows: attachments } = await client.query(
      `SELECT request_id, url, public_id
         FROM expense_request_attachments
        WHERE request_id = ANY($1::int[])`,
      [ids],
    );
    files = attachments.map((a) => attachmentPath(ownerOf.get(Number(a.request_id)), a));

    // Líneas y adjuntos caen por ON DELETE CASCADE.
    const deleted = await client.query(
      "DELETE FROM expense_requests WHERE id = ANY($1::int[]) AND status = $2",
      [ids, EXPENSE_STATUS.DRAFT],
    );
    drafts = deleted.rowCount;

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  const removed = await removeStoredFiles(files);
  return { drafts, files: removed };
}

// ---------------------------------------------------------------------------
// Preparación de la fila
// ---------------------------------------------------------------------------

/**
 * Ficha del solicitante tal como quedará congelada en la solicitud.
 *
 * Una rendición es un documento contable: el nombre, el documento de identidad,
 * el correo y el área se copian al enviarla. Si mañana se corrige un RUT o
 * alguien cambia de área, lo que Finanzas ya aprobó no cambia solo.
 */
async function fetchRequesterSnapshot(userId) {
  const { rows } = await db.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.national_id,
            w.area_name
       FROM users u
       LEFT JOIN work_areas w ON w.id = u.work_area_id
      WHERE u.id = $1`,
    [userId],
  );
  if (!rows.length) return null;

  const row = rows[0];
  const name = [row.first_name, row.last_name].filter(Boolean).join(" ").trim();
  return {
    name: name || row.email || `Usuario ${row.id}`,
    nationalId: row.national_id || null,
    email: row.email || null,
    areaName: row.area_name || null,
  };
}

/**
 * Con un solo centro asignado no hay nada que elegir y se acepta sin más; con
 * dos, el elegido tiene que ser uno de los suyos (el formulario ofrece sólo
 * esos, pero un POST a mano podría mandar cualquier id).
 */
function elegirCentro(centros, costCenterId) {
  // Number(null) y Number("") son 0: sin normalizar a texto primero, un campo
  // vacío se leería como "eligió el centro 0" en vez de "no eligió".
  const raw = String(costCenterId ?? "").trim();
  if (!raw) {
    return centros.length === 1 ? centros[0] : null;
  }

  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) return null;
  return centros.find((c) => Number(c.id) === id) || null;
}

/**
 * Columnas de expense_requests en un solo lugar, para que el INSERT de una
 * solicitud nueva y el UPDATE de un borrador no puedan desalinearse.
 */
function requestRow(d) {
  return {
    kind: d.kind,
    status: d.status,
    user_id: d.userId,
    work_area_id: d.areaId,
    title: d.title,
    description: d.description,
    currency_code: currentCurrencyCode(),
    total_amount: d.total,
    needed_by: d.neededBy,
    manager_user_id: d.managerId,
    requester_name: d.requester.name,
    requester_national_id: d.requester.nationalId,
    requester_email: d.requester.email,
    requester_area_name: d.requester.areaName,
    cost_center_id: d.costCenter ? d.costCenter.id : null,
    cost_center_code: d.costCenter ? d.costCenter.code : null,
    cost_center_name: d.costCenter ? d.costCenter.name : null,
    bank_code: d.bankAccount ? d.bankAccount.bankCode : null,
    bank_name: d.bankAccount ? d.bankAccount.bankName : null,
    bank_account_type: d.bankAccount ? d.bankAccount.accountType : null,
    bank_account_number: d.bankAccount ? d.bankAccount.accountNumber : null,
    destination: d.destination,
    period_start: d.periodStart,
    period_end: d.periodEnd,
    // Ambos los fija saveRequest con el fondo bloqueado; nunca el cliente.
    assigned_amount: d.assignedAmount ?? null,
    fund_request_id: d.fundRequestId ?? null,
  };
}

/** Reglas completas: lo que se exige para enviar a aprobación. */
async function prepareSubmission({
  user,
  kind,
  title,
  description,
  items: rawItems,
  attachments: rawAttachments,
  neededBy,
  costCenterId,
  bankAccount: rawBankAccount,
  saveBankAccount,
  fundRequestId,
  destination,
  periodStart,
  periodEnd,
  draftIdNumber,
}) {
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

  // El documento identifica al beneficiario del reembolso: sin él la rendición
  // no sirve para contabilidad, así que se exige aquí y no al crear la ficha.
  const requester = await fetchRequesterSnapshot(user.id);
  if (!requester) return { ok: false, error: "No se encontró tu ficha de colaborador." };
  if (!requester.nationalId) {
    const label = getDocumentConfig().label;
    return {
      ok: false,
      error: `Necesitas registrar tu ${label} antes de rendir gastos. Complétalo en tu perfil.`,
    };
  }

  // Todo gasto se imputa a un centro de costo; con dos asignados hay que elegir.
  const centros = await costCenters.listUserCostCenters(user.id);
  if (!centros.length) {
    return {
      ok: false,
      error:
        "No tienes centros de costo asignados. Pídele a RRHH que te asigne al menos uno.",
    };
  }
  const centro = elegirCentro(centros, costCenterId);
  if (!centro) {
    return { ok: false, error: "Elige un centro de costo válido para imputar el gasto." };
  }

  const normalized = normalizeItems(rawItems);
  if (!normalized.ok) return normalized;

  const period = normalizePeriod(periodStart, periodEnd, normalized.items);
  if (!period.ok) return period;

  // El fondo se valida y se reserva dentro de la transacción (saveRequest):
  // aquí sólo se interpreta la elección.
  const fundChoice = funds.parseFundChoice(kind === EXPENSE_KIND.RENDICION ? fundRequestId : "");
  if (fundChoice.type === "invalid") {
    return { ok: false, error: "El fondo elegido no es válido." };
  }

  const attachments = normalizeAttachments(rawAttachments).filter((a) =>
    acceptsAttachment(user.id, draftIdNumber, a),
  );
  if (kind === EXPENSE_KIND.RENDICION && !attachments.length) {
    return {
      ok: false,
      error: "Una rendición necesita al menos un comprobante adjunto.",
    };
  }

  // Cuenta de destino. Una instancia sin catálogo de bancos (Perú, por ahora)
  // no la exige: no habría con qué validarla.
  const banks = await bankAccounts.listBanks();
  let account = null;
  if (banks.length) {
    const bank = bankAccounts.normalizeBankAccount(rawBankAccount, {
      banks,
      nationalId: requester.nationalId,
    });
    if (!bank.ok) return bank;
    account = bank.account;
  }

  return {
    ok: true,
    row: requestRow({
      kind,
      status: EXPENSE_STATUS.PENDING,
      userId: user.id,
      areaId: context.area.id,
      title: parsedTitle,
      description: parseText(description, 4000),
      total: normalized.total,
      neededBy: kind === EXPENSE_KIND.FONDOS ? parseDate(neededBy) : null,
      managerId: approver.managerId,
      requester,
      costCenter: centro,
      bankAccount: account,
      destination: parseText(destination, 150),
      periodStart: period.start,
      periodEnd: period.end,
    }),
    items: normalized.items,
    attachments,
    account,
    saveAccount: saveBankAccount === true || saveBankAccount === "true",
    fundChoice,
    approver,
    area: context.area,
  };
}

/**
 * Borrador: se guarda lo que haya. Sólo se exige que exista algo que guardar,
 * para no llenar la lista de borradores vacíos por un click distraído.
 */
async function prepareDraft({
  user,
  kind,
  title,
  description,
  items: rawItems,
  attachments: rawAttachments,
  neededBy,
  costCenterId,
  bankAccount: rawBankAccount,
  fundRequestId,
  destination,
  periodStart,
  periodEnd,
  draftIdNumber,
}) {
  const [context, requester, centros, banks] = await Promise.all([
    areaManager.getUserAreaContext(user.id),
    fetchRequesterSnapshot(user.id),
    costCenters.listUserCostCenters(user.id),
    bankAccounts.listBanks(),
  ]);
  if (!requester) return { ok: false, error: "No se encontró tu ficha de colaborador." };

  const parsedTitle = parseText(title, 200);
  const parsedDescription = parseText(description, 4000);
  const draft = normalizeDraftItems(rawItems);
  const attachments = normalizeAttachments(rawAttachments).filter((a) =>
    acceptsAttachment(user.id, draftIdNumber, a),
  );
  if (!parsedTitle && !parsedDescription && !draft.items.length && !attachments.length) {
    return { ok: false, error: "Todavía no hay nada que guardar." };
  }

  const period = normalizePeriod(periodStart, periodEnd, draft.items);
  // En un borrador una elección inválida simplemente no se guarda.
  const parsedChoice = funds.parseFundChoice(kind === EXPENSE_KIND.RENDICION ? fundRequestId : "");
  const fundChoice = parsedChoice.type === "invalid" ? { type: "none" } : parsedChoice;

  return {
    ok: true,
    row: requestRow({
      kind,
      status: EXPENSE_STATUS.DRAFT,
      userId: user.id,
      areaId: context.area ? context.area.id : null,
      title: parsedTitle || "",
      description: parsedDescription,
      total: draft.total,
      neededBy: kind === EXPENSE_KIND.FONDOS ? parseDate(neededBy) : null,
      // El aprobador se resuelve al enviar: hasta entonces nadie debe verlo.
      managerId: null,
      requester,
      costCenter: elegirCentro(centros, costCenterId),
      bankAccount: banks.length
        ? bankAccounts.normalizeDraftBankAccount(rawBankAccount, {
            banks,
            nationalId: requester.nationalId,
          })
        : null,
      destination: parseText(destination, 150),
      periodStart: period.ok ? period.start : null,
      periodEnd: period.ok ? period.end : null,
    }),
    items: draft.items,
    attachments,
    account: null,
    saveAccount: false,
    fundChoice,
    approver: null,
    area: context.area,
  };
}

// ---------------------------------------------------------------------------
// Guardado (crear, guardar borrador, enviar borrador)
// ---------------------------------------------------------------------------

/**
 * Guarda una solicitud.
 *
 *   asDraft = true  → crea o actualiza el borrador `draftId`.
 *   asDraft = false → la envía a aprobación: nueva, o a partir del borrador.
 *
 * Al enviar un borrador se reutiliza su fila (y su número), se reemplazan
 * líneas y adjuntos, y created_at pasa a ser el momento del envío: es la fecha
 * que ven el jefe y Finanzas.
 */
async function saveRequest(input) {
  if (!isExpenseKind(input.kind)) {
    return { ok: false, error: "Tipo de solicitud inválido." };
  }

  const rawDraftId = String(input.draftId ?? "").trim();
  const draftId = rawDraftId ? Number(rawDraftId) : null;
  if (draftId !== null && !Number.isInteger(draftId)) {
    return { ok: false, error: "Borrador inválido." };
  }

  const payload = { ...input, draftIdNumber: draftId };
  const prepared = input.asDraft ? await prepareDraft(payload) : await prepareSubmission(payload);
  if (!prepared.ok) return prepared;

  // Archivos que el borrador tenía antes de este guardado; los que ya no
  // vengan se borran del bucket tras el COMMIT.
  let previousFiles = [];
  // Renombres hechos en el bucket, para deshacerlos si la transacción falla.
  const moves = [];

  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    // --- Fondos -----------------------------------------------------------
    // Una rendición resuelve aquí el fondo que rinde, con la fila del fondo
    // bloqueada; el índice único del 1:1 es la última barrera. Una solicitud
    // de fondos comprueba el cupo de 3. Ambos bajo un bloqueo por usuario.
    if (input.kind === EXPENSE_KIND.RENDICION) {
      const fund = await funds.resolveFundForRendicion(client, {
        userId: input.user.id,
        choice: prepared.fundChoice,
        asDraft: !!input.asDraft,
      });
      if (!fund.ok) {
        await client.query("ROLLBACK");
        return fund;
      }
      prepared.row.fund_request_id = fund.fundRequestId;
      prepared.row.assigned_amount = fund.assignedAmount;
    } else if (!input.asDraft) {
      const cupo = await funds.checkFundLimit(client, { userId: input.user.id });
      if (!cupo.ok) {
        await client.query("ROLLBACK");
        return cupo;
      }
    }

    let saved;
    if (draftId !== null) {
      const { rows } = await client.query(
        "SELECT id, user_id, status, kind FROM expense_requests WHERE id = $1 FOR UPDATE",
        [draftId],
      );
      const current = rows[0];
      if (
        !current ||
        Number(current.user_id) !== Number(input.user.id) ||
        current.status !== EXPENSE_STATUS.DRAFT
      ) {
        await client.query("ROLLBACK");
        return { ok: false, error: "Ese borrador ya no existe o ya fue enviado." };
      }
      if (current.kind !== input.kind) {
        await client.query("ROLLBACK");
        return { ok: false, error: "El borrador es de otro tipo de solicitud." };
      }

      const { rows: previous } = await client.query(
        "SELECT url, public_id FROM expense_request_attachments WHERE request_id = $1",
        [draftId],
      );
      previousFiles = previous.map((a) => attachmentPath(input.user.id, a));

      saved = await updateRequest(client, draftId, prepared.row, {
        resetCreatedAt: !input.asDraft,
      });
      await client.query("DELETE FROM expense_request_items WHERE request_id = $1", [draftId]);
      await client.query("DELETE FROM expense_request_attachments WHERE request_id = $1", [draftId]);
    } else {
      saved = await insertRequestWithRetry(client, prepared.row);
    }

    // Con el id ya asignado, los comprobantes toman su nombre definitivo antes
    // del COMMIT; si algo falla después, el catch deshace los movimientos.
    const renamed = await renameAttachments(input.user.id, saved.id, prepared.attachments, moves);
    await insertChildren(client, saved.id, prepared.items, renamed);

    if (prepared.account) {
      await bankAccounts.touchUserAccount(client, input.user.id, prepared.account, {
        save: prepared.saveAccount,
      });
    }

    await client.query("COMMIT");

    const kept = new Set(renamed.map((a) => attachmentPath(input.user.id, a)));
    await removeStoredFiles(previousFiles.filter((path) => path && !kept.has(path)));

    return {
      ok: true,
      request: saved,
      draft: !!input.asDraft,
      requiresAdmin: prepared.approver ? prepared.approver.requiresAdmin : false,
      manager: prepared.approver ? prepared.approver.manager : null,
      area: prepared.area,
      // Con sus nombres nuevos: el cliente debe seguir el borrador con estos.
      attachments: renamed.map((a) => ({ name: a.name, url: a.url, public_id: a.publicId })),
    };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    await revertMoves(moves);
    if (funds.isFundRendicionConflict(err)) {
      return { ok: false, error: "Ese fondo ya tiene una rendición en curso." };
    }
    throw err;
  } finally {
    client.release();
  }
}

async function insertChildren(client, requestId, items, attachments) {
  if (items.length) {
    await client.query(
      `INSERT INTO expense_request_items
         (request_id, item_date, category, days, detail, amount, sort_order)
       SELECT $1, d, cat, dys, det, amt, ord
         FROM UNNEST($2::date[], $3::text[], $4::smallint[], $5::text[], $6::numeric[], $7::int[])
           AS t(d, cat, dys, det, amt, ord)`,
      [
        requestId,
        items.map((i) => i.itemDate),
        items.map((i) => i.category),
        items.map((i) => i.days),
        items.map((i) => i.detail),
        items.map((i) => i.amount),
        items.map((_, index) => index),
      ],
    );
  }

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
}

/**
 * INSERT con reintento por colisión del ID aleatorio de 8 dígitos.
 *
 * db.queryRetryIdCollision no sirve aquí porque no acepta un client, y el
 * INSERT tiene que ir dentro de la misma transacción que los ítems. El
 * SAVEPOINT es imprescindible: en Postgres un error aborta la transacción
 * entera, así que sin él el segundo intento fallaría con "current transaction
 * is aborted".
 */
async function insertRequestWithRetry(client, row, maxAttempts = 8) {
  // Los nombres de columna salen de requestRow, nunca del cliente.
  const columns = Object.keys(row);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  const sql = `INSERT INTO expense_requests (${columns.join(", ")})
               VALUES (${placeholders.join(", ")})
               RETURNING *`;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    await client.query("SAVEPOINT insert_expense");
    try {
      const { rows } = await client.query(sql, Object.values(row));
      await client.query("RELEASE SAVEPOINT insert_expense");
      return rows[0];
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT insert_expense");
      if (!isIdPrimaryKeyCollision(err) || attempt === maxAttempts - 1) throw err;
    }
  }
  throw new Error("No fue posible generar un ID para la solicitud.");
}

async function updateRequest(client, id, row, { resetCreatedAt }) {
  const columns = Object.keys(row);
  const sets = columns.map((column, i) => `${column} = $${i + 1}`);
  sets.push("updated_at = NOW()");
  if (resetCreatedAt) sets.push("created_at = NOW()");

  const { rows } = await client.query(
    `UPDATE expense_requests SET ${sets.join(", ")}
      WHERE id = $${columns.length + 1}
      RETURNING *`,
    [...Object.values(row), id],
  );
  return rows[0];
}

/**
 * Descarta un borrador propio con todo lo suyo: líneas y adjuntos (por
 * CASCADE) y sus archivos del bucket. Lo ya enviado nunca se borra, se anula.
 */
async function deleteDraft({ requestId, user }) {
  const id = Number(requestId);
  if (!Number.isInteger(id)) return { ok: false, error: "Borrador inválido." };

  // Los adjuntos se leen en la misma sentencia que borra: el CASCADE se los
  // lleva, y en un CTE todas las partes ven la foto previa al DELETE.
  const { rows } = await db.query(
    `WITH adjuntos AS (
       SELECT a.url, a.public_id
         FROM expense_request_attachments a
         JOIN expense_requests r ON r.id = a.request_id
        WHERE r.id = $1 AND r.user_id = $2 AND r.status = $3
     ), borrado AS (
       DELETE FROM expense_requests
        WHERE id = $1 AND user_id = $2 AND status = $3
       RETURNING id
     )
     SELECT (SELECT COUNT(*)::int FROM borrado) AS borrados,
            COALESCE((SELECT json_agg(adjuntos) FROM adjuntos), '[]'::json) AS adjuntos`,
    [id, user.id, EXPENSE_STATUS.DRAFT],
  );
  if (!rows[0] || !rows[0].borrados) {
    return { ok: false, error: "Ese borrador ya no existe o ya fue enviado." };
  }

  await removeStoredFiles(rows[0].adjuntos.map((a) => attachmentPath(user.id, a)));
  return { ok: true };
}

/**
 * "YYYY-MM-DD" para un <input type="date">. node-pg entrega las columnas DATE
 * como Date a medianoche local: toISOString() las correría un día al oeste de
 * Greenwich, así que se arma con la fecha local.
 */
function isoDate(value) {
  if (!value) return "";
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return "";
    const month = String(value.getMonth() + 1).padStart(2, "0");
    const day = String(value.getDate()).padStart(2, "0");
    return `${value.getFullYear()}-${month}-${day}`;
  }
  return String(value).slice(0, 10);
}

/** Un borrador propio, con la forma que espera el formulario. */
async function getDraftForEdit(requestId, user) {
  const request = await getRequestDetail(requestId);
  if (
    !request ||
    request.status !== EXPENSE_STATUS.DRAFT ||
    Number(request.user_id) !== Number(user.id)
  ) {
    return null;
  }

  const hasBank = request.bank_code || request.bank_account_number;
  return {
    id: request.id,
    kind: request.kind,
    title: request.title || "",
    description: request.description || "",
    destination: request.destination || "",
    fund_request_id: request.fund_request_id || "",
    cost_center_id: request.cost_center_id || "",
    needed_by: isoDate(request.needed_by),
    period_start: isoDate(request.period_start),
    period_end: isoDate(request.period_end),
    updated_at: request.updated_at,
    items: request.items.map((item) => ({
      item_date: isoDate(item.item_date),
      category: item.category || "",
      days: item.days || "",
      detail: item.detail || "",
      amount: item.amount,
    })),
    attachments: request.attachments.map((a) => ({
      name: a.name,
      url: a.url,
      public_id: a.public_id,
    })),
    bank_account: hasBank
      ? {
          bank_code: request.bank_code || "",
          account_type: request.bank_account_type || "",
          account_number: request.bank_account_number || "",
        }
      : null,
  };
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

    // Una rendición que Finanzas aprueba sin saldo no tiene nada que liquidar.
    const autoSettle =
      approve &&
      stage === EXPENSE_STAGE.FINANCE &&
      request.kind === EXPENSE_KIND.RENDICION &&
      funds.fundBalance(request.total_amount, request.assigned_amount).sentido === "cerrado";

    const columnPrefix = stage === EXPENSE_STAGE.MANAGER ? "manager" : "finance";
    const { rows: updated } = await client.query(
      `UPDATE expense_requests
          SET status                 = $1,
              ${columnPrefix}_reviewed_by = $2,
              ${columnPrefix}_reviewed_at = NOW(),
              ${columnPrefix}_notes       = $3,
              rejected_stage         = $4,
              settled_at             = CASE WHEN $6::boolean THEN NOW() ELSE settled_at END,
              updated_at             = NOW()
        WHERE id = $5
        RETURNING *`,
      [nextStatus, user.id, reviewerNotes, approve ? null : stage, id, autoSettle],
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

/**
 * Liquidar: Finanzas confirma que el saldo de una rendición aprobada ya se
 * devolvió o se pagó. Una rendición sin saldo se liquida sola al aprobarse.
 */
async function settleRequest({ requestId, reviewer, notes }) {
  const id = Number(requestId);
  if (!Number.isInteger(id)) return { ok: false, error: "Solicitud inválida." };
  if (!(await financeTeam.isFinanceApprover(reviewer))) {
    return { ok: false, error: "Sólo Finanzas puede liquidar una rendición." };
  }

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "SELECT * FROM expense_requests WHERE id = $1 FOR UPDATE",
      [id],
    );
    const request = rows[0];
    if (
      !request ||
      request.kind !== EXPENSE_KIND.RENDICION ||
      request.status !== EXPENSE_STATUS.APPROVED_FINANCE
    ) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Sólo se liquidan rendiciones aprobadas por Finanzas." };
    }
    if (request.settled_at) {
      await client.query("ROLLBACK");
      return { ok: false, error: "Esta rendición ya está liquidada." };
    }

    const { rows: updated } = await client.query(
      `UPDATE expense_requests
          SET settled_at = NOW(), settled_by = $1, settlement_notes = $2, updated_at = NOW()
        WHERE id = $3
        RETURNING *`,
      [reviewer.id, parseText(notes, 2000), id],
    );
    await client.query("COMMIT");
    return { ok: true, request: updated[0] };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

/**
 * Los datos del solicitante salen de lo congelado en la solicitud; el JOIN a
 * users queda sólo como respaldo para filas anteriores a la copia y para la
 * foto, que sí conviene que sea la actual.
 *
 * LEFT JOIN: si el colaborador fue eliminado, user_id es NULL y la solicitud
 * debe seguir apareciendo en Gestión, en el historial y en su detalle.
 */
const LIST_SELECT = `
  SELECT r.*,
         (r.user_id IS NULL) AS requester_deleted,
         COALESCE(r.requester_area_name, w.area_name) AS area_name,
         w.color AS area_color,
         COALESCE(
           r.requester_name,
           NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), ''),
           u.email
         ) AS requester_display_name,
         COALESCE(r.requester_national_id, u.national_id) AS requester_document,
         COALESCE(r.requester_email, u.email)             AS requester_contact_email,
         u.photo AS requester_photo,
         (SELECT COUNT(*)::int FROM expense_request_items i WHERE i.request_id = r.id)       AS item_count,
         (SELECT COUNT(*)::int FROM expense_request_attachments a WHERE a.request_id = r.id) AS attachment_count
    FROM expense_requests r
    LEFT JOIN work_areas w ON w.id = r.work_area_id
    LEFT JOIN users u ON u.id = r.user_id`;

/** Las del colaborador, borradores incluidos (son sólo suyos). */
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

/**
 * Todo lo que ya pasó por este revisor, más lo que gestiona su área. Los
 * borradores quedan fuera siempre: nadie más que su dueño debe verlos.
 */
async function listHistoryForReviewer(user) {
  const isAdmin = isAdministrador(normalizeRole(user.role));
  const isFinance = await financeTeam.isFinanceApprover(user);
  const managedAreaIds = await areaManager.listManagedAreaIds(user.id);

  const { rows } = await db.query(
    `${LIST_SELECT}
      WHERE r.status <> $6
        AND (r.manager_reviewed_by = $1
          OR r.finance_reviewed_by = $1
          OR r.work_area_id = ANY($2::int[])
          OR $3
          OR ($4 AND r.status <> $5))
      ORDER BY r.created_at DESC
      LIMIT 500`,
    [
      user.id,
      managedAreaIds,
      isAdmin,
      isFinance,
      EXPENSE_STATUS.PENDING,
      EXPENSE_STATUS.DRAFT,
    ],
  );
  return rows;
}

/** Rendiciones aprobadas con saldo que Finanzas aún no liquida. */
async function listPendingSettlements() {
  const { rows } = await db.query(
    `${LIST_SELECT}
      WHERE r.kind = $1 AND r.status = $2 AND r.settled_at IS NULL
      ORDER BY r.finance_reviewed_at ASC NULLS LAST`,
    [EXPENSE_KIND.RENDICION, EXPENSE_STATUS.APPROVED_FINANCE],
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
      `SELECT id, item_date, category, days, detail, amount
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

  // Fondo que rinde (rendición) o rendiciones que tiene (solicitud de fondos).
  const links = await funds.fundLinksFor(request);

  return {
    ...request,
    ...links,
    // El documento se guarda normalizado ("12345678-5"); los puntos son
    // decoración de pantalla y se agregan aquí.
    requester_document_display: formatNationalId(request.requester_document),
    items: itemsResult.rows,
    attachments: attachmentsResult.rows,
  };
}

/** ¿Puede este usuario ver el detalle de esta solicitud? */
async function canViewRequest(request, user) {
  const isOwner = Number(request.user_id) === Number(user.id);
  if (request.status === EXPENSE_STATUS.DRAFT) return isOwner;
  if (isOwner) return true;
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
  saveRequest,
  deleteDraft,
  getDraftForEdit,
  discardUploads,
  purgeStaleDrafts,
  purgeOrphanUploads,
  DRAFT_TTL_DAYS,
  elegirCentro,
  approveRequest,
  rejectRequest,
  cancelRequest,
  settleRequest,
  listPendingSettlements,
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
  normalizeDraftItems,
  normalizePeriod,
  normalizeAttachments,
  ownUploadPath,
  parseUploadPath,
  finalAttachmentName,
  finalAttachmentNumber,
  acceptsAttachment,
  isoDate,
};
