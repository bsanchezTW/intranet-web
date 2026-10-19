const db = require("../../db");
const logger = require("../../utils/logger");
const { canLogin, normalizeRole } = require("../../constants/roles");

/**
 * Estado vigente de la cuenta de quien tiene sesión.
 *
 * La sesión guarda el rol del momento del login y se renueva sola en cada
 * petición: sin esta revisión, alguien deshabilitado, eliminado o al que se
 * le quitó el rol de administrador seguía operando con lo que tenía mientras
 * no cerrara la sesión. Aquí se relee la tabla `users` (chica: una consulta
 * para todos, cacheada unos segundos) y la sesión se corrige o se cierra.
 */

const CACHE_TTL_MS = 30 * 1000;

let cache = { expiresAt: 0, byUserId: null };
let inflight = null;

async function fetchAccounts() {
  const { rows } = await db.query("SELECT id, role, work_area_id FROM users");
  const byUserId = new Map();
  for (const row of rows) {
    byUserId.set(Number(row.id), {
      role: normalizeRole(row.role),
      workAreaId: row.work_area_id == null ? null : Number(row.work_area_id),
    });
  }
  return byUserId;
}

/**
 * Cuentas por id. Ante un error de BD se queda con el último caché; sin
 * ninguno devuelve null y quien llama no decide nada (no se expulsa a todos
 * por una caída de la base).
 */
async function loadAccounts() {
  if (cache.byUserId && cache.expiresAt > Date.now()) return cache.byUserId;
  if (!inflight) {
    inflight = fetchAccounts()
      .then((byUserId) => {
        cache = { expiresAt: Date.now() + CACHE_TTL_MS, byUserId };
        return byUserId;
      })
      .catch((err) => {
        logger.error("cuentas", err);
        return cache.byUserId;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Qué hacer con la sesión de `sessionUser` dada su fila actual. Pura.
 *
 *   { action: "keep" }                 → nada cambió.
 *   { action: "update", role }         → sigue activa con otro rol.
 *   { action: "end" }                  → deshabilitada o eliminada.
 *
 * El login de emergencia (id 0) no existe en `users` y siempre se mantiene.
 */
function sessionAccountState(sessionUser, account) {
  if (!sessionUser) return { action: "keep" };
  if (Number(sessionUser.id) === 0) return { action: "keep" };
  if (!account || !canLogin(account.role)) return { action: "end" };
  if (account.role !== normalizeRole(sessionUser.role)) {
    return { action: "update", role: account.role };
  }
  return { action: "keep" };
}

/** Estado de la sesión contra la base. Sin datos de la base, la mantiene. */
async function checkSessionAccount(sessionUser) {
  if (!sessionUser || Number(sessionUser.id) === 0) return { action: "keep" };
  const accounts = await loadAccounts();
  if (!accounts) return { action: "keep" };
  return sessionAccountState(sessionUser, accounts.get(Number(sessionUser.id)));
}

/** Área de trabajo vigente del usuario, o undefined si no se pudo saber. */
async function currentWorkAreaId(userId) {
  const accounts = await loadAccounts();
  if (!accounts) return undefined;
  const account = accounts.get(Number(userId));
  return account ? account.workAreaId : null;
}

/** Tras editar, deshabilitar o eliminar a alguien: vale en la próxima petición. */
function invalidateAccountStatus() {
  cache = { expiresAt: 0, byUserId: null };
}

module.exports = {
  sessionAccountState,
  checkSessionAccount,
  currentWorkAreaId,
  invalidateAccountStatus,
};
