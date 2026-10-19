const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { sessionAccountState } = require("../src/services/access/accountStatus");
const { classifyContentPath, canOpenAreaFolder } = require("../src/services/access/contentAccess");
const { reviewerStageFor } = require("../src/services/expenses/expenseRequestService");
const { EXPENSE_STATUS } = require("../src/constants/expenseStatuses");

describe("estado de la cuenta en cada petición", () => {
  const sesion = { id: 7, role: "Administrador" };

  it("mantiene la sesión si la cuenta sigue igual", () => {
    assert.deepEqual(sessionAccountState(sesion, { role: "Administrador" }), { action: "keep" });
  });

  it("corrige el rol cuando se lo cambiaron", () => {
    assert.deepEqual(sessionAccountState(sesion, { role: "Usuario" }), {
      action: "update",
      role: "Usuario",
    });
  });

  it("cierra la sesión de una cuenta deshabilitada o eliminada", () => {
    assert.deepEqual(sessionAccountState(sesion, { role: "Deshabilitado" }), { action: "end" });
    assert.deepEqual(sessionAccountState(sesion, undefined), { action: "end" });
  });

  it("no toca el login de emergencia (id 0), que no existe en users", () => {
    assert.deepEqual(sessionAccountState({ id: 0, role: "Administrador" }, undefined), {
      action: "keep",
    });
  });
});

describe("/content — qué regla le toca a cada archivo", () => {
  it("documentos de Procesos por carpeta de área", () => {
    assert.deepEqual(classifyContentPath("documentos/procedimientos/12/manual.pdf"), {
      kind: "area_document",
      section: "procedimientos",
      folder: "12",
    });
    assert.equal(classifyContentPath("documentos/reglamento/general/ri.pdf").folder, "general");
  });

  it("comprobantes de gastos: dueño y solicitud", () => {
    assert.deepEqual(classifyContentPath("gastos/2026/614793/76587612_2_taxi.jpg"), {
      kind: "expense_attachment",
      ownerId: 614793,
      requestId: 76587612,
    });
    assert.deepEqual(classifyContentPath("gastos/2026/614793/boleta.pdf"), {
      kind: "expense_attachment",
      ownerId: 614793,
      requestId: null,
    });
    assert.equal(classifyContentPath("gastos/raro.pdf").kind, "admin_only");
  });

  it("adjuntos de tickets por número de ticket", () => {
    assert.deepEqual(classifyContentPath("tickets_adjuntos/1234_1.png"), {
      kind: "ticket_attachment",
      ticketId: 1234,
    });
    assert.deepEqual(classifyContentPath("tickets_adjuntos/1234_3_2.pdf").ticketId, 1234);
  });

  it("el contenido de toda la intranet sigue abierto con la sesión", () => {
    for (const p of ["eventos/aniversario/foto.jpg", "noticias/portada.png", "user/7.jpg", "apps_icons/x.png"]) {
      assert.equal(classifyContentPath(p).kind, "open", p);
    }
  });
});

describe("/content — carpetas de Procesos", () => {
  it("un colaborador abre sólo la carpeta de su área", () => {
    assert.equal(canOpenAreaFolder({ folder: "12", isAdmin: false, userAreaId: 12 }), true);
    assert.equal(canOpenAreaFolder({ folder: "13", isAdmin: false, userAreaId: 12 }), false);
    assert.equal(canOpenAreaFolder({ folder: "12", isAdmin: false, userAreaId: null }), false);
  });

  it("sin área sólo para administradores; general para todos", () => {
    assert.equal(canOpenAreaFolder({ folder: "sin-area", isAdmin: false, userAreaId: 12 }), false);
    assert.equal(canOpenAreaFolder({ folder: "sin-area", isAdmin: true, userAreaId: null }), true);
    assert.equal(canOpenAreaFolder({ folder: "general", isAdmin: false, userAreaId: null }), true);
  });
});

describe("gastos — nadie resuelve lo propio", () => {
  const admin = { id: 7, role: "Administrador" };

  it("un administrador no aprueba su propia solicitud sin jefe", async () => {
    const propia = { user_id: 7, status: EXPENSE_STATUS.PENDING, manager_user_id: null };
    assert.equal(await reviewerStageFor(propia, admin), null);
  });

  it("el jefe asignado no aprueba la suya aunque figure como aprobador", async () => {
    const propia = { user_id: 7, status: EXPENSE_STATUS.PENDING, manager_user_id: 7 };
    assert.equal(await reviewerStageFor(propia, admin), null);
  });

  it("tampoco en la etapa de Finanzas", async () => {
    const propia = { user_id: 7, status: EXPENSE_STATUS.APPROVED_MANAGER, manager_user_id: 9 };
    assert.equal(await reviewerStageFor(propia, admin), null);
  });

  it("sí resuelve la de otro como antes", async () => {
    const ajena = { user_id: 8, status: EXPENSE_STATUS.PENDING, manager_user_id: null };
    assert.equal(await reviewerStageFor(ajena, admin), "manager");
  });
});
