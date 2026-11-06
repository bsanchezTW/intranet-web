const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = "PE";

const { getCatalog } = require("../src/services/permissions/catalog");
const { computePermissions } = require("../src/services/permissions/resolver");
const policy = require("../src/services/vacations/vacationPolicy");

/*
  Vacaciones con Gestión de Permisos. Gerencia (1, jefe 10) › Operaciones
  (2, jefe 20) › Almacén (3, sin jefe). 40 es RRHH (gestiona saldos, no
  aprueba); 50 aprueba Almacén sin ser jefe; 60 es superadmin.
*/

const PE = getCatalog("PE");
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
  a({ principal_type: "global", permission_key: K.ACCESO }),
  a({ principal_type: "global", permission_key: K.CREAR }),
  a({ principal_type: "global", permission_key: K.VER, scope: "propio" }),
  a({ principal_type: "global", permission_key: K.SALDO_VER, scope: "propio" }),
  a({ principal_type: "global", permission_key: K.CALENDARIO, scope: "todo" }),
  // Jefatura.
  a({ principal_type: "jefes", permission_key: K.VER, scope: "a_cargo" }),
  a({ principal_type: "jefes", permission_key: K.APROBAR, scope: "a_cargo" }),
  a({ principal_type: "jefes", permission_key: K.SALDO_VER, scope: "a_cargo" }),
  // Gestión de vacaciones (RRHH): todo menos aprobar.
  ...[K.VER, K.SALDO_VER, K.SALDO_AJUSTAR, K.HISTORIAL].map((key) => a({ principal_type: "user", user_id: 40, permission_key: key, scope: "todo" })),
  ...[K.RECALCULAR, K.EXPORTAR, K.CONFIGURAR].map((key) => a({ principal_type: "user", user_id: 40, permission_key: key })),
  // Asignado puntual.
  a({ principal_type: "user", user_id: 50, permission_key: K.APROBAR, scope: "areas", scope_area_ids: [3] }),
];
const SNAP = { users: new Map(USERS.map((u) => [u.id, u])), areas: AREAS, assignments: ASSIGNMENTS };
const P = (id) => computePermissions(SNAP, { id }, { catalog: PE });
const sol = (userId, areaId) => ({ id: 1, status: "pending", user_id: userId, work_area_id: areaId });

describe("quién aprueba vacaciones", () => {
  it("los jefes de la cadena y el asignado puntual; RRHH no", () => {
    const deAlmacen = sol(31, 3);
    assert.equal(policy.puedeRevisar(deAlmacen, 20, P(20)), true);
    assert.equal(policy.puedeRevisar(deAlmacen, 10, P(10)), true);
    assert.equal(policy.puedeRevisar(deAlmacen, 50, P(50)), true);
    assert.equal(policy.puedeRevisar(deAlmacen, 40, P(40)), false, "RRHH gestiona pero no aprueba");
    assert.equal(policy.puedeRevisar(deAlmacen, 33, P(33)), false);
  });

  it("nadie aprueba lo propio; la del jefe raíz, el superadmin", () => {
    assert.equal(policy.puedeRevisar(sol(20, 2), 20, P(20)), false);
    assert.equal(policy.puedeRevisar(sol(20, 2), 10, P(10)), true);
    for (const id of [10, 20, 40, 50]) assert.equal(policy.puedeRevisar(sol(10, 1), id, P(id)), false, String(id));
    assert.equal(policy.puedeRevisar(sol(10, 1), 60, P(60)), true);
  });

  it("la bandeja de aprobar es de quien tiene el permiso", () => {
    for (const id of [10, 20, 50, 60]) assert.equal(policy.aprueba(P(id)), true, String(id));
    assert.equal(policy.aprueba(P(40)), false);
    assert.equal(policy.aprueba(P(33)), false);
  });
});

describe("gestión de RRHH", () => {
  it("entra quien ve solicitudes o saldos de otros", () => {
    assert.equal(policy.veGestion(P(40)), true);
    assert.equal(policy.veGestion(P(20)), true, "un jefe ve lo de su equipo");
    assert.equal(policy.veGestion(P(33)), false, "lo propio no basta");
  });

  it("las acciones sobre una persona miden el alcance", () => {
    const ana = { id: 31, work_area_id: 3 };
    assert.equal(policy.sobrePersona(P(40), K.SALDO_AJUSTAR, ana), true);
    assert.equal(policy.sobrePersona(P(20), K.SALDO_VER, ana), true);
    assert.equal(policy.sobrePersona(P(20), K.SALDO_AJUSTAR, ana), false, "el jefe no ajusta saldos");
    assert.equal(policy.sobrePersona(P(33), K.SALDO_VER, ana), false);
  });

  it("los filtros SQL excluyen lo propio y miden el área actual", () => {
    const f = policy.pendingFilter(P(50), 50, 3);
    assert.deepEqual(f.params, [50, [3]]);
    assert.match(f.clause, /r\.user_id IS DISTINCT FROM \$3/);
    assert.match(f.clause, /u\.work_area_id = ANY\(\$4::int\[\]\)/);
    assert.equal(policy.verFilter(P(40), 2).clause, "TRUE");
    assert.equal(policy.verFilter(P(33), 2).clause, "(r.user_id = $2)");
  });
});
