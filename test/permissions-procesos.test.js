const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ejs = require("ejs");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { computePermissions } = require("../src/services/permissions/resolver");
const { getCatalog } = require("../src/services/permissions/catalog");
const { decide } = require("../src/services/permissions/decide");
const { legacyContext, hasLegacyRule } = require("../src/services/permissions/legacyRules");
const { buildViewCan } = require("../src/services/permissions/viewCan");
const { SYSTEM_SETS, CAMBIOS } = require("../src/services/permissions/bootstrap");
const { getFeatures } = require("../src/config/features");
const { getCountryConfig } = require("../src/config/country");
const { phoneClientConfig } = require("../src/utils/phone");
const { contactoPersonalDirectorio } = require("../src/utils/contactEmails");
const {
  puedeVerCarpeta,
  puedeSubir,
  claveAdministrarDocumento,
  puedeAdministrarDocumento,
  veListadoDeCarpetas,
  puedeVerDocumento,
  puedeVerDocumentoBusqueda,
} = require("../src/services/documents/processAccess");

const CL = getCatalog("CL");
const VIEWS = path.join(__dirname, "..", "src", "views");

const AREAS = [
  { id: 1, parent_area_id: null, manager_user_id: 100 },
  { id: 2, parent_area_id: 1, manager_user_id: 200 },
  { id: 3, parent_area_id: 2, manager_user_id: null },
  { id: 4, parent_area_id: 1, manager_user_id: 400 },
];

const USERS = [
  { id: 100, role: "Administrador", work_area_id: 1 },
  { id: 200, role: "Usuario", work_area_id: 2 },
  { id: 201, role: "Usuario", work_area_id: 2 },
  { id: 401, role: "Usuario", work_area_id: 4 },
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

function foto(assignments) {
  return {
    users: new Map(USERS.map((u) => [u.id, u])),
    areas: AREAS,
    sets: new Map(),
    assignments,
  };
}

function permisos(userId, assignments) {
  return computePermissions(foto(assignments), { id: userId }, { catalog: CL });
}

function aplicando(perms) {
  perms.mode = "aplicar";
  perms.bootstrapped = true;
  return perms;
}

const USUARIO = (workAreaId) => legacyContext({ role: "Usuario" }, { workAreaId });
const ADMIN = legacyContext({ role: "Administrador" }, { workAreaId: 1 });

describe("reglas antiguas de Procesos", () => {
  const vacio = permisos(201, []);

  it("un colaborador ve su carpeta y no la ajena; un admin ve todo", () => {
    assert.equal(decide(vacio, "procesos.procedimientos.ver", USUARIO(2), { record: { areaId: 2 } }), true);
    assert.equal(decide(vacio, "procesos.protocolos.ver", USUARIO(2), { record: { areaId: 4 } }), false);
    assert.equal(decide(vacio, "procesos.procedimientos.ver", USUARIO(2)), true, "entrar a la sección");
    assert.equal(decide(vacio, "procesos.procedimientos.ver", ADMIN, { record: { areaId: 4 } }), true);
    assert.equal(decide(vacio, "procesos.reglamento.ver", USUARIO(2)), true);
    assert.equal(decide(vacio, "procesos.otros.ver", USUARIO(null)), true);
  });

  it("sin área y escribir en cualquier carpeta es de administrador", () => {
    assert.equal(decide(vacio, "procesos.sin_area.ver", USUARIO(2)), false);
    assert.equal(decide(vacio, "procesos.sin_area.ver", ADMIN), true);
    assert.equal(decide(vacio, "procesos.sin_area.administrar", USUARIO(2)), false);
    assert.equal(decide(vacio, "procesos.procedimientos.subir", USUARIO(2), { record: { areaId: 2 } }), false);
    assert.equal(decide(vacio, "procesos.protocolos.eliminar", ADMIN, { record: { areaId: 4 } }), true);
    assert.equal(decide(vacio, "procesos.reglamento.editar", USUARIO(2)), false);
  });

  it("una cuenta deshabilitada no entra", () => {
    const off = legacyContext({ role: "Deshabilitado" }, { workAreaId: 2 });
    assert.equal(decide(vacio, "procesos.procedimientos.ver", off, { record: { areaId: 2 } }), false);
    assert.equal(decide(vacio, "procesos.acceso", off), false);
  });
});

describe("Procesos al aplicar los conjuntos", () => {
  function conceder(userId, items) {
    return aplicando(permisos(userId, items.map((item) => asignacion({
      principal_type: "user",
      user_id: userId,
      permission_key: item.permission_key,
      scope: item.scope,
    }))));
  }

  it("Básico (mi área) da la carpeta propia y no la ajena", () => {
    const items = SYSTEM_SETS.find((s) => s.code === "basico").items
      .filter((i) => i.permission_key.startsWith("procesos."));
    const p = conceder(201, items);
    assert.equal(puedeVerCarpeta(p, USUARIO(2), "procedimientos", 2), true);
    assert.equal(puedeVerCarpeta(p, USUARIO(2), "protocolos", 4), false);
    assert.equal(puedeSubir(p, USUARIO(2), "procedimientos", 2), false);
    assert.equal(veListadoDeCarpetas(p, USUARIO(2)), false);
  });

  it("Jefatura da las carpetas a cargo", () => {
    const items = SYSTEM_SETS.find((s) => s.code === "jefatura").items
      .filter((i) => i.permission_key.startsWith("procesos."));
    assert.deepEqual(items.map((i) => i.permission_key).sort(), [
      "procesos.procedimientos.ver",
      "procesos.protocolos.ver",
    ]);
    const p = conceder(200, items);
    assert.equal(puedeVerCarpeta(p, USUARIO(2), "procedimientos", 2), true);
    assert.equal(puedeVerCarpeta(p, USUARIO(2), "protocolos", 3), true, "cuelga de Finanzas");
    assert.equal(puedeVerCarpeta(p, USUARIO(2), "procedimientos", 4), false);
    assert.equal(veListadoDeCarpetas(p, USUARIO(2)), true);
    assert.ok(CAMBIOS.some((linea) => /carpetas de procedimientos/.test(linea)));
  });

  it("Editor de procesos da todas las carpetas y la escritura", () => {
    const items = SYSTEM_SETS.find((s) => s.code === "editor_procesos").items;
    const p = conceder(401, items);
    assert.equal(puedeVerCarpeta(p, USUARIO(4), "procedimientos", 2), true);
    assert.equal(puedeVerCarpeta(p, USUARIO(4), "procedimientos", null), true);
    assert.equal(puedeSubir(p, USUARIO(4), "protocolos", 1), true);
    assert.equal(puedeSubir(p, USUARIO(4), "reglamento", null), true);
    assert.equal(veListadoDeCarpetas(p, USUARIO(4)), true);
  });

  it("en sombra el jefe sigue viendo sólo la suya: el listado no cambia", () => {
    const items = SYSTEM_SETS.find((s) => s.code === "jefatura").items
      .filter((i) => i.permission_key.startsWith("procesos."));
    const p = permisos(200, items.map((item) => asignacion({
      principal_type: "user",
      user_id: 200,
      permission_key: item.permission_key,
      scope: item.scope,
    })));
    assert.equal(p.mode, "sombra");
    assert.equal(puedeVerCarpeta(p, USUARIO(2), "procedimientos", 3), false);
    assert.equal(veListadoDeCarpetas(p, USUARIO(2)), false);
    assert.equal(veListadoDeCarpetas(permisos(100, []), ADMIN), true);
  });
});

describe("editar y eliminar salen de doc_kind", () => {
  const editorProcedimientos = aplicando(permisos(201, [
    asignacion({
      principal_type: "user",
      user_id: 201,
      permission_key: "procesos.procedimientos.eliminar",
      scope: "todo",
    }),
  ]));

  it("un doc_kind de protocolo no autoriza quien sólo elimina procedimientos", () => {
    const row = { tabla: "documents", doc_kind: "protocolo", work_area_id: 2, type: "protocolo_finanzas" };
    assert.equal(claveAdministrarDocumento(row, "eliminar").key, "procesos.protocolos.eliminar");
    assert.equal(puedeAdministrarDocumento(editorProcedimientos, USUARIO(2), row, "eliminar"), false);
  });

  it("sin área usa administrar, no la clave de la sección que diga el formulario", () => {
    const row = { tabla: "documents", doc_kind: "procedimiento", work_area_id: null, type: "procedimiento_viejo" };
    assert.deepEqual(claveAdministrarDocumento(row, "editar"), {
      key: "procesos.sin_area.administrar",
      areaId: null,
    });
    assert.equal(puedeAdministrarDocumento(editorProcedimientos, USUARIO(2), row, "editar"), false);
  });

  it("reglamento con work_area_id null no es la carpeta sin área", () => {
    const row = { tabla: "documents", doc_kind: null, work_area_id: null, type: "reglamento" };
    assert.equal(claveAdministrarDocumento(row, "eliminar").key, "procesos.reglamento.eliminar");
  });

  it("otros sale de la tabla, no de un doc_kind inventado", () => {
    const row = { tabla: "other_documents", id: 5 };
    assert.equal(claveAdministrarDocumento(row, "editar").key, "procesos.otros.editar");
  });
});

describe("/content de Procesos", () => {
  const sombra = permisos(201, []);

  it("documento de otra área denegado; el propio permitido", () => {
    const propio = { section: "procedimientos", folder: "2", row: { doc_kind: "procedimiento", work_area_id: 2 } };
    const ajeno = { section: "procedimientos", folder: "4", row: { doc_kind: "procedimiento", work_area_id: 4 } };
    assert.equal(puedeVerDocumento(sombra, USUARIO(2), propio), true);
    assert.equal(puedeVerDocumento(sombra, USUARIO(2), ajeno), false);
  });

  it("la fila manda sobre la carpeta de la URL", () => {
    const movido = { section: "procedimientos", folder: "2", row: { doc_kind: "procedimiento", work_area_id: 4 } };
    assert.equal(puedeVerDocumento(sombra, USUARIO(2), movido), false);
  });

  it("sin área sólo con sin_area.ver; reglamento lo ve cualquiera", () => {
    const huerfano = { section: "protocolos", folder: "sin-area", row: { doc_kind: "protocolo", work_area_id: null } };
    assert.equal(puedeVerDocumento(sombra, USUARIO(2), huerfano), false);
    assert.equal(puedeVerDocumento(sombra, ADMIN, huerfano), true);
    assert.equal(puedeVerDocumento(sombra, USUARIO(2), { section: "reglamento", folder: "general" }), true);
    assert.equal(puedeVerDocumento(sombra, USUARIO(2), { section: "otros", folder: "general" }), true);
  });
});

describe("asistente: documentos de carpetas ajenas", () => {
  const sombra = permisos(201, []);

  it("no devuelve la carpeta de otra área y sí la propia, el reglamento y otros", () => {
    const legado = USUARIO(2);
    assert.equal(puedeVerDocumentoBusqueda(sombra, legado, {
      doc_kind: "procedimiento", work_area_id: 4, area_name: "Comercial", type: "procedimiento_comercial",
    }), false);
    assert.equal(puedeVerDocumentoBusqueda(sombra, legado, {
      doc_kind: "protocolo", work_area_id: 2, area_name: "Finanzas",
    }), true);
    assert.equal(puedeVerDocumentoBusqueda(sombra, legado, { type: "reglamento", work_area_id: null }), true);
    assert.equal(puedeVerDocumentoBusqueda(sombra, legado, { type: "otros", name: "Plantilla" }), true);
    assert.equal(puedeVerDocumentoBusqueda(sombra, ADMIN, {
      doc_kind: "procedimiento", work_area_id: 4,
    }), true);
  });
});

describe("contacto personal del directorio", () => {
  const fila = { personal_email: "ana.perez@gmail.com", phone: "56912345678" };

  it("hoy lo ve una sesión activa, enmascarado y sin el valor", () => {
    const vacio = permisos(201, []);
    assert.equal(decide(vacio, "rrhh.directorio.campo.contacto_personal", USUARIO(2)), true);
    const visible = contactoPersonalDirectorio(fila, true);
    assert.notEqual(visible.correoPersonal, fila.personal_email);
    assert.equal(visible.correoPersonal.includes("ana.perez"), false);
    assert.equal(JSON.stringify(visible).includes("56912345678"), false);
    assert.ok(visible.correoPersonal);
    assert.ok(visible.telefonoPersonal);
  });

  it("sin el permiso no hay máscara ni valor", () => {
    const oculto = contactoPersonalDirectorio(fila, false);
    assert.deepEqual(oculto, { correoPersonal: null, telefonoPersonal: null });
    const p = aplicando(permisos(201, []));
    assert.equal(decide(p, "rrhh.directorio.campo.contacto_personal", USUARIO(2)), false);
  });
});

describe("claves de Procesos usadas", () => {
  it("cada permiso del catálogo de procesos tiene regla antigua", () => {
    const claves = [...CL.byKey.keys()].filter((key) => key.startsWith("procesos.") || key === "rrhh.directorio.campo.contacto_personal");
    const sinRegla = claves.filter((key) => !hasLegacyRule(key));
    assert.deepEqual(sinRegla, []);
  });
});

describe("vistas de Procesos y del directorio", () => {
  const features = getFeatures();

  async function render(view, data) {
    return ejs.renderFile(path.join(VIEWS, view), data, { async: false });
  }

  function canDe(legacyCtx, perms) {
    return buildViewCan(perms || permisos(201, []), {}, { legacyCtx });
  }

  it("el colaborador no ve botones ni carpetas ajenas; el admin sí", async () => {
    const area = { id: 2, area_name: "Finanzas", color: "#123456" };
    const base = {
      features,
      conteosArea: { procedimiento: 1, protocolo: 0 },
      gastosActivos: false,
      esRevisor: false,
      user: { id: 201, work_area_id: 2 },
      areaContext: { area, manager: null, isManager: false, requiresAdmin: false },
    };
    const deUsuario = await render("procesos/index.ejs", {
      ...base,
      veListadoCarpetas: false,
      can: canDe(USUARIO(2)),
    });
    assert.match(deUsuario, /Mi área/);
    assert.match(deUsuario, /\/procesos\/procedimientos\/2/);
    assert.equal(deUsuario.includes('href="/procesos/procedimientos"'), false);
    assert.equal(deUsuario.includes("Comercial"), false);

    const deAdmin = await render("procesos/index.ejs", {
      ...base,
      veListadoCarpetas: true,
      can: canDe(ADMIN),
    });
    assert.match(deAdmin, /Áreas/);
    assert.match(deAdmin, /href="\/procesos\/procedimientos"/);

    const carpeta = {
      titulo: "Procedimientos: Finanzas",
      tituloSeccion: "Procedimientos",
      tituloArea: "Finanzas",
      seccionBase: "procedimientos",
      slugArea: "2",
      areaColor: "#123456",
      archivos: [{ id: 9, url: "/content/documentos/procedimientos/2/a.pdf", name: "Manual", public_id: "documentos/procedimientos/2/a.pdf", format: "pdf" }],
      user: { id: 201 },
    };
    const archivosUsuario = await render("procesos/vista_archivos.ejs", {
      ...carpeta,
      can: canDe(USUARIO(2)),
    });
    assert.equal(archivosUsuario.includes("Subir documento"), false);
    assert.equal(archivosUsuario.includes("data-eliminar-doc"), false);
    assert.match(archivosUsuario, /Manual/);

    const archivosAdmin = await render("procesos/vista_archivos.ejs", {
      ...carpeta,
      can: canDe(ADMIN),
    });
    assert.match(archivosAdmin, /Subir documento/);
    assert.match(archivosAdmin, /data-eliminar-doc/);

    const listado = await render("procesos/menu_carpetas.ejs", {
      titulo: "Procedimientos",
      seccionBase: "procedimientos",
      slugSinArea: "sin-area",
      huerfanos: 0,
      areas: [{ id: 2, area_name: "Finanzas", color: "#123456", cantidad: 1 }],
    });
    assert.match(listado, /Finanzas/);
    assert.equal(listado.includes("Comercial"), false);
  });

  it("sin can.field el correo personal no sale en el HTML", async () => {
    const persona = {
      id: 7,
      first_name: "Ana",
      last_name: "Pérez",
      email: "ana@transworld.cl",
      work_phone: "+56 9 1111 2222",
      correoPersonal: "ana.perez@gmail.com",
      telefonoPersonal: "56912345678",
      photo: "/content/user/7.jpg",
      area: "Finanzas",
      pillClass: "pill",
      fechaCumpleFmt: "-",
      ordenCumple: 9999,
      role: "Usuario",
    };
    const datos = {
      titulo: "Personal",
      countryConfig: getCountryConfig(),
      personas: [persona],
      areas: [],
      puedeEditar: false,
      canManageRrhh: false,
      mostrarColumnaRol: false,
      documentoConfig: { kind: "rut" },
      phoneClientConfig,
      user: { id: 201 },
      success: null,
      error: null,
    };
    const oculto = await render("RRHH/personal.ejs", {
      ...datos,
      can: buildViewCan(aplicando(permisos(201, [])), {}, { legacyCtx: USUARIO(2) }),
    });
    assert.equal(oculto.includes("ana.perez@gmail.com"), false);
    assert.equal(oculto.includes("56912345678"), false);
    assert.match(oculto, /ana@transworld.cl/);

    const visible = await render("RRHH/personal.ejs", {
      ...datos,
      personas: [{ ...persona, correoPersonal: "an***@gmail.com", telefonoPersonal: "+56 * **** 5678" }],
      can: canDe(USUARIO(2)),
    });
    assert.match(visible, /an\*\*\*@gmail.com/);
    assert.equal(visible.includes("ana.perez@gmail.com"), false);
  });
});
