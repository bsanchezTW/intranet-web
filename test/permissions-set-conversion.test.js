const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { getCatalog } = require("../src/services/permissions/catalog");
const { computePermissions } = require("../src/services/permissions/resolver");
const { planSetConversion } = require("../src/services/permissions/setConversion");

/*
  Los conjuntos de permisos pasan a permisos de a uno y conjuntos de
  personas. Lo importante: nadie gana ni pierde nada. Se compara, persona
  por persona y permiso por permiso, lo que da el resolver antes y después.
*/

const CL = getCatalog("CL");
const conAlcance = [...CL.byKey.values()].filter((p) => p.scopes && p.scopes.includes("areas") && p.scopes.includes("mi_area"));
const sinAlcance = [...CL.byKey.values()].filter((p) => !p.scopes);
const [K1, K2, K3, K4] = sinAlcance.map((p) => p.key);
const S1 = conAlcance[0].key;

const AREAS = [
  { id: 1, parent_area_id: null, manager_user_id: 10 },
  { id: 2, parent_area_id: 1, manager_user_id: 20 },
  { id: 3, parent_area_id: 2, manager_user_id: null },
];
const USERS = [
  { id: 10, active: true, work_area_id: 1 },
  { id: 20, active: true, work_area_id: 2 },
  { id: 31, active: true, work_area_id: 3 },
  { id: 32, active: true, work_area_id: 3 },
  { id: 33, active: true, work_area_id: 2 },
  { id: 40, active: false, work_area_id: 2 },
];

const SETS = new Map([
  [1, { id: 1, code: "basico", name: "Básico", active: true, items: [
    { permission_key: K1 },
    { permission_key: S1, scope: "mi_area", scope_area_ids: [] },
  ] }],
  [2, { id: 2, code: "jefatura", name: "Jefatura", active: true, items: [
    { permission_key: K2 },
    { permission_key: S1, scope: "areas", scope_area_ids: [3], scope_include_subareas: false },
  ] }],
  [3, { id: 3, code: "aprobador", name: "Aprobadores", description: "Finanzas", active: true, items: [
    { permission_key: K3 },
    { permission_key: K2 },
    { permission_key: "clave.que.no.existe" },
  ] }],
  [4, { id: 4, code: "apagado", name: "Apagado", active: false, items: [{ permission_key: K4 }] }],
]);

const a = (id, fields) => ({
  id, area_id: null, user_id: null, include_subareas: false, set_id: null, permission_key: null,
  scope: null, scope_area_ids: [], scope_include_subareas: false, effect: "concede",
  valid_from: null, valid_until: null, note: null, granted_by: null, ...fields,
});

const ANTES = [
  a(1, { principal_type: "global", set_id: 1 }),
  a(2, { principal_type: "jefes", set_id: 2 }),
  // Aprobadores: dos personas sin vigencia → conjunto de personas.
  a(3, { principal_type: "user", user_id: 31, set_id: 3 }),
  a(4, { principal_type: "user", user_id: 33, set_id: 3, note: "Reemplazo" }),
  // Con vigencia: individual por permiso.
  a(5, { principal_type: "user", user_id: 32, set_id: 3, valid_until: "2099-01-01T00:00:00Z" }),
  // Un área deniega lo que la persona tiene individualmente por conjunto: lo
  // individual gana, antes y después.
  a(6, { principal_type: "area", area_id: 3, permission_key: K3, effect: "deniega" }),
  // Denegar un conjunto a una persona.
  a(7, { principal_type: "user", user_id: 20, set_id: 1, effect: "deniega" }),
  // Un conjunto apagado no da nada.
  a(8, { principal_type: "area", area_id: 2, include_subareas: true, set_id: 4 }),
  // Lo suelto no se toca.
  a(9, { principal_type: "user", user_id: 10, permission_key: K4 }),
];

function efectivos(snapshot) {
  const out = {};
  for (const u of USERS) {
    const p = computePermissions(snapshot, { id: u.id }, { catalog: CL, now: Date.parse("2026-11-05T12:00:00Z") });
    out[u.id] = [...CL.byKey.keys()].map((key) => [key, p.can(key), JSON.stringify(p.coverage(key))]);
  }
  return out;
}

const foto = (assignments, extra = {}) => ({
  users: new Map(USERS.map((u) => [u.id, u])),
  areas: AREAS,
  sets: SETS,
  assignments,
  ...extra,
});

function aplicar(plan) {
  let id = 100;
  const despues = ANTES.filter((x) => x.set_id == null).map((x) => ({ ...x }));
  for (const n of plan.assignments) despues.push({ id: id++, set_id: null, ...n });
  const groupMembers = new Map();
  plan.groups.forEach((g, i) => {
    const gid = 500 + i;
    for (const uid of g.memberIds) {
      if (!groupMembers.has(uid)) groupMembers.set(uid, new Set());
      groupMembers.get(uid).add(gid);
    }
    for (const it of g.items) {
      despues.push(a(id++, {
        principal_type: "grupo", group_id: gid, permission_key: it.permission_key, scope: it.scope || null,
        scope_area_ids: it.scope_area_ids || [], scope_include_subareas: Boolean(it.scope_include_subareas),
      }));
    }
  });
  return foto(despues, { sets: new Map(), groupMembers });
}

describe("conversión de conjuntos de permisos", () => {
  const plan = planSetConversion({ sets: SETS, assignments: ANTES, catalog: CL });

  it("nadie gana ni pierde nada", () => {
    const antes = efectivos(foto(ANTES));
    // La comparación no es trivial: antes sí había permisos de conjuntos.
    const tiene = (uid, key) => antes[uid].find((r) => r[0] === key)[1];
    assert.equal(tiene(31, K3), true, "por Aprobadores, aunque su área lo deniega");
    assert.equal(tiene(32, K3), true, "con vigencia");
    assert.equal(tiene(20, K1), false, "se le denegó Básico");
    assert.equal(tiene(20, K2), true, "jefe");
    assert.equal(tiene(33, K4), false, "conjunto apagado");
    assert.deepEqual(efectivos(aplicar(plan)), antes);
  });

  it("los conjuntos dados a personas sin vigencia pasan a conjuntos de personas", () => {
    assert.equal(plan.groups.length, 1);
    assert.equal(plan.groups[0].name, "Aprobadores");
    assert.deepEqual(plan.groups[0].memberIds.sort(), [31, 33]);
    assert.deepEqual(plan.groups[0].items.map((i) => i.permission_key).sort(), [K2, K3].sort());
  });

  it("lo demás se reparte por permiso, con su vigencia y su denegación", () => {
    const de32 = plan.assignments.filter((x) => x.user_id === 32);
    assert.deepEqual(de32.map((x) => x.permission_key).sort(), [K2, K3].sort());
    assert.ok(de32.every((x) => x.valid_until === "2099-01-01T00:00:00Z"));
    const deniega20 = plan.assignments.filter((x) => x.user_id === 20);
    assert.ok(deniega20.every((x) => x.effect === "deniega" && x.scope === null));
    const jefes = plan.assignments.filter((x) => x.principal_type === "jefes");
    assert.deepEqual(jefes.find((x) => x.permission_key === S1).scope_area_ids, [3]);
  });

  it("borra todas las asignaciones de conjuntos y anota lo que no copió", () => {
    assert.deepEqual(plan.deleteIds.sort((x, y) => x - y), [1, 2, 3, 4, 5, 7, 8]);
    assert.ok(plan.skipped.some((s) => s.set === "Apagado"));
    assert.ok(plan.skipped.some((s) => s.key === "clave.que.no.existe"));
  });

  it("sin conjuntos, no hace nada", () => {
    const vacio = planSetConversion({ sets: SETS, assignments: [a(9, { principal_type: "user", user_id: 10, permission_key: K4 })], catalog: CL });
    assert.deepEqual(vacio, { groups: [], assignments: [], deleteIds: [], skipped: [] });
  });
});

describe("conjuntos de personas en el resolver", () => {
  const snap = (assignments, groupMembers) => ({
    users: new Map(USERS.map((u) => [u.id, u])),
    areas: AREAS,
    groupMembers,
    assignments,
  });

  it("lo del conjunto lo recibe cada miembro, y nadie más", () => {
    const s = snap([a(1, { principal_type: "grupo", group_id: 7, permission_key: K1 })], new Map([[31, new Set([7])]]));
    assert.equal(computePermissions(s, { id: 31 }, { catalog: CL }).can(K1), true);
    assert.equal(computePermissions(s, { id: 32 }, { catalog: CL }).can(K1), false);
  });

  it("vale como lo individual: le gana a una denegación del área", () => {
    const s = snap([
      a(1, { principal_type: "grupo", group_id: 7, permission_key: K1 }),
      a(2, { principal_type: "area", area_id: 3, permission_key: K1, effect: "deniega" }),
    ], new Map([[31, new Set([7])]]));
    assert.equal(computePermissions(s, { id: 31 }, { catalog: CL }).can(K1), true);
    assert.equal(computePermissions(s, { id: 32 }, { catalog: CL }).can(K1), false, "mismo área, fuera del conjunto");
  });

  it("una denegación a la persona le gana al conjunto", () => {
    const s = snap([
      a(1, { principal_type: "grupo", group_id: 7, permission_key: K1 }),
      a(2, { principal_type: "user", user_id: 31, permission_key: K1, effect: "deniega" }),
    ], new Map([[31, new Set([7])]]));
    const p = computePermissions(s, { id: 31 }, { catalog: CL });
    assert.equal(p.can(K1), false);
    assert.equal(p.explain(K1).deniedBy.principal, "user");
  });

  it("el origen dice de qué conjunto viene", () => {
    const s = snap([a(1, { principal_type: "grupo", group_id: 7, permission_key: K1 })], new Map([[31, new Set([7])]]));
    const [src] = computePermissions(s, { id: 31 }, { catalog: CL }).explain(K1).sources;
    assert.deepEqual([src.principal, src.groupId, src.level], ["grupo", 7, "usuario"]);
  });
});
