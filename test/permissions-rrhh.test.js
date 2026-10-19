const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { computePermissions } = require("../src/services/permissions/resolver");
const { getCatalog } = require("../src/services/permissions/catalog");
const { decide } = require("../src/services/permissions/decide");
const { legacyContext, hasLegacyRule } = require("../src/services/permissions/legacyRules");
const { buildViewCan } = require("../src/services/permissions/viewCan");
const { SYSTEM_SETS, CAMBIOS } = require("../src/services/permissions/bootstrap");
const { getCountryConfig } = require("../src/config/country");
const { getFeatures } = require("../src/config/features");
const {
  rechazoEscalada,
  clavesDeEdicion,
  cambiosDeFicha,
} = require("../src/services/permissions/rrhhEscalada");

const CL = getCatalog("CL");

const AREAS = [
  { id: 2, parent_area_id: null, manager_user_id: null },
  { id: 4, parent_area_id: null, manager_user_id: null },
];
const USERS = [
  { id: 20, role: "Administrador", work_area_id: 2 },
  { id: 31, role: "Usuario", work_area_id: 4 },
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

function aplicando(userId, items) {
  const p = computePermissions({
    users: new Map(USERS.map((u) => [u.id, u])),
    areas: AREAS,
    sets: new Map(),
    assignments: items.map((item) => asignacion({
      principal_type: "user",
      user_id: userId,
      permission_key: item.permission_key,
      scope: item.scope,
      scope_area_ids: item.scope_area_ids || [],
    })),
  }, { id: userId }, { catalog: CL });
  p.mode = "aplicar";
  return p;
}

const RRHH = legacyContext({ role: "Administrador" }, { rrhhManager: true, workAreaId: 2 });
const ADMIN = legacyContext({ role: "Administrador" }, { rrhhManager: false, workAreaId: 4 });
const USUARIO = legacyContext({ role: "Usuario" }, { workAreaId: 4 });
const vacio = () => computePermissions({
  users: new Map(USERS.map((u) => [u.id, u])),
  areas: AREAS,
  sets: new Map(),
  assignments: [],
}, { id: 31 }, { catalog: CL });

describe("reglas antiguas de RRHH", () => {
  const claves = [
    "rrhh.colaborador.editar",
    "rrhh.colaborador.activar",
    "organigrama.area.designar_jefe",
    "feriados.feriado.administrar",
    "centros_costo.centro.ver",
  ];

  it("rrhhManager sí; un admin de otra área no; un usuario no", () => {
    const p = vacio();
    for (const clave of claves) {
      assert.equal(decide(p, clave, RRHH, { record: { ownerId: 99, areaId: 9 } }), true, clave);
      assert.equal(decide(p, clave, ADMIN), false, clave);
      assert.equal(decide(p, clave, USUARIO), false, clave);
    }
    assert.equal(decide(p, "rrhh.directorio.ver", USUARIO), true);
    assert.equal(decide(p, "rrhh.portales.ver", USUARIO), true);
    assert.equal(decide(p, "organigrama.acceso", USUARIO), true);
  });

  it("centros de costo conserva la doble guardia", () => {
    const p = vacio();
    const soloRrhh = legacyContext({ role: "Usuario" }, { rrhhManager: true });
    assert.equal(decide(p, "centros_costo.centro.ver", soloRrhh), true);
    assert.equal(decide(p, "centros_costo.centro.administrar", soloRrhh), false);
    assert.equal(decide(p, "centros_costo.miembros.asignar", RRHH), true);
    assert.equal(decide(p, "centros_costo.centro.administrar", ADMIN), false);
  });
});

describe("RRHH al aplicar", () => {
  it("Gestión de personal da colaboradores, organigrama, feriados y centros", () => {
    const items = SYSTEM_SETS.find((s) => s.code === "gestion_personal").items;
    const p = aplicando(20, items);
    assert.equal(p.can("rrhh.colaborador.crear"), true);
    assert.equal(p.can("feriados.feriado.administrar"), true);
    assert.equal(p.can("centros_costo.centro.administrar"), true);
    assert.equal(p.canOnRecord("rrhh.colaborador.editar", { areaId: 4 }), true);
  });

  it("un alcance de áreas deja editar X y no Y", () => {
    const p = aplicando(31, [{
      permission_key: "rrhh.colaborador.editar",
      scope: "areas",
      scope_area_ids: [4],
    }]);
    assert.equal(decide(p, "rrhh.colaborador.editar", USUARIO, { record: { areaId: 4, ownerId: 8 } }), true);
    assert.equal(decide(p, "rrhh.colaborador.editar", USUARIO, { record: { areaId: 2, ownerId: 8 } }), false);
  });
});

describe("POST /editar separa las claves", () => {
  const base = {
    first_name: "Ana",
    last_name: "Pérez",
    email: "ana@transworld.cl",
    role: "Usuario",
    work_area_id: 4,
    birth_date: "1990-01-01",
    phone: "",
    personal_email: "",
    work_phone: "",
    national_id: "",
    hire_date: "",
  };

  it("un cambio solo de datos no exige activar", () => {
    const cambios = cambiosDeFicha(base, { ...base, first_name: "Anita" });
    assert.deepEqual(clavesDeEdicion(cambios), ["rrhh.colaborador.editar"]);
  });

  it("el rol exige activar y el área exige mover miembros", () => {
    assert.deepEqual(clavesDeEdicion(cambiosDeFicha(base, { ...base, role: "Deshabilitado" })), [
      "rrhh.colaborador.activar",
    ]);
    assert.deepEqual(clavesDeEdicion(cambiosDeFicha(base, { ...base, work_area_id: 2 })), [
      "organigrama.area.editar_miembros",
    ]);
  });
});

describe("escalada de RRHH", () => {
  const actor = 20;

  it("un no-superadmin no se cambia rol, estado, área ni se designa jefe", () => {
    assert.equal(rechazoEscalada({
      actorId: actor, targetId: actor,
      antes: { role: "Usuario" }, despues: { role: "Administrador" },
    }), "propio-rol");
    assert.equal(rechazoEscalada({
      actorId: actor, targetId: actor,
      antes: { role: "Usuario" }, despues: { role: "Deshabilitado" },
    }), "propio-rol");
    assert.equal(rechazoEscalada({
      actorId: actor, targetId: actor,
      antes: { areaId: 2 }, despues: { areaId: 4 },
    }), "propio-area");
    assert.equal(rechazoEscalada({
      actorId: actor, targetId: actor,
      despues: { seDesignaJefe: true },
    }), "propio-jefe");
  });

  it("sólo el superadmin asigna Administrador y designa jefe de Informática", () => {
    assert.equal(rechazoEscalada({
      actorId: actor, targetId: 31,
      antes: { role: "Usuario" }, despues: { role: "Administrador" },
    }), "rol-administrador");
    assert.equal(rechazoEscalada({
      actorId: actor, targetId: 31,
      antes: { role: "Administrador" }, despues: { role: "Usuario" },
    }), "rol-administrador");
    assert.equal(rechazoEscalada({
      actorId: actor, targetId: 31,
      despues: { designaJefe: true },
      areaNombre: "Informática",
    }), "jefe-informatica");
    assert.equal(rechazoEscalada({
      actorId: actor, targetId: 31,
      antes: { role: "Usuario" }, despues: { role: "Deshabilitado" },
    }), null, "habilitar sigue en RRHH");
  });

  it("el superadmin puede los tres", () => {
    const base = { superadmin: true, actorId: actor, targetId: actor };
    assert.equal(rechazoEscalada({ ...base, antes: { role: "Usuario" }, despues: { role: "Administrador" } }), null);
    assert.equal(rechazoEscalada({ ...base, antes: { areaId: 2 }, despues: { areaId: 4 } }), null);
    assert.equal(rechazoEscalada({
      superadmin: true, actorId: actor, targetId: 31,
      despues: { designaJefe: true }, areaNombre: "TI",
    }), null);
  });

  it("queda anotado en el arranque", () => {
    assert.ok(CAMBIOS.some((linea) => /superadmin asigna o quita el rol Administrador/.test(linea)));
    assert.ok(CAMBIOS.some((linea) => /jefe de Informática/.test(linea)));
  });
});

describe("vistas de la ficha", () => {
  const persona = {
    id: 8,
    first_name: "Ana",
    last_name: "Pérez",
    email: "ana@transworld.cl",
    correo_empresa: "ana@transworld.cl",
    email_confirmed: true,
    role: "Usuario",
    work_area_id: 4,
    documento: "12.345.678-5",
    national_id: "12345678-5",
    birth_date: "1990-01-02",
    personal_email: "ana.perez@gmail.com",
    phone: "56912345678",
    work_phone: "",
  };

  async function render(can) {
    return ejs.renderFile(
      path.join(__dirname, "..", "src", "views", "RRHH", "partials", "persona_campos.ejs"),
      {
        modo: "editar",
        persona,
        areas: [{ id: 4, area_name: "Comercial" }],
        documentoConfig: { label: "RUT", example: "12.345.678-5" },
        countryConfig: getCountryConfig(),
        country: "CL",
        features: getFeatures(),
        can,
        perms: { superadmin: false },
        usuario: { id: 20 },
      },
      { async: false },
    );
  }

  it("sin can.field el documento y el correo personal no salen", async () => {
    const html = await render(buildViewCan(aplicando(31, []), {}, { legacyCtx: USUARIO }));
    assert.equal(html.includes("12.345.678-5"), false);
    assert.equal(html.includes("12345678-5"), false);
    assert.equal(html.includes("ana.perez@gmail.com"), false);
    assert.equal(html.includes("56912345678"), false);
  });

  it("con el permiso el documento se muestra y el rol Administrador queda deshabilitado", async () => {
    const items = ["rrhh.colaborador.campo.documento_identidad", "rrhh.colaborador.campo.datos_personales"]
      .map((permission_key) => ({ permission_key }));
    const html = await render(buildViewCan(aplicando(31, items), {}, { legacyCtx: USUARIO }));
    assert.match(html, /12\.345\.678-5/);
    assert.match(html, /value="Administrador"[^>]*disabled/);
  });
});

describe("cobertura y caché", () => {
  it("las claves de esta fase tienen regla antigua", () => {
    const usadas = [...CL.byKey.keys()].filter((key) => /^(rrhh|organigrama|feriados|centros_costo)\./.test(key));
    assert.deepEqual(usadas.filter((key) => !hasLegacyRule(key)), []);
  });

  it("el alta y las rutas de áreas invalidan los permisos", () => {
    const src = fs.readFileSync(path.join(__dirname, "..", "src", "routes", "RRHH.js"), "utf8");
    const alta = src.slice(src.indexOf('router.post("/crear"'), src.indexOf('router.get("/editar'));
    assert.match(alta, /invalidarCachesDeArea\(\)/);
    for (const marca of ['"/areas"', '"/areas/:id"', '"/areas/:id/eliminar"', '"/areas/:id/miembros"']) {
      const i = src.indexOf(marca);
      assert.ok(i > 0, marca);
      assert.match(src.slice(i, i + 3500), /invalidarCachesDeArea\(\)/, marca);
    }
    assert.match(src, /invalidatePermissions\(\)/);
  });
});
