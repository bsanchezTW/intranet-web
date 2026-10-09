const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  chainFrom,
  resolveApproverFromChain,
  descendantIds,
  wouldCreateCycle,
  buildTree,
} = require("../src/services/workAreaTree");

// Gerencia (jefe 10)
// ├── Operaciones (jefe 20)
// │   ├── Bodega (sin jefe)
// │   └── Logística (jefe 30)
// └── Finanzas (sin jefe)
const AREAS = [
  { id: 1111, area_name: "Gerencia", parent_area_id: null, manager_user_id: 10 },
  { id: 2222, area_name: "Operaciones", parent_area_id: 1111, manager_user_id: 20 },
  { id: 3333, area_name: "Bodega", parent_area_id: 2222, manager_user_id: null },
  { id: 4444, area_name: "Logística", parent_area_id: 2222, manager_user_id: 30 },
  { id: 5555, area_name: "Finanzas", parent_area_id: 1111, manager_user_id: null },
];

describe("workAreaTree — aprobador escalado", () => {
  it("usa el jefe directo del área cuando existe", () => {
    assert.deepEqual(resolveApproverFromChain(AREAS, 4444, 99), {
      ok: true,
      managerId: 30,
      approverAreaId: 4444,
      requiresAdmin: false,
    });
  });

  it("sube al jefe del área padre cuando el área no tiene jefe", () => {
    const result = resolveApproverFromChain(AREAS, 3333, 99);
    assert.equal(result.managerId, 20);
    assert.equal(result.approverAreaId, 2222);
  });

  it("el jefe que solicita sube al jefe del área superior", () => {
    const result = resolveApproverFromChain(AREAS, 4444, 30);
    assert.equal(result.managerId, 20);
    assert.equal(result.requiresAdmin, false);
  });

  it("el jefe de la raíz que solicita queda para un administrador", () => {
    assert.deepEqual(resolveApproverFromChain(AREAS, 1111, 10), {
      ok: true,
      managerId: null,
      approverAreaId: null,
      requiresAdmin: true,
    });
  });

  it("bloquea cuando ningún área de la cadena tiene jefe", () => {
    const sinJefes = AREAS.map((a) => ({ ...a, manager_user_id: null }));
    assert.deepEqual(resolveApproverFromChain(sinJefes, 3333, 99), {
      ok: false,
      reason: "no_manager",
    });
  });

  it("bloquea cuando el área no existe", () => {
    assert.deepEqual(resolveApproverFromChain(AREAS, 9999, 99), {
      ok: false,
      reason: "no_area",
    });
  });

  describe("un gerente que dirige varias áreas", () => {
    // El gerente 10 dirige Gerencia, Bodega y Finanzas aunque trabaje en una sola.
    const conGerente = AREAS.map((a) =>
      a.id === 3333 || a.id === 5555 ? { ...a, manager_user_id: 10 } : a,
    );

    it("aprueba en cada área que dirige", () => {
      assert.equal(resolveApproverFromChain(conGerente, 3333, 99).managerId, 10);
      assert.equal(resolveApproverFromChain(conGerente, 5555, 99).managerId, 10);
      assert.equal(resolveApproverFromChain(conGerente, 4444, 99).managerId, 30);
    });

    it("cuando solicita sube al siguiente jefe distinto de él", () => {
      const result = resolveApproverFromChain(conGerente, 3333, 10);
      assert.equal(result.managerId, 20);
      assert.equal(result.approverAreaId, 2222);
    });

    it("si todas las jefaturas de su cadena son suyas, queda para un administrador", () => {
      assert.equal(resolveApproverFromChain(conGerente, 5555, 10).requiresAdmin, true);
    });
  });

  it("un ciclo en los datos no cuelga el recorrido", () => {
    const ciclo = [
      { id: 1, parent_area_id: 2, manager_user_id: null },
      { id: 2, parent_area_id: 1, manager_user_id: null },
    ];
    assert.equal(chainFrom(ciclo, 1).length, 2);
    assert.deepEqual(resolveApproverFromChain(ciclo, 1, 99), {
      ok: false,
      reason: "no_manager",
    });
  });
});

describe("vacaciones — quién resuelve la solicitud", () => {
  const { canReviewRequest } = require("../src/services/vacations/vacationRequestService");
  const solicitud = { user_id: 99, approver_user_id: 20 };

  it("el jefe congelado puede resolverla y otro jefe no", () => {
    assert.equal(canReviewRequest(solicitud, 20), true);
    assert.equal(canReviewRequest(solicitud, 30), false);
  });

  it("RRHH la resuelve como respaldo, también sin jefe asignado", () => {
    assert.equal(canReviewRequest(solicitud, 55, { isRrhhManager: true }), true);
    assert.equal(
      canReviewRequest({ user_id: 99, approver_user_id: null }, 55, { isRrhhManager: true }),
      true,
    );
    assert.equal(canReviewRequest({ user_id: 99, approver_user_id: null }, 20), false);
  });

  it("nadie resuelve su propia solicitud", () => {
    assert.equal(canReviewRequest(solicitud, 99, { isRrhhManager: true }), false);
  });
});

describe("workAreaTree — estructura", () => {
  it("lista los descendientes a cualquier profundidad", () => {
    assert.deepEqual([...descendantIds(AREAS, 1111)].sort(), [2222, 3333, 4444, 5555]);
    assert.deepEqual([...descendantIds(AREAS, 3333)], []);
  });

  it("detecta que colgar un área de sí misma o de un descendiente cierra un ciclo", () => {
    assert.equal(wouldCreateCycle(AREAS, 2222, 2222), true);
    assert.equal(wouldCreateCycle(AREAS, 1111, 3333), true);
    assert.equal(wouldCreateCycle(AREAS, 3333, 5555), false);
    assert.equal(wouldCreateCycle(AREAS, 3333, null), false);
  });

  it("arma raíces e hijos ordenados por nombre con su profundidad", () => {
    const roots = buildTree(AREAS);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].area_name, "Gerencia");
    assert.deepEqual(
      roots[0].children.map((c) => c.area_name),
      ["Finanzas", "Operaciones"],
    );
    const operaciones = roots[0].children[1];
    assert.deepEqual(
      operaciones.children.map((c) => [c.area_name, c.depth]),
      [["Bodega", 2], ["Logística", 2]],
    );
  });

  it("ordena las hermanas por sort_order y deja al final, por nombre, las que no lo tienen", () => {
    const roots = buildTree([
      { id: 1, area_name: "Raíz" },
      { id: 2, area_name: "Zeta", parent_area_id: 1, sort_order: 1 },
      { id: 3, area_name: "Alfa", parent_area_id: 1, sort_order: 2 },
      { id: 4, area_name: "Beta", parent_area_id: 1 },
      { id: 5, area_name: "Abeja", parent_area_id: 1 },
    ]);
    assert.deepEqual(
      roots[0].children.map((c) => c.area_name),
      ["Zeta", "Alfa", "Abeja", "Beta"],
    );
  });

  it("dibuja como raíz un área cuyo padre no existe o está en un ciclo", () => {
    const roots = buildTree([
      { id: 1, area_name: "Huérfana", parent_area_id: 77 },
      { id: 2, area_name: "A", parent_area_id: 3 },
      { id: 3, area_name: "B", parent_area_id: 2 },
    ]);
    assert.deepEqual(roots.map((r) => r.area_name).sort(), ["A", "B", "Huérfana"]);
  });
});
