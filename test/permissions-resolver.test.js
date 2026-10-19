const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { computePermissions } = require("../src/services/permissions/resolver");
const { getCatalog } = require("../src/services/permissions/catalog");
const { getCurrentCountry } = require("../src/config/country");
const { buildViewCan } = require("../src/services/permissions/viewCan");
const requirePermission = require("../src/middlewares/requirePermission");
const { requireAnyPermission } = require("../src/middlewares/requirePermission");

const CL = getCatalog("CL");
const PE = getCatalog("PE");

/*
 * Organigrama de prueba:
 *
 *   Gerencia (1, jefe 100)
 *   ├── Finanzas (2, jefe 200)
 *   │   └── Contabilidad (3, sin jefe)
 *   └── Comercial (4, jefe 400)
 */
const AREAS = [
  { id: 1, parent_area_id: null, manager_user_id: 100 },
  { id: 2, parent_area_id: 1, manager_user_id: 200 },
  { id: 3, parent_area_id: 2, manager_user_id: null },
  { id: 4, parent_area_id: 1, manager_user_id: 400 },
];

const USERS = [
  { id: 100, role: "Administrador", work_area_id: 1 },
  { id: 200, role: "Usuario", work_area_id: 2 },
  { id: 201, role: "Usuario", work_area_id: 2 }, // Astrid, Finanzas, no es jefa
  { id: 301, role: "Usuario", work_area_id: 3 },
  { id: 400, role: "Usuario", work_area_id: 4 },
  { id: 401, role: "Usuario", work_area_id: 4 }, // Juan, Comercial
  { id: 402, role: "Usuario", work_area_id: 4 },
  { id: 500, role: "Usuario", work_area_id: null },
  { id: 900, role: "Usuario", work_area_id: 2, is_superadmin: true },
  { id: 999, role: "Deshabilitado", work_area_id: 4 },
];

let nextId = 1;
function asignacion(fields) {
  return {
    id: nextId++,
    area_id: null,
    user_id: null,
    include_subareas: false,
    set_id: null,
    permission_key: null,
    scope: null,
    scope_area_ids: [],
    scope_include_subareas: false,
    effect: "concede",
    valid_from: null,
    valid_until: null,
    ...fields,
  };
}

function foto(assignments, sets = []) {
  return {
    users: new Map(USERS.map((u) => [u.id, u])),
    areas: AREAS,
    sets: new Map(sets.map((s) => [s.id, s])),
    assignments,
  };
}

function permisos(snapshot, userId, opts = {}) {
  return computePermissions(snapshot, { id: userId }, { catalog: CL, ...opts });
}

/** Con el modo 'aplicar': decide Gestión de Permisos, no la regla antigua. */
function aplicando(perms) {
  perms.mode = "aplicar";
  return perms;
}

const LEER = "noticias.noticia.ver";
const APROBAR_JEFATURA = "gastos.solicitud.aprobar_jefatura";
const APROBAR_FINANZAS = "gastos.solicitud.aprobar_finanzas";
const VER_GASTOS = "gastos.solicitud.ver";

describe("precedencia: Usuario → Área / Jefes → Global", () => {
  it("un permiso global lo tiene toda cuenta activa", () => {
    const s = foto([asignacion({ principal_type: "global", permission_key: LEER })]);
    for (const id of [100, 201, 401, 500]) assert.equal(permisos(s, id).can(LEER), true, String(id));
    assert.equal(permisos(s, 999).can(LEER), false, "deshabilitado");
    assert.equal(permisos(s, 12345).can(LEER), false, "inexistente");
  });

  it("Comercial lo tiene y a Juan se le deniega", () => {
    const s = foto([
      asignacion({ principal_type: "area", area_id: 4, permission_key: LEER }),
      asignacion({ principal_type: "user", user_id: 401, permission_key: LEER, effect: "deniega" }),
    ]);
    assert.equal(permisos(s, 401).can(LEER), false);
    assert.equal(permisos(s, 402).can(LEER), true);
  });

  it("Global concede, Comercial deniega y a Juan se le concede", () => {
    const s = foto([
      asignacion({ principal_type: "global", permission_key: LEER }),
      asignacion({ principal_type: "area", area_id: 4, permission_key: LEER, effect: "deniega" }),
      asignacion({ principal_type: "user", user_id: 401, permission_key: LEER }),
    ]);
    assert.equal(permisos(s, 401).can(LEER), true, "Juan");
    assert.equal(permisos(s, 402).can(LEER), false, "resto de Comercial");
    assert.equal(permisos(s, 201).can(LEER), true, "otras áreas");
  });

  it("en el mismo nivel la denegación gana", () => {
    const s = foto([
      asignacion({ principal_type: "user", user_id: 201, permission_key: LEER }),
      asignacion({ principal_type: "user", user_id: 201, permission_key: LEER, effect: "deniega" }),
    ]);
    assert.equal(permisos(s, 201).can(LEER), false);
  });

  it("lo concedido por encima de una denegación no se pierde, lo de abajo sí", () => {
    const s = foto([
      asignacion({ principal_type: "user", user_id: 401, permission_key: VER_GASTOS, scope: "propio" }),
      asignacion({ principal_type: "area", area_id: 4, permission_key: VER_GASTOS, effect: "deniega" }),
      asignacion({ principal_type: "global", permission_key: VER_GASTOS, scope: "todo" }),
    ]);
    const p = permisos(s, 401);
    assert.equal(p.canOnRecord(VER_GASTOS, { ownerId: 401, areaId: 4 }), true);
    assert.equal(p.canOnRecord(VER_GASTOS, { ownerId: 402, areaId: 4 }), false);
    assert.equal(p.explain(VER_GASTOS).deniedBy.principal, "area");
  });

  it("un área con subáreas alcanza a quien trabaja más abajo", () => {
    const sin = foto([asignacion({ principal_type: "area", area_id: 1, permission_key: LEER })]);
    const con = foto([
      asignacion({ principal_type: "area", area_id: 1, permission_key: LEER, include_subareas: true }),
    ]);
    assert.equal(permisos(sin, 301).can(LEER), false);
    assert.equal(permisos(sin, 100).can(LEER), true);
    assert.equal(permisos(con, 301).can(LEER), true);
  });
});

describe("conjuntos", () => {
  const aprobadorFinanzas = {
    id: 10,
    code: "aprobador_finanzas",
    name: "Aprobador de finanzas",
    active: true,
    items: [{ permission_key: APROBAR_FINANZAS, scope: "todo", scope_area_ids: [], scope_include_subareas: false }],
  };

  it("un conjunto asignado a una persona que no es jefa", () => {
    const s = foto([asignacion({ principal_type: "user", user_id: 201, set_id: 10 })], [aprobadorFinanzas]);
    assert.equal(permisos(s, 201).canOnRecord(APROBAR_FINANZAS, { ownerId: 401, areaId: 4 }), true);
    assert.equal(permisos(s, 200).can(APROBAR_FINANZAS), false, "su jefe no lo hereda");
    assert.equal(permisos(s, 201).explain(APROBAR_FINANZAS).sources[0].setCode, "aprobador_finanzas");
  });

  it("un conjunto desactivado no concede nada", () => {
    const s = foto(
      [asignacion({ principal_type: "user", user_id: 201, set_id: 10 })],
      [{ ...aprobadorFinanzas, active: false }],
    );
    assert.equal(permisos(s, 201).can(APROBAR_FINANZAS), false);
  });

  it("denegar un conjunto quita todos sus permisos", () => {
    const s = foto(
      [
        asignacion({ principal_type: "area", area_id: 2, set_id: 10 }),
        asignacion({ principal_type: "user", user_id: 201, set_id: 10, effect: "deniega" }),
      ],
      [aprobadorFinanzas],
    );
    assert.equal(permisos(s, 201).can(APROBAR_FINANZAS), false);
    assert.equal(permisos(s, 200).can(APROBAR_FINANZAS), true);
  });
});

describe("jefes de área y alcances", () => {
  const jefatura = foto([
    asignacion({ principal_type: "jefes", permission_key: APROBAR_JEFATURA, scope: "a_cargo" }),
  ]);

  it("el jefe alcanza sus áreas y todo lo que cuelga de ellas", () => {
    assert.deepEqual(permisos(jefatura, 100).coverage(APROBAR_JEFATURA).areaIds.sort(), [1, 2, 3, 4]);
    assert.deepEqual(permisos(jefatura, 200).coverage(APROBAR_JEFATURA).areaIds.sort(), [2, 3]);
    assert.equal(permisos(jefatura, 200).canOnRecord(APROBAR_JEFATURA, { areaId: 3 }), true);
    assert.equal(permisos(jefatura, 200).canOnRecord(APROBAR_JEFATURA, { areaId: 4 }), false);
  });

  it("quien no es jefe no está en el grupo", () => {
    assert.equal(permisos(jefatura, 401).can(APROBAR_JEFATURA), false);
  });

  it("jefes de un área concreta, con o sin las de abajo", () => {
    const soloFinanzas = foto([
      asignacion({ principal_type: "jefes", area_id: 2, permission_key: LEER }),
    ]);
    assert.equal(permisos(soloFinanzas, 200).can(LEER), true);
    assert.equal(permisos(soloFinanzas, 100).can(LEER), false);

    const bajoGerencia = foto([
      asignacion({ principal_type: "jefes", area_id: 1, include_subareas: true, permission_key: LEER }),
    ]);
    for (const id of [100, 200, 400]) assert.equal(permisos(bajoGerencia, id).can(LEER), true, String(id));
  });

  it("áreas elegidas, con o sin subáreas", () => {
    const s = foto([
      asignacion({
        principal_type: "user",
        user_id: 402,
        permission_key: VER_GASTOS,
        scope: "areas",
        scope_area_ids: [2],
        scope_include_subareas: true,
      }),
    ]);
    assert.deepEqual(permisos(s, 402).coverage(VER_GASTOS).areaIds.sort(), [2, 3]);
  });

  it("propio y mi área", () => {
    const s = foto([
      asignacion({ principal_type: "global", permission_key: VER_GASTOS, scope: "propio" }),
      asignacion({ principal_type: "global", permission_key: VER_GASTOS, scope: "mi_area" }),
    ]);
    const juan = permisos(s, 401);
    assert.equal(juan.canOnRecord(VER_GASTOS, { ownerId: 401, areaId: 2 }), true, "lo suyo");
    assert.equal(juan.canOnRecord(VER_GASTOS, { ownerId: 402, areaId: 4 }), true, "su área");
    assert.equal(juan.canOnRecord(VER_GASTOS, { ownerId: 201, areaId: 2 }), false);
  });

  it("mi área sin área asignada no da nada", () => {
    const s = foto([asignacion({ principal_type: "global", permission_key: VER_GASTOS, scope: "mi_area" })]);
    assert.equal(permisos(s, 500).can(VER_GASTOS), false);
  });

  it("un alcance que el permiso no admite no cuenta", () => {
    const s = foto([asignacion({ principal_type: "global", permission_key: APROBAR_JEFATURA, scope: "propio" })]);
    assert.equal(permisos(s, 401).can(APROBAR_JEFATURA), false);
  });

  it("filtro SQL para listados", () => {
    const s = foto([
      asignacion({ principal_type: "user", user_id: 401, permission_key: VER_GASTOS, scope: "propio" }),
      asignacion({ principal_type: "user", user_id: 401, permission_key: VER_GASTOS, scope: "areas", scope_area_ids: [2] }),
    ]);
    const f = permisos(s, 401).sqlFilter(VER_GASTOS, { ownerColumn: "r.user_id", areaColumn: "r.work_area_id", firstParam: 3 });
    assert.equal(f.clause, "(r.user_id = $3 OR r.work_area_id = ANY($4::int[]))");
    assert.deepEqual(f.params, [401, [2]]);
    assert.deepEqual(permisos(s, 402).sqlFilter(VER_GASTOS, { ownerColumn: "x", areaColumn: "y" }), {
      clause: "FALSE",
      params: [],
    });
  });
});

describe("vigencia", () => {
  const ahora = Date.parse("2026-10-19T12:00:00Z");

  it("una asignación vencida o futura no vale; el caché sabe cuándo cambia", () => {
    const s = foto([
      asignacion({ principal_type: "user", user_id: 201, permission_key: LEER, valid_until: "2026-10-18T00:00:00Z" }),
      asignacion({ principal_type: "user", user_id: 201, permission_key: APROBAR_FINANZAS, scope: "todo", valid_from: "2026-10-20T00:00:00Z" }),
    ]);
    const p = permisos(s, 201, { now: ahora });
    assert.equal(p.can(LEER), false);
    assert.equal(p.can(APROBAR_FINANZAS), false);
    assert.equal(p.expiresAt, Date.parse("2026-10-20T00:00:00Z"));
    assert.equal(permisos(s, 201, { now: Date.parse("2026-10-21T00:00:00Z") }).can(APROBAR_FINANZAS), true);
  });

  it("dentro de la vigencia vale", () => {
    const s = foto([
      asignacion({
        principal_type: "user",
        user_id: 201,
        permission_key: LEER,
        valid_from: "2026-10-01T00:00:00Z",
        valid_until: "2026-11-01T00:00:00Z",
      }),
    ]);
    const p = permisos(s, 201, { now: ahora });
    assert.equal(p.can(LEER), true);
    assert.equal(p.expiresAt, Date.parse("2026-11-01T00:00:00Z"));
  });
});

describe("superadmin, emergencia y país", () => {
  it("el superadmin tiene todo el catálogo del país y no se le puede denegar", () => {
    const s = foto([asignacion({ principal_type: "user", user_id: 900, permission_key: LEER, effect: "deniega" })]);
    const p = permisos(s, 900);
    assert.equal(p.can(LEER), true);
    assert.equal(p.canOnRecord(APROBAR_FINANZAS, { ownerId: 1, areaId: 4 }), true);
    assert.equal(p.can("vacaciones.solicitud.aprobar"), false, "no existe en Chile");
    assert.equal(p.can("clave.inventada"), false);
  });

  it("el login de emergencia (id 0) es superadmin", () => {
    assert.equal(computePermissions({}, { id: 0 }, { catalog: CL }).can(APROBAR_FINANZAS), true);
  });

  it("una asignación de un módulo que el país no tiene no cuenta", () => {
    const s = foto([asignacion({ principal_type: "global", permission_key: "vacaciones.solicitud.crear" })]);
    assert.equal(permisos(s, 401).can("vacaciones.solicitud.crear"), false);
    assert.equal(
      computePermissions(s, { id: 401 }, { catalog: PE }).can("vacaciones.solicitud.crear"),
      true,
    );
  });
});

describe("can() de las vistas", () => {
  it("responde por clave, por registro y por campo, y conserva las propiedades viejas", () => {
    const s = foto([
      asignacion({ principal_type: "global", permission_key: LEER }),
      asignacion({ principal_type: "user", user_id: 201, permission_key: VER_GASTOS, scope: "propio" }),
    ]);
    const can = buildViewCan(aplicando(permisos(s, 201)), { noticias_write: true });
    assert.equal(can(LEER), true);
    assert.equal(can(VER_GASTOS, { ownerId: 201 }), true);
    assert.equal(can(VER_GASTOS, { ownerId: 401 }), false);
    assert.equal(can.field("gastos.solicitud.campo.cuenta_bancaria"), false);
    assert.equal(can.noticias_write, true);
  });
});

describe("requirePermission", () => {
  function correr(middleware, req) {
    return new Promise((resolve) => {
      const res = {
        statusCode: 200,
        status(code) {
          this.statusCode = code;
          return this;
        },
        json(body) {
          resolve({ status: this.statusCode, json: body });
        },
        render(view) {
          resolve({ status: this.statusCode, view });
        },
        redirect(to) {
          resolve({ status: 302, redirect: to });
        },
      };
      middleware({ headers: {}, originalUrl: "/x", session: {}, ...req }, res, () => resolve({ next: true }));
    });
  }

  const s = foto([asignacion({ principal_type: "user", user_id: 201, permission_key: LEER })]);

  it("deja pasar a quien tiene el permiso y frena al resto", async () => {
    const mw = requirePermission(LEER);
    assert.deepEqual(await correr(mw, { session: { user: { id: 201 } }, perms: aplicando(permisos(s, 201)) }), { next: true });
    const negado = await correr(mw, { session: { user: { id: 401 } }, perms: aplicando(permisos(s, 401)) });
    assert.equal(negado.status, 403);
  });

  it("sin sesión manda al login", async () => {
    const r = await correr(requirePermission(LEER), {});
    assert.equal(r.redirect, "/login");
  });

  it("basta con uno de varios permisos", async () => {
    const mw = requireAnyPermission(APROBAR_FINANZAS, LEER);
    assert.deepEqual(await correr(mw, { session: { user: { id: 201 } }, perms: aplicando(permisos(s, 201)) }), { next: true });
  });

  it("en modo sombra decide la regla antigua aunque el permiso nuevo diga otra cosa", async () => {
    const mw = requirePermission("noticias.noticia.crear");
    // Administrador sin el permiso nuevo: pasa, como siempre.
    const admin = await correr(mw, { session: { user: { id: 401, role: "Administrador" } }, perms: permisos(s, 401) });
    assert.deepEqual(admin, { next: true });
    // Usuario: no pasa, como siempre.
    const usuario = await correr(mw, { session: { user: { id: 402, role: "Usuario" } }, perms: permisos(s, 402) });
    assert.equal(usuario.status, 403);
  });

  it("un permiso de un módulo que el país no tiene responde 404", async () => {
    // Vacaciones no existe en Chile y Rendiciones no existe en Perú.
    const ajena = getCurrentCountry() === "PE" ? VER_GASTOS : "vacaciones.solicitud.aprobar";
    const r = await correr(requirePermission(ajena), { session: { user: { id: 201 } } });
    assert.equal(r.status, 404);
  });

  it("una clave inventada falla al declarar la ruta", () => {
    assert.throws(() => requirePermission("noticias.noticia.volar"), /no existe en el catálogo/);
  });
});
