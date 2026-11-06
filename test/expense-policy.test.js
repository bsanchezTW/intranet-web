const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = "CL";

const { getCatalog } = require("../src/services/permissions/catalog");
const { computePermissions } = require("../src/services/permissions/resolver");
const policy = require("../src/services/expenses/expensePolicy");
const { EXPENSE_STATUS } = require("../src/constants/expenseStatuses");

/*
  Fondos y rendiciones con Gestión de Permisos: quién aprueba se decide en
  el momento con los permisos, no con el jefe guardado en la solicitud.

  Gerencia (1, jefe 10) › Finanzas (2, jefe 20) › Tesorería (3, sin jefe).
  40 aprueba Finanzas y liquida; 50 tiene la jefatura asignada sólo sobre
  Tesorería; 60 es superadmin; 31 y 33 trabajan en Tesorería.
*/

const CL = getCatalog("CL");
const K = policy.KEYS;
const AREAS = [
  { id: 1, parent_area_id: null, manager_user_id: 10 },
  { id: 2, parent_area_id: 1, manager_user_id: 20 },
  { id: 3, parent_area_id: 2, manager_user_id: null },
];
const USERS = [
  { id: 10, work_area_id: 1 },
  { id: 20, work_area_id: 2 },
  { id: 31, work_area_id: 3 },
  { id: 33, work_area_id: 3 },
  { id: 40, work_area_id: 2 },
  { id: 50, work_area_id: 2 },
  { id: 60, work_area_id: 2, is_superadmin: true },
].map((u) => ({ active: true, ...u }));

let n = 0;
const a = (fields) => ({ id: ++n, scope_area_ids: [], effect: "concede", ...fields });
const ASSIGNMENTS = [
  // Básico: ver lo propio.
  a({ principal_type: "global", permission_key: K.VER, scope: "propio" }),
  // Jefatura (grupo Jefes), a su cargo.
  a({ principal_type: "jefes", permission_key: K.JEFATURA, scope: "a_cargo" }),
  a({ principal_type: "jefes", permission_key: K.VER, scope: "a_cargo" }),
  // Aprobador de finanzas.
  a({ principal_type: "user", user_id: 40, permission_key: K.FINANZAS, scope: "todo" }),
  a({ principal_type: "user", user_id: 40, permission_key: K.LIQUIDAR, scope: "todo" }),
  a({ principal_type: "user", user_id: 40, permission_key: K.VER, scope: "todo" }),
  a({ principal_type: "user", user_id: 40, permission_key: K.CUENTA }),
  // Asignado puntual: aprueba la jefatura de Tesorería sin ser jefe.
  a({ principal_type: "user", user_id: 50, permission_key: K.JEFATURA, scope: "areas", scope_area_ids: [3] }),
];
const SNAP = { users: new Map(USERS.map((u) => [u.id, u])), areas: AREAS, assignments: ASSIGNMENTS };
const P = (id) => computePermissions(SNAP, { id }, { catalog: CL });

const sol = (fields) => ({ id: 1, kind: "rendicion", status: EXPENSE_STATUS.PENDING, ...fields });
const deTesoreria = sol({ user_id: 31, work_area_id: 3, manager_user_id: 20 });

describe("etapa de jefatura", () => {
  it("la aprueban los jefes de la cadena y el asignado puntual, no Finanzas", () => {
    assert.equal(policy.reviewerStage(deTesoreria, 20, P(20)), "manager", "jefe de Finanzas (de quien cuelga)");
    assert.equal(policy.reviewerStage(deTesoreria, 10, P(10)), "manager", "jefe de más arriba");
    assert.equal(policy.reviewerStage(deTesoreria, 50, P(50)), "manager", "asignado sobre Tesorería");
    assert.equal(policy.reviewerStage(deTesoreria, 40, P(40)), null, "Finanzas no firma la primera etapa");
    assert.equal(policy.reviewerStage(deTesoreria, 33, P(33)), null, "un compañero no");
  });

  it("nadie aprueba lo propio; la del jefe sube al de arriba", () => {
    const delJefe = sol({ user_id: 20, work_area_id: 2 });
    assert.equal(policy.reviewerStage(delJefe, 20, P(20)), null);
    assert.equal(policy.reviewerStage(delJefe, 10, P(10)), "manager");
    assert.equal(policy.reviewerStage(delJefe, 50, P(50)), null, "su asignación es sólo Tesorería");
  });

  it("la del jefe raíz: nadie de la cadena; el superadmin sí", () => {
    const raiz = sol({ user_id: 10, work_area_id: 1, manager_user_id: null });
    for (const id of [10, 20, 40, 50]) assert.equal(policy.reviewerStage(raiz, id, P(id)), null, String(id));
    assert.equal(policy.reviewerStage(raiz, 60, P(60)), "manager");
  });
});

describe("etapa de Finanzas y liquidación", () => {
  const aprobada = { ...deTesoreria, status: EXPENSE_STATUS.APPROVED_MANAGER, manager_reviewed_by: 20 };

  it("la aprueba quien tiene el permiso de Finanzas", () => {
    assert.equal(policy.reviewerStage(aprobada, 40, P(40)), "finance");
    assert.equal(policy.reviewerStage(aprobada, 20, P(20)), null);
  });

  it("la misma persona no firma las dos etapas", () => {
    const firmadaPor40 = { ...aprobada, manager_reviewed_by: 40 };
    assert.equal(policy.reviewerStage(firmadaPor40, 40, P(40)), null);
    assert.equal(policy.reviewerStage(firmadaPor40, 60, P(60)), "finance");
  });

  it("liquida Finanzas, nunca lo propio", () => {
    const final = { ...deTesoreria, status: EXPENSE_STATUS.APPROVED_FINANCE, settled_at: null };
    assert.equal(policy.puedeLiquidar(final, 40, P(40)), true);
    assert.equal(policy.puedeLiquidar(final, 20, P(20)), false);
    assert.equal(policy.puedeLiquidar({ ...final, user_id: 40 }, 40, P(40)), false);
    assert.equal(policy.puedeLiquidar({ ...final, settled_at: new Date() }, 40, P(40)), false);
  });
});

describe("ver y datos sensibles", () => {
  it("ve el dueño, quien la alcanza con «Ver» y quien la puede resolver", () => {
    assert.equal(policy.puedeVer(deTesoreria, 31, P(31)), true);
    assert.equal(policy.puedeVer(deTesoreria, 20, P(20)), true);
    assert.equal(policy.puedeVer(deTesoreria, 40, P(40)), true);
    assert.equal(policy.puedeVer(deTesoreria, 33, P(33)), false, "un compañero sólo ve lo suyo");
    assert.equal(policy.puedeVer({ ...deTesoreria, status: EXPENSE_STATUS.DRAFT }, 20, P(20)), false, "borrador: sólo el dueño");
  });

  it("el RUT: el dueño y quienes pueden aprobarla, sin permiso aparte", () => {
    const con = { ...deTesoreria, requester_document: "12345678-5", requester_document_display: "12.345.678-5" };
    assert.equal(policy.ocultarSensibles(con, 31, P(31)).requester_document_display, "12.345.678-5");
    assert.equal(policy.ocultarSensibles(con, 20, P(20)).requester_document_display, "12.345.678-5");
    assert.equal(policy.ocultarSensibles(con, 40, P(40)).requester_document_display, "12.345.678-5");
    assert.equal(policy.ocultarSensibles(con, 33, P(33)).requester_document_display, null);
  });

  it("la cuenta bancaria: el dueño o con «Ver la cuenta bancaria de destino»", () => {
    const con = { ...deTesoreria, bank_code: "012", bank_account_number: "123" };
    assert.equal(policy.ocultarSensibles(con, 40, P(40)).bank_account_number, "123");
    assert.equal(policy.ocultarSensibles(con, 31, P(31)).bank_account_number, "123");
    assert.equal(policy.ocultarSensibles(con, 20, P(20)).bank_account_number, null);
  });
});

describe("gestión y bandejas", () => {
  it("es revisor quien aprueba, liquida o ve más que lo propio", () => {
    for (const id of [10, 20, 40, 50, 60]) assert.equal(policy.esRevisor(P(id)), true, String(id));
    assert.equal(policy.esRevisor(P(33)), false);
    assert.equal(policy.esFinanzas(P(40)), true);
    assert.equal(policy.esFinanzas(P(20)), false);
  });

  it("el filtro de pendientes numera bien los parámetros y excluye lo propio", () => {
    const f = policy.pendingFilter(P(50), 50, 1);
    assert.equal(f.params[0], 50);
    assert.match(f.clause, /r\.user_id IS DISTINCT FROM \$1/);
    assert.match(f.clause, /r\.work_area_id = ANY\(\$4::int\[\]\)/);
    assert.deepEqual(f.params[3], [3]);
    assert.match(f.clause, /FALSE/, "50 no tiene la etapa de Finanzas");
    const g = policy.historyFilter(P(40), 40, 2);
    assert.equal(g.params[0], 40);
    assert.match(g.clause, /\$2/);
    assert.match(g.clause, /TRUE/, "Finanzas ve todo");
  });
});
