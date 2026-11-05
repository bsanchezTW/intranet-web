const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.COUNTRY = "CL"; // Soporte sólo existe en Chile.

/*
  Soporte con Gestión de Permisos: la mesa de ayuda es quien tiene
  «Asignar, priorizar y cerrar tickets», no el área Informática por nombre.
  usersWhoCan arma la lista desde la foto de permisos (base en memoria).
*/

const SRC = path.join(__dirname, "..", "src");
const dbId = require.resolve(path.join(SRC, "db"));
const prevDb = require.cache[dbId];

const USERS = [
  { id: 1, role: "Usuario", work_area_id: 10, is_superadmin: true, first_name: "Bastián", last_name: "S", email: "b@t.cl" },
  { id: 2, role: "Usuario", work_area_id: 10, is_superadmin: false, first_name: "Sofía", last_name: "Soporte", email: "sofia@t.cl" },
  { id: 3, role: "Administrador", work_area_id: 20, is_superadmin: false, first_name: "Marta", last_name: "Marketing", email: "marta@t.cl" },
  { id: 4, role: "Deshabilitado", work_area_id: 10, is_superadmin: false, first_name: "Ex", last_name: "TI", email: "ex@t.cl" },
];
const ASSIGNMENTS = [
  // Mesa de ayuda: el área 10 (Informática).
  { id: 1, principal_type: "area", area_id: 10, permission_key: "soporte.ticket.gestionar", scope_area_ids: [], effect: "concede" },
  { id: 2, principal_type: "area", area_id: 10, permission_key: "soporte.ticket.ver", scope: "todo", scope_area_ids: [], effect: "concede" },
  // Marta (Administrador) ve todos pero no gestiona.
  { id: 3, principal_type: "user", user_id: 3, permission_key: "soporte.ticket.ver", scope: "todo", scope_area_ids: [], effect: "concede" },
];

require.cache[dbId] = {
  id: dbId, filename: dbId, loaded: true,
  exports: {
    async query(sql, params = []) {
      if (/SELECT version FROM perm_meta/.test(sql)) return { rows: [{ version: 1 }] };
      if (/SELECT id, role, work_area_id, is_superadmin FROM users/.test(sql)) return { rows: USERS };
      if (/FROM work_areas/.test(sql)) return { rows: [{ id: 10, parent_area_id: null, manager_user_id: null }, { id: 20, parent_area_id: null, manager_user_id: null }] };
      if (/FROM perm_group_members/.test(sql)) return { rows: [] };
      if (/FROM perm_assignments/.test(sql)) return { rows: ASSIGNMENTS };
      if (/FROM users u\s+WHERE u.id = ANY/.test(sql)) {
        return { rows: USERS.filter((u) => params[0].includes(u.id)) };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  },
};

let permissions;
let supportTeam;
before(() => {
  permissions = require("../src/services/permissions/permissionService");
  supportTeam = require("../src/services/tickets/supportTeam");
});
after(() => {
  if (prevDb) require.cache[dbId] = prevDb;
  else delete require.cache[dbId];
});

describe("usersWhoCan", () => {
  it("devuelve quienes tienen el permiso, sin superadmins ni cuentas deshabilitadas", async () => {
    assert.deepEqual(await permissions.usersWhoCan("soporte.ticket.gestionar"), [2]);
    assert.deepEqual((await permissions.usersWhoCan("soporte.ticket.gestionar", null, { includeSuperadmins: true })).sort(), [1, 2]);
  });

  it("con un registro, mide el alcance", async () => {
    assert.deepEqual((await permissions.usersWhoCan("soporte.ticket.ver", { ownerId: 9 })).sort(), [2, 3]);
  });
});

describe("mesa de ayuda por permiso", () => {
  it("la forman quienes gestionan tickets; ver todo no basta", async () => {
    assert.deepEqual((await supportTeam.listSupportAgents()).map((a) => a.name), ["Sofía Soporte"]);
    assert.deepEqual(await supportTeam.supportAgentEmails(), ["sofia@t.cl"]);
  });

  it("el superadmin puede tomar tickets pero no recibe los avisos del equipo", async () => {
    assert.ok(await supportTeam.getAgentById(1));
    assert.equal(await supportTeam.getAgentById(3), null, "Marta ve todo pero no gestiona");
    assert.ok(!(await supportTeam.supportAgentEmails()).includes("b@t.cl"));
  });

  it("isSupportAgent sale del permiso, no del rol", async () => {
    assert.equal(await supportTeam.isSupportAgent({ id: 2 }), true);
    assert.equal(await supportTeam.isSupportAgent({ id: 3 }), false);
  });
});
