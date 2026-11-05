const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  «Para todos» reemplaza a la antigua pestaña Global: un conjunto se da o se
  quita a toda cuenta activa con una asignación global que concede. La BD es
  una tabla perm_assignments en memoria que imita los WHERE reales.
*/

const SRC = path.join(__dirname, "..", "src");
const dbId = require.resolve(path.join(SRC, "db"));
const prevDb = require.cache[dbId];

let sets;
let assignments;
let audits;
let nextId;

const client = {
  async query(sql, params = []) {
    if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql) || /UPDATE perm_meta/.test(sql)) return { rows: [] };
    if (/FROM perm_sets WHERE id = \$1/.test(sql)) return { rows: sets.filter((s) => s.id === params[0]) };
    if (/FROM perm_assignments\s+WHERE set_id = \$1 AND principal_type = 'global' AND effect = 'concede'/.test(sql)) {
      return {
        rows: assignments.filter((a) => a.set_id === params[0] && a.principal_type === "global" && a.effect === "concede"),
      };
    }
    if (/INSERT INTO perm_assignments/.test(sql)) {
      const row = { id: nextId++, principal_type: "global", set_id: params[0], effect: "concede", granted_by: params[1] };
      assignments.push(row);
      return { rows: [row] };
    }
    if (/DELETE FROM perm_assignments WHERE id = \$1/.test(sql)) {
      assignments = assignments.filter((a) => a.id !== params[0]);
      return { rows: [] };
    }
    if (/INSERT INTO perm_audit/.test(sql)) {
      audits.push({ actor: params[0], action: params[1], entityId: params[3] });
      return { rows: [] };
    }
    throw new Error(`SQL inesperado: ${sql}`);
  },
  release() {},
};

require.cache[dbId] = {
  id: dbId,
  filename: dbId,
  loaded: true,
  exports: {
    getClient: async () => client,
    query: (sql, params) => client.query(sql, params),
  },
};

const store = require("../src/services/permissions/store");

after(() => {
  if (prevDb) require.cache[dbId] = prevDb;
  else delete require.cache[dbId];
});

beforeEach(() => {
  sets = [{ id: 1 }, { id: 2 }];
  assignments = [
    { id: 10, principal_type: "area", area_id: 3, set_id: 1, effect: "concede" },
    { id: 11, principal_type: "global", set_id: 2, effect: "concede" },
  ];
  audits = [];
  nextId = 100;
});

describe("setSetForEveryone", () => {
  it("da el conjunto a todos con una asignación global auditada", async () => {
    assert.deepEqual(await store.setSetForEveryone("1", true, 40), { changed: true });
    const global = assignments.filter((a) => a.set_id === 1 && a.principal_type === "global");
    assert.equal(global.length, 1);
    assert.equal(global[0].granted_by, 40);
    assert.deepEqual(audits, [{ actor: 40, action: "asignacion.conceder", entityId: 100 }]);
    // Las asignaciones a áreas, jefes o personas no se tocan.
    assert.ok(assignments.some((a) => a.id === 10));
  });

  it("repetir la orden no duplica", async () => {
    assert.deepEqual(await store.setSetForEveryone(2, true, 40), { changed: false });
    assert.equal(assignments.filter((a) => a.set_id === 2).length, 1);
    assert.equal(audits.length, 0);
  });

  it("quitar a todos borra sólo lo global de ese conjunto", async () => {
    assert.deepEqual(await store.setSetForEveryone(2, false, 40), { changed: true });
    assert.ok(!assignments.some((a) => a.id === 11));
    assert.ok(assignments.some((a) => a.id === 10));
    assert.deepEqual(audits, [{ actor: 40, action: "asignacion.quitar", entityId: 11 }]);
    assert.deepEqual(await store.setSetForEveryone(2, false, 40), { changed: false });
  });

  it("un conjunto que no existe es un error para el usuario", async () => {
    await assert.rejects(store.setSetForEveryone(99, true, 40), store.PermissionInputError);
    await assert.rejects(store.setSetForEveryone("x", true, 40), store.PermissionInputError);
  });
});
