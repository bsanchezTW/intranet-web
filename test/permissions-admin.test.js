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
  validateSetItems,
  slugify,
} = require("../src/services/permissions/store");
const { describeAssignment } = require("../src/services/permissions/adminQueries");
const { buildTree } = require("../src/services/workAreaTree");
const { getCountryConfig, getCurrentCountry } = require("../src/config/country");
const { getFeatures } = require("../src/config/features");

const CL = getCatalog("CL");
const AREAS = new Set([1, 2, 3]);
const USERS = new Set([7, 8, 9]);
const SETS = new Set([20]);
const ctx = { catalog: CL, areaIds: AREAS, userIds: USERS, setIds: SETS, actorId: 7 };

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

  it("los ítems de un conjunto no se repiten", () => {
    const items = validateSetItems(
      [
        { permission_key: "noticias.noticia.ver" },
        { permission_key: "noticias.noticia.ver" },
        { permission_key: "gastos.solicitud.ver", scope: "propio" },
        { permission_key: "gastos.solicitud.ver", scope: "todo" },
      ],
      ctx,
    );
    assert.equal(items.length, 3);
  });

  it("código de conjunto legible", () => {
    assert.equal(slugify("Aprobador de Rendiciones (Finanzas)"), "aprobador_de_rendiciones_finanzas");
  });
});

describe("validación de asignaciones", () => {
  const ahora = new Date("2026-10-19T15:00:00Z");
  const valida = (input) => validateAssignment(input, { ...ctx, now: ahora, timeZone: "America/Santiago" });

  it("a una persona, un conjunto", () => {
    const v = valida({ principal_type: "user", user_id: "8", set_id: "20" });
    assert.equal(v.user_id, 8);
    assert.equal(v.set_id, 20);
    assert.equal(v.permission_key, null);
    assert.equal(v.effect, "concede");
  });

  it("nadie cambia sus propias asignaciones", () => {
    assert.throws(() => valida({ principal_type: "user", user_id: "7", set_id: "20" }), /propias/);
  });

  it("un área necesita área; los jefes pueden ser de cualquiera", () => {
    assert.throws(() => valida({ principal_type: "area", set_id: "20" }), /Elige el área/);
    const jefes = valida({ principal_type: "jefes", set_id: "20", include_subareas: "1" });
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
      set_id: "20",
      valid_from: "2026-10-20",
      valid_until: "2026-10-31",
    });
    // Chile en octubre: UTC-3.
    assert.equal(v.valid_from.toISOString(), "2026-10-20T03:00:00.000Z");
    assert.equal(v.valid_until.toISOString(), "2026-11-01T03:00:00.000Z");
  });

  it("una vigencia al revés o ya terminada se rechaza", () => {
    assert.throws(
      () => valida({ principal_type: "global", set_id: "20", valid_from: "2026-10-30", valid_until: "2026-10-20" }),
      /terminar después/,
    );
    assert.throws(() => valida({ principal_type: "global", set_id: "20", valid_until: "2026-10-10" }), /ya terminó/);
  });

  it("destinatario y conjunto tienen que existir", () => {
    assert.throws(() => valida({ principal_type: "nadie", set_id: "20" }), /a quién/);
    assert.throws(() => valida({ principal_type: "user", user_id: "55", set_id: "20" }), /persona/);
    assert.throws(() => valida({ principal_type: "global", set_id: "21" }), /conjunto/);
  });
});

describe("formulario del editor de conjuntos", () => {
  const { itemsFromBody } = require("../src/routes/permisos");

  it("arma los ítems desde los campos sueltos por clave", () => {
    const items = itemsFromBody({
      perm: ["noticias.noticia.ver", "noticias.noticia.crear"],
      "scope:gastos.solicitud.ver": ["propio", "areas"],
      "areas:gastos.solicitud.ver": ["2", "3"],
      "subareas:gastos.solicitud.ver": "1",
      "scope:gastos.solicitud.aprobar_jefatura": "a_cargo",
    });
    assert.deepEqual(items, [
      { permission_key: "noticias.noticia.ver", scope: null },
      { permission_key: "noticias.noticia.crear", scope: null },
      { permission_key: "gastos.solicitud.ver", scope: "propio", scope_area_ids: [], scope_include_subareas: false },
      { permission_key: "gastos.solicitud.ver", scope: "areas", scope_area_ids: ["2", "3"], scope_include_subareas: true },
      { permission_key: "gastos.solicitud.aprobar_jefatura", scope: "a_cargo", scope_area_ids: [], scope_include_subareas: false },
    ]);
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
    { id: 10, name: "Gustavo Valenzuela", first_name: "Gustavo", email: "g@x.cl", role: "Usuario", work_area_id: 1, is_superadmin: false },
    { id: 20, name: "Freddy Payano", first_name: "Freddy", email: "f@x.cl", role: "Administrador", work_area_id: 2, is_superadmin: false },
    { id: 31, name: "Astrid Ortiz", first_name: "Astrid", email: "a@x.cl", role: "Usuario", work_area_id: 2, is_superadmin: false },
    { id: 40, name: "Bastián Sánchez", first_name: "Bastián", email: "b@x.cl", role: "Administrador", work_area_id: 3, is_superadmin: true },
  ];
  const sets = [
    { id: 1, code: "basico", name: "Básico", description: "Todos", active: true, item_count: 3, assignment_count: 1 },
    { id: 2, code: "aprobador", name: "Aprobador", description: null, active: false, item_count: 1, assignment_count: 0 },
  ];
  const refs = {
    areas,
    areaById: new Map(areas.map((a) => [a.id, a])),
    users,
    userById: new Map(users.map((u) => [u.id, u])),
    sets,
    setById: new Map(sets.map((s) => [s.id, s])),
  };
  const anyKey = catalog.modules[0].permissions[1].key;
  const scopedKey = [...catalog.byKey.values()].find((p) => p.scopes && p.scopes.includes("areas")).key;
  const assignments = [
    { id: 1, principal_type: "global", set_id: 1, effect: "concede", scope_area_ids: [] },
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
      meta: { version: 3, mode: "sombra", bootstrapped_at: null },
      totals: { concede: 5, deniega: 1 },
      superadmins: [users[3]],
      permissionCount: catalog.byKey.size,
    });
    assert.match(html, /Modo sombra/);
    assert.match(html, /permisos-arranque\.js --pais/);
    assert.match(html, /Bastián Sánchez/);
  });

  it("por módulo, con quién tiene cada permiso", async () => {
    const whoHas = new Map([[anyKey, [{ assignment: assignments[0], viaSet: "Básico", scopeLabel: null }]]]);
    const html = await render("modulos", { seccion: "modulos", modules: catalog.modules, current: catalog.modules[0], whoHas });
    assert.match(html, /Todos · Básico/);
    assert.match(html, /Sólo el superadmin/);
    assert.match(html, /data-perm-form/);
  });

  it("conjuntos y editor de conjunto", async () => {
    assert.match(await render("conjuntos", { seccion: "conjuntos" }), /Desactivado/);
    const html = await render("conjunto", {
      seccion: "conjuntos",
      set: { ...sets[0], items: [{ permission_key: scopedKey, scope: "areas", scope_area_ids: [2], scope_include_subareas: false }, { permission_key: "clave.vieja", scope: null, scope_area_ids: [] }] },
      assignments: [assignments[0]],
    });
    assert.match(html, new RegExp(`name="scope:${scopedKey.replace(/\./g, "\\.")}" value="areas" checked`));
    assert.match(html, /no existen en la intranet de este país/);
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
    }
    assert.match(await render("areas", { seccion: "areas", counts: new Map([[2, 1]]), members: new Map([[2, 2]]) }), /Finanzas/);
  });

  it("personas y ficha con origen y denegaciones", async () => {
    assert.match(await render("usuarios", { seccion: "usuarios", q: "", list: users }), /Superadmin/);
    const html = await render("usuario", {
      seccion: "usuarios",
      detail: {
        user: users[2],
        area: areas[1],
        managed: [],
        superadmin: false,
        direct: [assignments[1]],
        grantedCount: 1,
        modules: [
          {
            module: "x",
            label: "Módulo",
            permissions: [
              { key: anyKey, label: "Ver", granted: true, alcance: null, origins: ["conjunto «Básico» · Todos"], deniedBy: null },
              { key: scopedKey, label: "Otro", granted: false, alcance: null, origins: [], deniedBy: "permiso suelto · Finanzas" },
            ],
          },
        ],
      },
    });
    assert.match(html, /conjunto «Básico» · Todos/);
    assert.match(html, /Denegado: permiso suelto · Finanzas/);
    assert.match(html, /Hacer superadmin/);
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
