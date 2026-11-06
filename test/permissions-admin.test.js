const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const http = require("node:http");
const ejs = require("ejs");
const express = require("express");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { getCatalog } = require("../src/services/permissions/catalog");
const { SCOPE_LABELS } = require("../src/services/permissions/scopes");
const {
  PermissionInputError,
  validateGrant,
  validateAssignment,
} = require("../src/services/permissions/store");
const { describeAssignment, removalPlan, holdersByKey } = require("../src/services/permissions/adminQueries");
const { orgTree, areaInOrg, personInOrg, managersUp } = require("../src/services/permissions/orgView");
const { buildTree } = require("../src/services/workAreaTree");
const { getCountryConfig, getCurrentCountry } = require("../src/config/country");
const { getFeatures } = require("../src/config/features");

const CL = getCatalog("CL");
const AREAS = new Set([1, 2, 3]);
const USERS = new Set([7, 8, 9]);
const GROUPS = new Set([20]);
const ctx = { catalog: CL, areaIds: AREAS, userIds: USERS, groupIds: GROUPS, actorId: 7 };
const LEER = "noticias.noticia.ver";

describe("validación de permisos y alcances", () => {
  it("un permiso sin alcance ignora el alcance que llegue", () => {
    assert.deepEqual(validateGrant({ permission_key: "noticias.noticia.crear", scope: "todo" }, ctx), {
      permission_key: "noticias.noticia.crear",
      scope: null,
      scope_area_ids: [],
      scope_include_subareas: false,
    });
  });

  it("un permiso con alcance exige uno de los que admite", () => {
    assert.throws(() => validateGrant({ permission_key: "gastos.solicitud.aprobar_jefatura" }, ctx), PermissionInputError);
    assert.throws(
      () => validateGrant({ permission_key: "gastos.solicitud.aprobar_jefatura", scope: "propio" }, ctx),
      /Elige sobre qué registros/,
    );
    assert.equal(validateGrant({ permission_key: "gastos.solicitud.aprobar_jefatura", scope: "a_cargo" }, ctx).scope, "a_cargo");
  });

  it("áreas elegidas: al menos una y que existan", () => {
    const base = { permission_key: "gastos.solicitud.ver", scope: "areas" };
    assert.throws(() => validateGrant(base, ctx), /al menos un área/);
    assert.throws(() => validateGrant({ ...base, scope_area_ids: ["99"] }, ctx), /ya no existe/);
    assert.deepEqual(validateGrant({ ...base, scope_area_ids: ["2", "2", "3"], scope_include_subareas: "1" }, ctx), {
      permission_key: "gastos.solicitud.ver",
      scope: "areas",
      scope_area_ids: [2, 3],
      scope_include_subareas: true,
    });
  });

  it("un permiso que el país no tiene no se guarda", () => {
    assert.throws(() => validateGrant({ permission_key: "vacaciones.solicitud.crear" }, ctx), /no existe/);
  });

});

describe("validación de asignaciones", () => {
  const ahora = new Date("2026-10-19T15:00:00Z");
  const valida = (input) => validateAssignment(input, { ...ctx, now: ahora, timeZone: "America/Santiago" });

  it("a una persona, un permiso", () => {
    const v = valida({ principal_type: "user", user_id: "8", permission_key: LEER });
    assert.equal(v.user_id, 8);
    assert.equal(v.permission_key, LEER);
    assert.equal(v.effect, "concede");
  });

  it("a un conjunto de personas, que tiene que existir", () => {
    const v = valida({ principal_type: "grupo", group_id: "20", permission_key: LEER });
    assert.equal(v.group_id, 20);
    assert.equal(v.user_id, null);
    assert.throws(() => valida({ principal_type: "grupo", group_id: "21", permission_key: LEER }), /conjunto de personas/);
    assert.throws(() => valida({ principal_type: "grupo", permission_key: LEER }), /conjunto de personas/);
  });

  it("ya no se asignan conjuntos de permisos: falta el permiso", () => {
    assert.throws(() => valida({ principal_type: "global", set_id: "20" }), /no existe/);
  });

  it("nadie cambia sus propias asignaciones", () => {
    assert.throws(() => valida({ principal_type: "user", user_id: "7", permission_key: LEER }), /propias/);
  });

  it("un área necesita área; los jefes pueden ser de cualquiera", () => {
    assert.throws(() => valida({ principal_type: "area", permission_key: LEER }), /Elige el área/);
    const jefes = valida({ principal_type: "jefes", permission_key: LEER, include_subareas: "1" });
    assert.equal(jefes.area_id, null);
    assert.equal(jefes.include_subareas, false, "sin área no hay subáreas");
  });

  it("denegar quita el permiso entero: no guarda alcance", () => {
    const v = valida({
      principal_type: "user",
      user_id: "8",
      permission_key: "gastos.solicitud.ver",
      scope: "todo",
      effect: "deniega",
    });
    assert.equal(v.effect, "deniega");
    assert.equal(v.scope, null);
  });

  it("la vigencia se lee en la zona del país e incluye el último día", () => {
    const v = valida({
      principal_type: "user",
      user_id: "8",
      permission_key: LEER,
      valid_from: "2026-10-20",
      valid_until: "2026-10-31",
    });
    // Chile en octubre: UTC-3.
    assert.equal(v.valid_from.toISOString(), "2026-10-20T03:00:00.000Z");
    assert.equal(v.valid_until.toISOString(), "2026-11-01T03:00:00.000Z");
  });

  it("una vigencia al revés o ya terminada se rechaza", () => {
    assert.throws(
      () => valida({ principal_type: "global", permission_key: LEER, valid_from: "2026-10-30", valid_until: "2026-10-20" }),
      /terminar después/,
    );
    assert.throws(() => valida({ principal_type: "global", permission_key: LEER, valid_until: "2026-10-10" }), /ya terminó/);
  });

  it("el destinatario tiene que existir", () => {
    assert.throws(() => valida({ principal_type: "nadie", permission_key: LEER }), /a quién/);
    assert.throws(() => valida({ principal_type: "user", user_id: "55", permission_key: LEER }), /persona/);
  });
});

describe("/permisos sólo para el superadmin", () => {
  function servidor(perms) {
    const app = express();
    app.use((req, res, next) => {
      req.session = { user: { id: 8 } };
      req.perms = perms;
      res.render = (view) => res.status(res.statusCode).json({ view });
      next();
    });
    app.use("/permisos", require("../src/routes/permisos"));
    return app;
  }

  async function get(app, url) {
    const server = http.createServer(app).listen(0);
    try {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}${url}`);
      return { status: res.status, body: await res.json().catch(() => null) };
    } finally {
      server.close();
    }
  }

  it("para el resto la página no existe", async () => {
    for (const url of ["/permisos", "/permisos/modulos", "/permisos/usuarios/8", "/permisos/auditoria"]) {
      const r = await get(servidor({ superadmin: false }), url);
      assert.equal(r.status, 404, url);
      assert.equal(r.body.view, "404");
    }
    const sinPermisos = await get(servidor(undefined), "/permisos");
    assert.equal(sinPermisos.status, 404);
  });
});

describe("las vistas renderizan con datos de prueba", () => {
  const VIEWS = path.join(__dirname, "..", "src", "views", "permisos");
  const country = getCurrentCountry();
  const catalog = getCatalog(country);

  const areas = [
    { id: 1, area_name: "Gerencia", parent_area_id: null, manager_user_id: 10 },
    { id: 2, area_name: "Finanzas", parent_area_id: 1, manager_user_id: 20 },
    { id: 3, area_name: "Comercial", parent_area_id: 1, manager_user_id: null },
  ];
  const users = [
    { id: 10, name: "Gustavo Valenzuela", first_name: "Gustavo", email: "g@x.cl", active: true, work_area_id: 1, is_superadmin: false },
    { id: 20, name: "Freddy Payano", first_name: "Freddy", email: "f@x.cl", active: true, work_area_id: 2, is_superadmin: false },
    { id: 31, name: "Astrid Ortiz", first_name: "Astrid", email: "a@x.cl", active: true, work_area_id: 2, is_superadmin: false },
    { id: 40, name: "Bastián Sánchez", first_name: "Bastián", email: "b@x.cl", active: true, work_area_id: 3, is_superadmin: true },
  ];
  const groups = [
    { id: 1, name: "Aprobadores", description: "Aprueban rendiciones", member_count: 2, assignment_count: 1 },
    { id: 2, name: "Vacío", description: null, member_count: 0, assignment_count: 0 },
  ];
  const refs = {
    areas,
    areaById: new Map(areas.map((a) => [a.id, a])),
    users,
    userById: new Map(users.map((u) => [u.id, u])),
    groups,
    groupById: new Map(groups.map((g) => [g.id, g])),
  };
  const anyKey = catalog.modules[0].permissions[1].key;
  const scopedKey = [...catalog.byKey.values()].find((p) => p.scopes && p.scopes.includes("areas")).key;
  const assignments = [
    { id: 1, principal_type: "grupo", group_id: 1, permission_key: anyKey, effect: "concede", scope_area_ids: [] },
    { id: 2, principal_type: "user", user_id: 31, permission_key: scopedKey, scope: "areas", scope_area_ids: [2, 3], effect: "concede", valid_until: "2027-01-01T03:00:00Z", note: "Reemplazo", granted_by: 40 },
    { id: 3, principal_type: "area", area_id: 2, include_subareas: true, permission_key: anyKey, effect: "deniega", scope_area_ids: [], valid_until: "2020-01-01T00:00:00Z" },
  ].map((a) => describeAssignment(a, refs, catalog));

  const base = {
    country,
    countryConfig: getCountryConfig(country),
    features: getFeatures(country),
    catalog,
    refs,
    scopeLabels: SCOPE_LABELS,
    areaTree: buildTree(areas),
    activeUsers: users,
    actorId: 40,
  };

  async function render(view, data) {
    return ejs.renderFile(path.join(VIEWS, `${view}.ejs`), { ...base, ...data }, { async: false });
  }

  it("resumen", async () => {
    const html = await render("index", {
      seccion: "inicio",
      meta: { version: 3, bootstrapped_at: null },
      totals: { concede: 5, deniega: 1 },
      superadmins: [users[3]],
      permissionCount: catalog.byKey.size,
    });
    assert.match(html, /Falta el arranque/);
    assert.match(html, /Bastián Sánchez/);
    assert.doesNotMatch(html, /Modo sombra/);

    const conArranque = await render("index", {
      seccion: "inicio",
      meta: { version: 3, bootstrapped_at: new Date() },
      totals: { concede: 5, deniega: 1 },
      superadmins: [users[3]],
      permissionCount: catalog.byKey.size,
    });
    assert.doesNotMatch(conArranque, /Falta el arranque/);
    assert.doesNotMatch(conArranque, /Diferencias del modo sombra/);
    assert.match(conArranque, /Arranque aplicado el/);
  });

  it("por módulo, con quién tiene cada permiso y cómo quitárselo", async () => {
    const whoHas = new Map([[anyKey, [{ assignment: assignments[0], scopeLabel: null }]]]);
    const holders = new Map([[anyKey, {
      granted: [{ user: users[2], areaName: "Finanzas", alcance: null, origins: ["Conjunto «Aprobadores»"], removal: { mode: "denegar", deleteIds: [] } }],
      denied: [{ user: users[1], areaName: "Finanzas", deniedBy: "a la persona", assignmentId: 9 }],
    }]]);
    const html = await render("modulos", { seccion: "modulos", modules: catalog.modules, current: catalog.modules[0], whoHas, holders });
    // Una asignación a un conjunto de personas enlaza al conjunto y se quita como cualquier otra.
    assert.ok(html.includes('<a href="/permisos/conjuntos/1"><strong>Conjunto «Aprobadores»</strong></a>'));
    assert.ok(html.includes('action="/permisos/asignaciones/1/eliminar"'));
    assert.doesNotMatch(html, /Editar conjunto|Quitar conjunto/);
    assert.match(html, /A nadie: sólo lo tienen los superadmins/);
    assert.match(html, /data-perm-form/);
    // El formulario elige destinatario, también un conjunto de personas.
    assert.match(html, /<option value="grupo">Un conjunto de personas<\/option>/);
    assert.match(html, /<option value="1">Aprobadores \(2\)<\/option>/);
    assert.doesNotMatch(html, /name="target"/);
    // Quitar a una persona: el aviso dice que se le deniega sólo a ella.
    assert.ok(html.includes('action="/permisos/quitar"'));
    assert.match(html, /Se le denegará sólo a esta persona/);
    assert.ok(html.includes('action="/permisos/asignaciones/9/eliminar"'));
    assert.match(html, /Quitar denegación/);
  });

  it("conjuntos de personas", async () => {
    const lista = await render("conjuntos", { seccion: "conjuntos" });
    assert.match(lista, /Aprobadores/);
    assert.match(lista, /Crear y agregar personas/);
    assert.ok(!lista.includes('href="/permisos/global"'));

    const html = await render("conjunto", {
      seccion: "conjuntos",
      group: { ...groups[0], members: [users[2]], assignments: [assignments[0]] },
    });
    // Miembros: se sacan uno a uno; para agregar, sólo quien no está, sin superadmins.
    assert.ok(html.includes('action="/permisos/conjuntos/1/miembros/31/quitar"'));
    assert.ok(html.includes('action="/permisos/conjuntos/1/miembros"'));
    assert.match(html, /name="user_id" value="10"/);
    assert.doesNotMatch(html, /name="user_id" value="31"/, "ya está");
    assert.doesNotMatch(html, /name="user_id" value="40"/, "superadmin");
    // Sus permisos se ven y se quitan aquí; se asignan en Permisos.
    assert.ok(html.includes('action="/permisos/asignaciones/1/eliminar"'));
    assert.ok(html.includes('href="/permisos/modulos"'));
    assert.match(html, /Eliminar conjunto/);

    const vacio = await render("conjunto", { seccion: "conjuntos", group: { ...groups[1], members: [], assignments: [] } });
    assert.match(vacio, /Nadie en este conjunto todavía/);
    assert.match(vacio, /todavía no tiene permisos/);
  });

  it("destinatarios: global, jefes y un área", async () => {
    for (const principal of [
      { type: "global", label: "Todos", desc: "x" },
      { type: "jefes", label: "Jefes de área", desc: "x" },
      { type: "area", areaId: 2, label: "Finanzas", desc: "x" },
    ]) {
      const html = await render("destinatario", {
        titulo: "T",
        seccion: principal.type === "area" ? "areas" : principal.type,
        assignments,
        principal,
        people: principal.type === "area" ? [users[1], users[2]] : undefined,
      });
      assert.match(html, /Reemplazo/);
      assert.match(html, /Vencida el/);
      // Cada asignación se puede editar.
      assert.ok(html.includes("action=\"/permisos/asignaciones/2\" method=\"POST\" hidden data-perm-edit"));
      assert.match(html, /name="valid_until" value="2026-12-31"/);
    }
    const area = await render("destinatario", {
      titulo: "Finanzas",
      seccion: "areas",
      assignments: [],
      principal: { type: "area", areaId: 2, label: "Finanzas", desc: "x" },
      people: areaInOrg(refs, 2).members,
      enOrg: areaInOrg(refs, 2),
    });
    assert.match(area, /Freddy Payano/);
    assert.ok(area.includes("Gustavo Valenzuela</a><span class=\"perm-muted\">jefe de Gerencia"));
    const jefes = await render("destinatario", {
      titulo: "Jefes",
      seccion: "jefes",
      assignments: [],
      principal: { type: "jefes", label: "Jefes de área", desc: "x" },
      jefes: [{ user: users[1], areas: [areas[1]], above: managersUp(refs, 1) }],
    });
    assert.match(jefes, /Jefes hoy/);
    assert.match(jefes, /Gustavo Valenzuela/);
    const org = await render("areas", { seccion: "areas", org: orgTree(refs, { assignmentCounts: new Map([[2, 1]]) }), sinArea: [] });
    assert.match(org, /Finanzas/);
    assert.match(org, /1 asignación/);
    assert.match(org, /sin jefe: responde Gustavo Valenzuela/);
  });

  it("personas y ficha con origen y denegaciones", async () => {
    assert.match(await render("usuarios", { seccion: "usuarios", q: "", list: users }), /Superadmin/);
    const html = await render("usuario", {
      seccion: "usuarios",
      detail: {
        user: users[2],
        area: areas[1],
        managed: [],
        groups: [groups[0]],
        superadmin: false,
        org: personInOrg(refs, 31),
        direct: [assignments[1]],
        grantedCount: 1,
        modules: [
          {
            module: "x",
            label: "Módulo",
            permissions: [
              { key: anyKey, label: "Ver", granted: true, alcance: null, origins: ["Conjunto «Aprobadores»"], deniedBy: null, removal: { mode: "denegar", deleteIds: [] } },
              { key: scopedKey, label: "Otro", granted: false, alcance: null, origins: [], deniedBy: "Finanzas", denialId: 3 },
            ],
          },
        ],
      },
    });
    assert.match(html, /Conjunto «Aprobadores»/);
    assert.match(html, /Denegado: Finanzas/);
    // Sus conjuntos: sacarla de uno y agregarla a otro.
    assert.ok(html.includes('action="/permisos/conjuntos/1/miembros/31/quitar"'));
    assert.ok(html.includes('action="/permisos/usuarios/31/conjuntos"'));
    assert.match(html, /<option value="2">Vacío<\/option>/);
    // Ya no se asigna aquí: se manda a Permisos.
    assert.doesNotMatch(html, /data-perm-form/);
    assert.ok(html.includes('href="/permisos/modulos"'));
    assert.match(html, /Hacer superadmin/);
    assert.ok(html.includes("action=\"/permisos/quitar\""));
    assert.match(html, /En el organigrama/);
  });

  it("auditoría", async () => {
    const html = await render("auditoria", {
      seccion: "auditoria",
      page: 0,
      audit: {
        hasMore: true,
        rows: [{ id: 1, occurred_at: new Date(), actorName: "Bastián Sánchez", action: "asignacion.denegar", entity_type: "asignacion", entity_id: 3, old_value: null, new_value: { a: 1 }, note: null }],
      },
    });
    assert.match(html, /Denegó/);
    assert.match(html, /Anteriores/);
  });
});

describe("organigrama dentro de Gestión de Permisos", () => {
  // Gerencia (Gustavo) › Finanzas (Freddy) › Tesorería (Astrid) y Contabilidad (sin jefe).
  const areas = [
    { id: 1, area_name: "Gerencia", parent_area_id: null, manager_user_id: 10 },
    { id: 2, area_name: "Finanzas", parent_area_id: 1, manager_user_id: 20 },
    { id: 3, area_name: "Tesorería", parent_area_id: 2, manager_user_id: 31 },
    { id: 4, area_name: "Contabilidad", parent_area_id: 2, manager_user_id: null },
  ];
  const users = [
    { id: 10, name: "Gustavo", active: true, work_area_id: 1 },
    { id: 20, name: "Freddy", active: true, work_area_id: 2 },
    { id: 31, name: "Astrid", active: true, work_area_id: 2 },
    { id: 32, name: "Marco", active: true, work_area_id: 3 },
    { id: 33, name: "Lucía", active: true, work_area_id: 4 },
    { id: 34, name: "Ex", active: false, work_area_id: 4 },
  ];
  const refs = {
    areas,
    areaById: new Map(areas.map((a) => [a.id, a])),
    users,
    userById: new Map(users.map((u) => [u.id, u])),
  };

  it("jefes de la cadena, del directo hacia arriba y sin repetir", () => {
    assert.deepEqual(managersUp(refs, 3).map((b) => b.manager.name), ["Astrid", "Freddy", "Gustavo"]);
    // Astrid trabaja en Finanzas: su jefe directo es Freddy, no ella misma.
    assert.deepEqual(personInOrg(refs, 31).bosses.map((b) => b.manager.name), ["Freddy", "Gustavo"]);
  });

  it("a cargo de un jefe: lo que dirige y todo lo que cuelga, sin contarlo a él", () => {
    const freddy = personInOrg(refs, 20);
    assert.deepEqual(freddy.underAreas.map((a) => a.id).sort(), [2, 3, 4]);
    assert.equal(freddy.underCount, 3, "Astrid, Marco y Lucía; la cuenta deshabilitada no");
    assert.deepEqual(personInOrg(refs, 33).manages, []);
  });

  it("un área sabe su jefe, los de arriba, sus subáreas y su gente", () => {
    const fin = areaInOrg(refs, 2);
    assert.equal(fin.manager.name, "Freddy");
    assert.deepEqual(fin.above.map((b) => b.manager.name), ["Gustavo"]);
    assert.deepEqual(fin.path.map((a) => a.area_name), ["Gerencia", "Finanzas"]);
    assert.deepEqual(fin.members.map((u) => u.name), ["Freddy", "Astrid"]);
    assert.equal(fin.belowCount, 2);
    assert.equal(areaInOrg(refs, 99), null);
  });

  it("el árbol cuenta personas con subáreas", () => {
    const [gerencia] = orgTree(refs);
    assert.equal(gerencia.subtreeCount, 5);
    const finanzas = gerencia.children[0];
    assert.equal(finanzas.children.length, 2);
    const conta = finanzas.children.find((c) => c.id === 4);
    assert.equal(conta.manager, null);
    assert.deepEqual(conta.above.map((b) => b.manager.name), ["Freddy", "Gustavo"]);
  });
});

describe("quitarle un permiso a una persona", () => {
  const KEY = "inicio.linkedin.configurar";

  it("si sólo le llega por asignaciones suyas, se borran", () => {
    assert.deepEqual(removalPlan([{ assignmentId: 6, principal: "user" }]), { mode: "quitar", deleteIds: [6] });
  });

  it("si le llega por su área, todos o un conjunto de personas, se le deniega sólo a ella", () => {
    assert.deepEqual(
      removalPlan([{ assignmentId: 6, principal: "user" }, { assignmentId: 8, principal: "area", areaId: 2 }]),
      { mode: "denegar", deleteIds: [6] },
    );
    assert.equal(removalPlan([{ assignmentId: 9, principal: "global" }]).mode, "denegar");
    assert.equal(removalPlan([{ assignmentId: 10, principal: "grupo", groupId: 1 }]).mode, "denegar");
  });

  it("quiénes lo tienen, persona por persona, y a quién se le denegó", async () => {
    if (!getCatalog(getCurrentCountry()).byKey.has(KEY)) return; // LinkedIn es sólo de Chile.
    const catalog = getCatalog(getCurrentCountry());
    const areas = [{ id: 2, area_name: "Finanzas", parent_area_id: null, manager_user_id: null }];
    const users = [
      { id: 20, name: "Freddy", active: true, work_area_id: 2, is_superadmin: false },
      { id: 31, name: "Astrid", active: true, work_area_id: 2, is_superadmin: false },
      { id: 40, name: "Bastián", active: true, work_area_id: 2, is_superadmin: true },
    ];
    const refs = {
      areas,
      areaById: new Map(areas.map((a) => [a.id, a])),
      users,
      userById: new Map(users.map((u) => [u.id, u])),
      groups: [{ id: 1, name: "LinkedIn" }],
      groupById: new Map([[1, { id: 1, name: "LinkedIn" }]]),
    };
    const snap = {
      users: new Map(users.map((u) => [u.id, u])),
      areas,
      groupMembers: new Map([[31, new Set([1])]]),
      assignments: [
        { id: 5, principal_type: "user", user_id: 20, permission_key: KEY, effect: "concede", scope_area_ids: [] },
        { id: 6, principal_type: "grupo", group_id: 1, permission_key: KEY, effect: "concede", scope_area_ids: [] },
        { id: 7, principal_type: "user", user_id: 31, permission_key: KEY, effect: "deniega", scope_area_ids: [] },
      ],
    };
    const holders = (await holdersByKey([KEY], refs, catalog, snap)).get(KEY);
    assert.deepEqual(holders.granted.map((h) => h.user.name), ["Freddy"], "el superadmin no se lista");
    assert.deepEqual(holders.granted[0].removal, { mode: "quitar", deleteIds: [5] });
    assert.deepEqual(holders.denied.map((h) => [h.user.name, h.assignmentId]), [["Astrid", 7]]);
  });
});
