const db = require("../../db");
const { EXPENSE_STATUS, EXPENSE_KIND } = require("../../constants/expenseStatuses");

/**
 * Fondos asignados: la relación entre una solicitud de fondos y su rendición.
 *
 * Una solicitud de fondos aprobada por Finanzas le asigna ese monto al
 * colaborador, que debe rendirlo en exactamente una rendición (1:1). El saldo
 * de la rendición es gastado - asignado: negativo, el colaborador devuelve;
 * positivo, la empresa le paga; cero, queda cerrado.
 *
 * Los estados del fondo no se guardan: se derivan del estado de la solicitud y
 * del de su rendición activa. Así un rechazo o una anulación de la rendición
 * devuelven el fondo a "por rendir" sin que nadie tenga que actualizar nada.
 */

/** Máximo de solicitudes de fondos sin cerrar por colaborador. */
const MAX_OPEN_FUNDS = 3;

/** Índice único que garantiza el 1:1 (expenseSchema.js / schema.sql). */
const FUND_RENDICION_UNIQUE = "expense_requests_fund_rendicion_unique";

/** Clase del bloqueo consultivo que serializa las operaciones de fondos por usuario. */
const FUND_LOCK_CLASS = 4201;

const { PENDING, APPROVED_MANAGER, APPROVED_FINANCE } = EXPENSE_STATUS;
const IN_REVIEW = [PENDING, APPROVED_MANAGER];

const FUND_STATE_LABELS = Object.freeze({
  en_aprobacion: "En aprobación",
  por_rendir: "Por rendir",
  en_revision: "Rendición en revisión",
  rendido: "Rendido",
});

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Estado de un fondo a partir de su solicitud y de su rendición activa
 * (pending, approved_manager o approved_finance; null si no tiene).
 * Devuelve null si la solicitud no es un fondo vivo (borrador, rechazada,
 * anulada).
 */
function fundState(fundStatus, rendicionStatus) {
  if (IN_REVIEW.includes(fundStatus)) return "en_aprobacion";
  if (fundStatus !== APPROVED_FINANCE) return null;
  if (rendicionStatus === APPROVED_FINANCE) return "rendido";
  if (IN_REVIEW.includes(rendicionStatus)) return "en_revision";
  return "por_rendir";
}

function fundStateLabel(state) {
  return FUND_STATE_LABELS[state] || "—";
}

/** ¿Ocupa uno de los 3 cupos? Sí mientras no esté rendido ni haya muerto. */
function countsTowardLimit(fundStatus, rendicionStatus) {
  const state = fundState(fundStatus, rendicionStatus);
  return state !== null && state !== "rendido";
}

/**
 * Saldo de una rendición. `assigned` NULL es un reembolso sin fondo: la
 * empresa paga todo lo gastado.
 * @returns {{ saldo: number, monto: number, sentido: 'devolver'|'pagar'|'cerrado' }}
 */
function fundBalance(total, assigned) {
  const saldo = roundMoney(Number(total || 0) - Number(assigned || 0));
  return {
    saldo,
    monto: Math.abs(saldo),
    sentido: saldo > 0 ? "pagar" : saldo < 0 ? "devolver" : "cerrado",
  };
}

/**
 * Qué eligió el formulario en "¿Qué vas a rendir?":
 * "" = no eligió, "reembolso" = sin fondo, un número = ese fondo.
 */
function parseFundChoice(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return { type: "none" };
  if (value === "reembolso") return { type: "reembolso" };
  if (/^\d{1,9}$/.test(value)) return { type: "fondo", id: Number(value) };
  return { type: "invalid" };
}

/**
 * Solicitudes de fondos de un usuario con su rendición activa más reciente.
 * Se completa con condiciones extra (AND ...) según el uso.
 */
const FUNDS_SQL = `
  SELECT f.id, f.title, f.total_amount, f.status, f.cost_center_id, f.cost_center_code,
         f.created_at, f.finance_reviewed_at,
         r.id AS rendicion_id, r.status AS rendicion_status
    FROM expense_requests f
    LEFT JOIN LATERAL (
      SELECT x.id, x.status
        FROM expense_requests x
       WHERE x.fund_request_id = f.id
         AND x.kind = 'rendicion'
         AND x.status IN ('pending', 'approved_manager', 'approved_finance')
       ORDER BY x.created_at DESC
       LIMIT 1
    ) r ON TRUE
   WHERE f.user_id = $1
     AND f.kind = 'fondos'`;

/**
 * Resumen para la card "Mis fondos" y para el selector del modal.
 * `settlementRows` son las rendiciones aprobadas aún sin liquidar.
 */
function summarizeFunds(fundRows, settlementRows = []) {
  const abiertos = [];
  for (const row of fundRows) {
    if (!countsTowardLimit(row.status, row.rendicion_status)) continue;
    const state = fundState(row.status, row.rendicion_status);
    abiertos.push({
      ...row,
      total_amount: Number(row.total_amount),
      state,
      stateLabel: fundStateLabel(state),
    });
  }
  const porRendir = abiertos.filter((fund) => fund.state === "por_rendir");

  return {
    max: MAX_OPEN_FUNDS,
    usados: abiertos.length,
    lleno: abiertos.length >= MAX_OPEN_FUNDS,
    asignadoPorRendir: roundMoney(porRendir.reduce((sum, fund) => sum + fund.total_amount, 0)),
    abiertos,
    porRendir,
    porLiquidar: settlementRows.map((row) => ({
      ...row,
      balance: fundBalance(row.total_amount, row.assigned_amount),
    })),
  };
}

async function getFundSummary(userId) {
  const [fundsResult, settlementsResult] = await Promise.all([
    db.query(`${FUNDS_SQL} ORDER BY f.created_at ASC`, [userId]),
    db.query(
      `SELECT id, title, total_amount, assigned_amount, fund_request_id
         FROM expense_requests
        WHERE user_id = $1
          AND kind = $2
          AND status = $3
          AND settled_at IS NULL
        ORDER BY finance_reviewed_at ASC NULLS LAST`,
      [userId, EXPENSE_KIND.RENDICION, APPROVED_FINANCE],
    ),
  ]);
  return summarizeFunds(fundsResult.rows, settlementsResult.rows);
}

/**
 * Serializa, por usuario, el conteo de cupo y la reserva de fondos: dos envíos
 * simultáneos del mismo colaborador esperan su turno aquí en vez de pasar los
 * dos la validación. Se libera sola al terminar la transacción.
 */
function lockUserFunds(client, userId) {
  return client.query("SELECT pg_advisory_xact_lock($1::int, $2::int)", [
    FUND_LOCK_CLASS,
    Number(userId),
  ]);
}

/** Al enviar una solicitud de fondos: ¿le queda cupo? Corre dentro de la transacción. */
async function checkFundLimit(client, { userId }) {
  await lockUserFunds(client, userId);
  const { rows } = await client.query(FUNDS_SQL, [userId]);
  const usados = rows.filter((row) => countsTowardLimit(row.status, row.rendicion_status)).length;
  if (usados >= MAX_OPEN_FUNDS) {
    return {
      ok: false,
      error: `Tienes ${MAX_OPEN_FUNDS} solicitudes de fondos sin cerrar. Rinde una para poder pedir otra.`,
    };
  }
  return { ok: true };
}

/**
 * Fondo que rinde una rendición. Corre dentro de la transacción de saveRequest.
 *
 * - Borrador: guarda el fondo elegido si es un fondo aprobado del usuario,
 *   pero no lo reserva. Sólo aprobados: un borrador de rendición que apuntara
 *   al borrador de un fondo impediría descartar ese borrador (FK).
 * - Envío: bloquea la fila del fondo y exige que esté por rendir. El asignado
 *   se copia del total del fondo. Sin elección, sólo vale si el usuario no
 *   tiene fondos por rendir (entonces es un reembolso).
 *
 * @returns {{ ok: true, fundRequestId: number|null, assignedAmount: number|null } | { ok: false, error: string }}
 */
async function resolveFundForRendicion(client, { userId, choice, asDraft }) {
  if (choice.type === "invalid") {
    return { ok: false, error: "El fondo elegido no es válido." };
  }

  if (asDraft) {
    if (choice.type !== "fondo") return { ok: true, fundRequestId: null, assignedAmount: null };
    const { rows } = await client.query(
      `SELECT id FROM expense_requests
        WHERE id = $1 AND user_id = $2 AND kind = $3 AND status = $4`,
      [choice.id, userId, EXPENSE_KIND.FONDOS, APPROVED_FINANCE],
    );
    return { ok: true, fundRequestId: rows.length ? choice.id : null, assignedAmount: null };
  }

  await lockUserFunds(client, userId);

  if (choice.type === "fondo") {
    const { rows } = await client.query(`${FUNDS_SQL} AND f.id = $2 FOR UPDATE OF f`, [
      userId,
      choice.id,
    ]);
    const fund = rows[0];
    if (!fund) return { ok: false, error: "Ese fondo no existe o no es tuyo." };

    const state = fundState(fund.status, fund.rendicion_status);
    if (state === "en_aprobacion") {
      return { ok: false, error: "Ese fondo todavía no está aprobado por Finanzas." };
    }
    if (state !== "por_rendir") {
      return { ok: false, error: "Ese fondo ya tiene una rendición en curso o ya fue rendido." };
    }
    return { ok: true, fundRequestId: fund.id, assignedAmount: Number(fund.total_amount) };
  }

  if (choice.type === "none") {
    const { rows } = await client.query(FUNDS_SQL, [userId]);
    if (rows.some((row) => fundState(row.status, row.rendicion_status) === "por_rendir")) {
      return {
        ok: false,
        error: "Tienes fondos por rendir: elige cuál rindes o marca «Sin fondo».",
      };
    }
  }

  return { ok: true, fundRequestId: null, assignedAmount: null };
}

/** ¿Es esta la violación del 1:1 (dos rendiciones activas del mismo fondo)? */
function isFundRendicionConflict(err) {
  return !!err && err.code === "23505" && err.constraint === FUND_RENDICION_UNIQUE;
}

/**
 * Datos de la relación para el detalle:
 * - rendición: el fondo que rinde y su saldo.
 * - solicitud de fondos: sus rendiciones (no borradores) y su estado.
 */
async function fundLinksFor(request) {
  if (request.kind === EXPENSE_KIND.RENDICION) {
    const balance = fundBalance(request.total_amount, request.assigned_amount);
    if (!request.fund_request_id) return { fund: null, balance, rendiciones: [] };
    const { rows } = await db.query(
      "SELECT id, title, total_amount, status FROM expense_requests WHERE id = $1",
      [request.fund_request_id],
    );
    return { fund: rows[0] || null, balance, rendiciones: [] };
  }

  const { rows } = await db.query(
    `SELECT id, status, total_amount, assigned_amount, settled_at, created_at
       FROM expense_requests
      WHERE fund_request_id = $1 AND kind = $2 AND status <> $3
      ORDER BY created_at DESC`,
    [request.id, EXPENSE_KIND.RENDICION, EXPENSE_STATUS.DRAFT],
  );
  const activa = rows.find((row) => [PENDING, APPROVED_MANAGER, APPROVED_FINANCE].includes(row.status));
  return {
    fund: null,
    balance: null,
    rendiciones: rows,
    fundState: fundState(request.status, activa ? activa.status : null),
  };
}

module.exports = {
  MAX_OPEN_FUNDS,
  FUND_RENDICION_UNIQUE,
  fundState,
  fundStateLabel,
  countsTowardLimit,
  fundBalance,
  parseFundChoice,
  summarizeFunds,
  getFundSummary,
  checkFundLimit,
  resolveFundForRendicion,
  isFundRendicionConflict,
  fundLinksFor,
};
