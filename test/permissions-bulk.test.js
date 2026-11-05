const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ejs = require("ejs");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  «Asignar varios» de un módulo en la pestaña Permisos: varios permisos al
  mismo destinatario, en una transacción. La BD es perm_assignments en
  memoria.
*/

const SRC = path.join(__dirname, "..", "src");
const dbId = require.resolve(path.join(SRC, "db"));
const prevDb = require.cache[dbId];

let assignments;
let audits;
let committed;
let nextId;

const client = {
  async query(sql, params = []) {
    if (/^BEGIN/.test(sql)) { committed = false; return { rows: [] }; }
    if (/^COMMIT/.test(sql)) { committed = true; return { rows: [] }; }
    if (/^ROLLBACK/.test(sql) || /UPDATE perm_meta/.test(sql)) return { rows: [] };
    if (/SELECT id FROM work_areas/.test(sql)) return { rows: [{ id: 1 }, { id: 2 }] };
    if (/SELECT id FROM users/.test(sql)) return { rows: [{ id: 7 }, { id: 8 }] };
    if (/SELECT id FROM perm_groups/.test(sql)) return { rows: [{ id: 20 }] };
    if (/SELECT 1 FROM perm_assignments/.test(sql)) {
      const [type, area, user, group, subareas, key, scope, effect] = params;
      const hit = assignments.find((a) => a.principal_type === type && (a.area_id ?? null) === area
        && (a.user_id ?? null) === user && (a.group_id ?? null) === group && Boolean(a.include_subareas) === subareas
        && a.permission_key === key && (a.scope ?? null) === scope && a.effect === effect);
      return { rows: hit ? [{ "?column?": 1 }] : [] };
    }
    if (/INSERT INTO perm_assignments/.test(sql)) {
      const row = {
        id: nextId++, principal_type: params[0], area_id: params[1], user_id: params[2], include_subareas: params[3],
        group_id: params[4], permission_key: params[5], scope: params[6], effect: params[9],
      };
      assignments.push(row);
      return { rows: [row] };
    }
    if (/INSERT INTO perm_audit/.test(sql)) { audits.push(params[1]); return { rows: [] }; }
    throw new Error(`SQL inesperado: ${sql}`);
  },
  release() {},
};

require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true,
  exports: { getClient: async () => client, query: (sql, params) => client.query(sql, params) },
};

const store = require("../src/services/permissions/store");
const { itemsFromBulkBody } = require("../src/routes/permisos");
const { getCatalog } = require("../src/services/permissions/catalog");
const { SCOPE_LABELS } = require("../src/services/permissions/scopes");
const { buildTree } = require("../src/services/workAreaTree");
const { getCountryConfig, getCurrentCountry } = require("../src/config/country");
const { getFeatures } = require("../src/config/features");

after(() => {
  if (prevDb) require.cache[dbId] = prevDb;
  else delete require.cache[dbId];
});

const CL = getCatalog("CL");
const sinAlcance = [...CL.byKey.values()].filter((p) => !p.scopes).map((p) => p.key);
const conAlcance = [...CL.byKey.values()].find((p) => p.scopes && p.scopes.includes("todo")).key;

beforeEach(() => {
  assignments = [];
  audits = [];
  committed = null;
  nextId = 1;
});

describe("itemsFromBulkBody", () => {
  it("toma las claves marcadas y el alcance de cada una, sin repetir", () => {
    assert.deepEqual(
      itemsFromBulkBody({ keys: ["a.b.c", "d.e.f", "a.b.c"], "scope:d.e.f": "todo", "scope:x.y.z": "propio" }),
      [{ permission_key: "a.b.c", scope: null }, { permission_key: "d.e.f", scope: "todo" }],
    );
    assert.deepEqual(itemsFromBulkBody({ keys: "a.b.c" }), [{ permission_key: "a.b.c", scope: null }]);
    assert.deepEqual(itemsFromBulkBody({}), []);
  });
});

describe("createAssignments", () => {
  const base = { principal_type: "grupo", group_id: "20", effect: "concede" };

  it("guarda todos los marcados al mismo destinatario, cada uno auditado", async () => {
    const r = await store.createAssignments(base, [
      { permission_key: sinAlcance[0] },
      { permission_key: sinAlcance[1] },
      { permission_key: conAlcance, scope: "todo" },
    ], 1, { catalog: CL });
    assert.deepEqual(r, { created: 3, skipped: 0 });
    assert.ok(assignments.every((a) => a.principal_type === "grupo" && a.group_id === 20));
    assert.equal(assignments.find((a) => a.permission_key === conAlcance).scope, "todo");
    assert.deepEqual(audits, ["asignacion.conceder", "asignacion.conceder", "asignacion.conceder"]);
    assert.equal(committed, true);
  });

  it("lo que ya estaba igual no se repite", async () => {
    await store.createAssignments(base, [{ permission_key: sinAlcance[0] }], 1, { catalog: CL });
    const r = await store.createAssignments(base, [{ permission_key: sinAlcance[0] }, { permission_key: sinAlcance[1] }], 1, { catalog: CL });
    assert.deepEqual(r, { created: 1, skipped: 1 });
    assert.equal(assignments.length, 2);
  });

  it("si uno no es válido no se guarda ninguno", async () => {
    await assert.rejects(
      store.createAssignments(base, [{ permission_key: sinAlcance[0] }, { permission_key: conAlcance }], 1, { catalog: CL }),
      /Elige sobre qué registros/,
    );
    assert.equal(assignments.length, 0);
    assert.notEqual(committed, true);
  });

  it("denegar varios no guarda alcance", async () => {
    await store.createAssignments({ principal_type: "user", user_id: "8", effect: "deniega" }, [{ permission_key: conAlcance, scope: "todo" }], 1, { catalog: CL });
    assert.equal(assignments[0].effect, "deniega");
    assert.equal(assignments[0].scope, null);
  });

  it("sin nada marcado avisa", async () => {
    await assert.rejects(store.createAssignments(base, [], 1, { catalog: CL }), /al menos un permiso/);
  });
});

describe("vista: Asignar varios en la pestaña Permisos", () => {
  it("una casilla por permiso del módulo y alcance sin «Áreas elegidas»", async () => {
    const country = getCurrentCountry();
    const catalog = getCatalog(country);
    const current = catalog.modules.find((m) => m.permissions.some((p) => p.scopes)) || catalog.modules[0];
    const areas = [{ id: 1, area_name: "Gerencia", parent_area_id: null, manager_user_id: null }];
    const users = [{ id: 10, name: "Gustavo", role: "Usuario", work_area_id: 1, is_superadmin: false }];
    const groups = [{ id: 20, name: "Aprobadores", member_count: 2 }];
    const html = await ejs.renderFile(path.join(SRC, "views", "permisos", "modulos.ejs"), {
      country, countryConfig: getCountryConfig(country), features: getFeatures(country), catalog,
      refs: { areas, areaById: new Map([[1, areas[0]]]), users, userById: new Map([[10, users[0]]]), groups, groupById: new Map([[20, groups[0]]]) },
      scopeLabels: SCOPE_LABELS, areaTree: buildTree(areas), activeUsers: users, actorId: 40,
      seccion: "modulos", modules: catalog.modules, current, whoHas: new Map(), holders: new Map(),
    }, { async: false });
    assert.ok(html.includes('action="/permisos/asignaciones/varias"'));
    assert.match(html, new RegExp(`Asignar varios de ${current.label}`));
    for (const p of current.permissions) assert.ok(html.includes(`name="keys" value="${p.key}"`), p.key);
    const scoped = current.permissions.find((p) => p.scopes);
    if (scoped) {
      const select = html.slice(html.indexOf(`name="scope:${scoped.key}"`)).split("</select>")[0];
      assert.doesNotMatch(select, /value="areas"/);
    }
    assert.match(html, /data-perm-marcar-todos/);
  });
});
