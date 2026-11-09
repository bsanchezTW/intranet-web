const { decide } = require("../permissions/decide");

/**
 * Quién ve, completa y anula cada hoja de ruta. Puro, para las rutas, las
 * vistas y los tests.
 *
 * "Lo propio" es la hoja que la persona abrió o en la que va de conductor o
 * peoneta: Logística puede abrirla por el conductor y él la completa desde
 * su celular.
 *
 *   ver (propio | todo)  ver e imprimir
 *   crear                abrir hojas y completar las propias (y verlas)
 *   administrar          completar y cerrar cualquiera (y verlas todas)
 *   anular               anular las que puede ver
 */
const KEYS = Object.freeze({
  VER: "logistica.hoja_ruta.ver",
  CREAR: "logistica.hoja_ruta.crear",
  ADMINISTRAR: "logistica.hoja_ruta.administrar",
  ANULAR: "logistica.hoja_ruta.anular",
});

const ENTRAR = [KEYS.VER, KEYS.CREAR, KEYS.ADMINISTRAR];

function esPropia(sheet, userId) {
  const id = Number(userId);
  return [sheet.created_by, sheet.driver_user_id, sheet.helper_user_id].some((v) => v != null && Number(v) === id);
}

function veTodas(perms) {
  if (decide(perms, KEYS.ADMINISTRAR)) return true;
  const coverage = perms && typeof perms.coverage === "function" ? perms.coverage(KEYS.VER) : null;
  return Boolean(coverage && coverage.all);
}

/** Lo que la persona puede hacer en el módulo, para botones y menús. */
function accessFor(perms) {
  const can = (key) => decide(perms, key);
  return {
    entra: ENTRAR.some(can),
    veTodas: veTodas(perms),
    puedeAbrir: can(KEYS.CREAR) || can(KEYS.ADMINISTRAR),
    puedeAdministrar: can(KEYS.ADMINISTRAR),
    puedeAnular: can(KEYS.ANULAR),
  };
}

/**
 * Filtro del listado sobre `h` (route_sheets): todas, o las propias. Los
 * parámetros parten en $1; listRouteSheets los corre.
 */
function listScope(perms, userId) {
  if (veTodas(perms)) return { clause: "TRUE", params: [] };
  if (!ENTRAR.some((key) => decide(perms, key))) return { clause: "FALSE", params: [] };
  return {
    clause: "(h.created_by = $1 OR h.driver_user_id = $1 OR h.helper_user_id = $1)",
    params: [Number(userId)],
  };
}

function canView(perms, userId, sheet) {
  if (veTodas(perms)) return true;
  return esPropia(sheet, userId) && ENTRAR.some((key) => decide(perms, key));
}

/** Completar o cerrar: sólo mientras está abierta. */
function canEdit(perms, userId, sheet) {
  if (!sheet || sheet.status !== "open") return false;
  if (decide(perms, KEYS.ADMINISTRAR)) return true;
  return decide(perms, KEYS.CREAR) && esPropia(sheet, userId);
}

function canVoid(perms, userId, sheet) {
  if (!sheet || sheet.status === "voided") return false;
  return decide(perms, KEYS.ANULAR) && canView(perms, userId, sheet);
}

module.exports = { KEYS, ENTRAR, esPropia, accessFor, listScope, canView, canEdit, canVoid };
