const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { planBootstrap, findUsersByName, SYSTEM_SETS } = require("../src/services/permissions/bootstrap");
const { getCatalog, allKeys } = require("../src/services/permissions/catalog");
const { computePermissions } = require("../src/services/permissions/resolver");

/*
 * Perú de prueba:
 *   Gerencia (1, Gustavo 10)
 *   ├── Administración (2, Patricia 20)   ← hace de RRHH
 *   ├── Finanzas (3, Freddy 30)
 *   └── Informática (4, Bastián 40)
 */
const AREAS_PE = [
  { id: 1, area_name: "Gerencia", parent_area_id: null, manager_user_id: 10 },
  { id: 2, area_name: "Administración", parent_area_id: 1, manager_user_id: 20 },
  { id: 3, area_name: "Finanzas", parent_area_id: 1, manager_user_id: 30 },
  { id: 4, area_name: "Informática", parent_area_id: 1, manager_user_id: 40 },
];
const USERS_PE = [
  { id: 10, first_name: "Gustavo", last_name: "Valenzuela", role: "Usuario", work_area_id: 1 },
  { id: 20, first_name: "Patricia", last_name: "Portillo", role: "Administrador", work_area_id: 2 },
  { id: 21, first_name: "Rocio", last_name: "Rivera", role: "Usuario", work_area_id: 2 },
  { id: 30, first_name: "Freddy", last_name: "Payano", role: "Administrador", work_area_id: 3 },
  { id: 31, first_name: "Astrid", last_name: "Ortiz", role: "Usuario", work_area_id: 3 },
  { id: 40, first_name: "Bastián", last_name: "Sánchez", role: "Administrador", work_area_id: 4 },
  { id: 41, first_name: "Bastián", last_name: "Dummy", role: "Usuario", work_area_id: 4 },
  { id: 50, first_name: "Ex", last_name: "Colaborador", role: "Deshabilitado", work_area_id: 3 },
];

/*
 * Chile de prueba:
 *   Gerencia (1, jefe 100)
 *   └── Finanzas (2, jefe 200)
 *       └── Recursos Humanos (3, jefe 300)
 *   Informática (4, sin jefe)
 *   Marketing (5, sin jefe)
 */
const AREAS_CL = [
  { id: 1, area_name: "Gerencia", parent_area_id: null, manager_user_id: 100 },
  { id: 2, area_name: "Finanzas", parent_area_id: 1, manager_user_id: 200 },
  { id: 3, area_name: "Recursos Humanos", parent_area_id: 2, manager_user_id: 300 },
  { id: 4, area_name: "Informática", parent_area_id: 1, manager_user_id: null },
  { id: 5, area_name: "Marketing", parent_area_id: 1, manager_user_id: null },
];
const USERS_CL = [
  { id: 100, first_name: "Gerente", last_name: "General", role: "Usuario", work_area_id: 1 },
  { id: 200, first_name: "Jefa", last_name: "Finanzas", role: "Administrador", work_area_id: 2 },
  { id: 201, first_name: "Asistente", last_name: "Finanzas", role: "Usuario", work_area_id: 2 },
  { id: 300, first_name: "Jefa", last_name: "Personas", role: "Administrador", work_area_id: 3 },
  { id: 400, first_name: "Bastián", last_name: "Sánchez", role: "Administrador", work_area_id: 4 },
  { id: 401, first_name: "Técnico", last_name: "Soporte", role: "Usuario", work_area_id: 4 },
  { id: 500, first_name: "Admin", last_name: "Marketing", role: "Administrador", work_area_id: 5 },
];

function planDe(country) {
  const catalog = getCatalog(country);
  const [users, areas] = country === "PE" ? [USERS_PE, AREAS_PE] : [USERS_CL, AREAS_CL];
  return { plan: planBootstrap({ country, catalog, users, areas }), catalog, users, areas };
}

/** Aplica el plan en memoria (como lo haría el script) y resuelve permisos. */
function permisosTras(country, userId) {
  const { plan, catalog, users, areas } = planDe(country);
  const sets = new Map(plan.sets.map((s, i) => [i + 1, { id: i + 1, code: s.code, name: s.name, active: true, items: s.items }]));
  const idDe = new Map(plan.sets.map((s, i) => [s.code, i + 1]));
  const superIds = new Set(plan.superadmins.map((u) => u.id));
  const snapshot = {
    users: new Map(users.map((u) => [u.id, { ...u, is_superadmin: superIds.has(u.id) }])),
    areas,
    sets,
    assignments: plan.assignments.map((a, i) => ({
      id: i + 1,
      ...a,
      set_id: idDe.get(a.set_code),
      permission_key: null,
      effect: "concede",
    })),
  };
  return computePermissions(snapshot, { id: userId }, { catalog });
}

const asignados = (plan, code) => plan.assignments.filter((a) => a.set_code === code);

describe("conjuntos iniciales", () => {
  it("sólo citan permisos del catálogo y no repiten permiso con el mismo alcance", () => {
    const conocidas = new Set(allKeys());
    for (const set of SYSTEM_SETS) {
      const vistos = new Set();
      for (const i of set.items) {
        assert.ok(conocidas.has(i.permission_key), `${set.code}: ${i.permission_key}`);
        const k = `${i.permission_key}|${i.scope || ""}`;
        assert.ok(!vistos.has(k), `${set.code} repite ${k}`);
        vistos.add(k);
      }
    }
  });

  it("cada país crea sólo los conjuntos que tienen permisos ahí", () => {
    const pe = planDe("PE").plan.sets.map((s) => s.code);
    const cl = planDe("CL").plan.sets.map((s) => s.code);
    assert.ok(pe.includes("gestion_vacaciones") && pe.includes("personal_finanzas"));
    assert.ok(!pe.includes("editor_casino") && !pe.includes("mesa_ayuda") && !pe.includes("aprobador_finanzas"));
    assert.ok(cl.includes("mesa_ayuda") && cl.includes("aprobador_finanzas") && cl.includes("editor_casino"));
    assert.ok(!cl.includes("gestion_vacaciones") && !cl.includes("personal_finanzas"));
  });
});

describe("superadmin", () => {
  it("encuentra a Bastián Sánchez y no a Bastián Dummy", () => {
    assert.deepEqual(findUsersByName(USERS_PE, "Bastián Sánchez").map((u) => u.id), [40]);
    assert.deepEqual(findUsersByName(USERS_PE, "bastian sanchez").map((u) => u.id), [40]);
    assert.deepEqual(planDe("PE").plan.superadmins.map((u) => u.id), [40]);
  });

  it("si no está o es ambiguo, el plan no se puede aplicar", () => {
    const catalog = getCatalog("PE");
    const sinNadie = planBootstrap({ country: "PE", catalog, users: USERS_PE, areas: AREAS_PE, superadminName: "Nadie Nunca" });
    assert.equal(sinNadie.problems.length, 1);
    const ambiguo = planBootstrap({ country: "PE", catalog, users: USERS_PE, areas: AREAS_PE, superadminName: "Bastián" });
    assert.match(ambiguo.problems[0], /varias cuentas/);
  });

  it("al superadmin no se le crean asignaciones sueltas", () => {
    assert.ok(planDe("PE").plan.assignments.every((a) => a.user_id !== 40));
  });
});

describe("Perú: copia de lo de hoy", () => {
  const { plan } = planDe("PE");

  it("todos tienen el básico y los jefes la jefatura", () => {
    assert.equal(asignados(plan, "basico")[0].principal_type, "global");
    assert.equal(asignados(plan, "jefatura")[0].principal_type, "jefes");
  });

  it("Administración gestiona personal y vacaciones por persona, no por nombre de área", () => {
    const ids = asignados(plan, "gestion_personal").map((a) => a.user_id);
    assert.deepEqual(ids, [20], "sólo Patricia (Administradora en el área)");
    assert.deepEqual(asignados(plan, "gestion_vacaciones").map((a) => a.user_id), [20]);
  });

  it("Finanzas con sus subáreas emite letras", () => {
    const [a] = asignados(plan, "personal_finanzas");
    assert.equal(a.principal_type, "area");
    assert.equal(a.area_id, 3);
    assert.equal(a.include_subareas, true);
  });

  it("los administradores reciben los editores; los deshabilitados nada", () => {
    for (const code of ["editor_noticias", "editor_eventos", "editor_apps", "editor_procesos"]) {
      assert.deepEqual(asignados(plan, code).map((a) => a.user_id).sort(), [20, 30], code);
    }
    assert.ok(plan.assignments.every((a) => a.user_id !== 50));
  });

  it("resultado: Gustavo aprueba vacaciones de toda la cadena; RRHH gestiona pero no aprueba", () => {
    const gustavo = permisosTras("PE", 10);
    assert.equal(gustavo.canOnRecord("vacaciones.solicitud.aprobar", { areaId: 3 }), true);
    const patricia = permisosTras("PE", 20);
    assert.equal(patricia.can("vacaciones.saldo.ajustar"), true);
    assert.equal(patricia.canOnRecord("vacaciones.solicitud.aprobar", { areaId: 3 }), false, "Finanzas no es suya");
    assert.equal(patricia.canOnRecord("vacaciones.solicitud.aprobar", { areaId: 2 }), true, "su área sí, como jefa");
    const astrid = permisosTras("PE", 31);
    assert.equal(astrid.can("letras.letra.crear"), true);
    assert.equal(astrid.can("noticias.noticia.crear"), false);
    assert.equal(astrid.canOnRecord("vacaciones.solicitud.ver", { ownerId: 31 }), true);
    assert.equal(astrid.canOnRecord("vacaciones.solicitud.ver", { ownerId: 30 }), false);
    assert.equal(permisosTras("PE", 40).can("vacaciones.configuracion.editar"), true, "superadmin");
  });
});

describe("Chile: copia de lo de hoy", () => {
  const { plan } = planDe("CL");

  it("aprobar Finanzas sólo los administradores de Finanzas y sus subáreas", () => {
    assert.deepEqual(asignados(plan, "aprobador_finanzas").map((a) => a.user_id).sort(), [200, 300]);
  });

  it("RRHH (bajo Finanzas) gestiona personal; Marketing no", () => {
    assert.deepEqual(asignados(plan, "gestion_personal").map((a) => a.user_id), [300]);
  });

  it("la mesa de ayuda es el área de Informática completa", () => {
    const [a] = asignados(plan, "mesa_ayuda");
    assert.equal(a.principal_type, "area");
    assert.equal(a.area_id, 4);
    const tecnico = permisosTras("CL", 401);
    assert.equal(tecnico.can("soporte.ticket.gestionar"), true);
    assert.equal(tecnico.canOnRecord("soporte.ticket.ver", { ownerId: 999 }), true);
  });

  it("un administrador de otra área sigue viendo todos los tickets, sin gestionarlos", () => {
    assert.deepEqual(asignados(plan, "lectura_tickets").map((a) => a.user_id).sort(), [200, 300, 500]);
    const marketing = permisosTras("CL", 500);
    assert.equal(marketing.canOnRecord("soporte.ticket.ver", { ownerId: 999 }), true);
    assert.equal(marketing.can("soporte.ticket.gestionar"), false);
  });

  it("un administrador cualquiera ya no ve ni aprueba rendiciones ajenas", () => {
    const marketing = permisosTras("CL", 500);
    assert.equal(marketing.canOnRecord("gastos.solicitud.ver", { ownerId: 201, areaId: 2 }), false);
    assert.equal(marketing.can("gastos.solicitud.aprobar_finanzas"), false);
    assert.equal(marketing.can("noticias.noticia.crear"), true, "pero sigue editando contenidos");
  });

  it("el jefe aprueba la jefatura de toda su cadena", () => {
    const jefaFinanzas = permisosTras("CL", 200);
    assert.equal(jefaFinanzas.canOnRecord("gastos.solicitud.aprobar_jefatura", { areaId: 3 }), true);
    assert.equal(jefaFinanzas.canOnRecord("gastos.solicitud.aprobar_jefatura", { areaId: 5 }), false);
  });

  it("el reporte lista los cambios deliberados y lo que hay que revisar", () => {
    assert.ok(plan.changes.length >= 5);
    assert.ok(plan.warnings.some((w) => w.includes("KPI de cursos")));
    assert.deepEqual(plan.problems, []);
  });
});
