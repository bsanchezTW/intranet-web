const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const {
  EXPENSE_STATUS,
  EXPENSE_KIND,
  ALL_EXPENSE_STATUSES,
  expenseStatusLabel,
  expenseStatusBadge,
  expenseKindLabel,
  expenseStageLabel,
  isExpenseKind,
} = require("../src/constants/expenseStatuses");
const { isFinanceAreaName, FINANCE_AREA_NAMES } = require("../src/constants/financeArea");
const { areaSlug, normalizeAreaName } = require("../src/constants/workAreas");
const { isSupportAreaName } = require("../src/constants/supportArea");
const { requiresAdminApproval } = require("../src/services/expenses/areaManager");
const {
  parseAmount,
  normalizeItems,
  normalizeAttachments,
} = require("../src/services/expenses/expenseRequestService");

describe("expenseStatuses — estados y etiquetas", () => {
  it("declara el flujo de dos etapas", () => {
    assert.deepEqual(ALL_EXPENSE_STATUSES, [
      "pending",
      "approved_manager",
      "approved_finance",
      "rejected",
      "cancelled",
    ]);
  });

  it("cada estado tiene etiqueta y badge propios", () => {
    for (const status of ALL_EXPENSE_STATUSES) {
      assert.notEqual(expenseStatusLabel(status), status, status);
      assert.match(expenseStatusBadge(status), /^gasto-badge gasto-badge--/, status);
    }
  });

  it("un estado desconocido no revienta la vista", () => {
    assert.equal(expenseStatusLabel("marciano"), "marciano");
    assert.equal(expenseStatusBadge("marciano"), "gasto-badge");
  });

  it("distingue rendición de solicitud de fondos", () => {
    assert.equal(expenseKindLabel(EXPENSE_KIND.RENDICION), "Rendición de gastos");
    assert.equal(expenseKindLabel(EXPENSE_KIND.FONDOS), "Solicitud de fondos");
    assert.equal(isExpenseKind("rendicion"), true);
    assert.equal(isExpenseKind("fondos"), true);
    assert.equal(isExpenseKind("otra_cosa"), false);
    assert.equal(isExpenseKind(""), false);
  });

  it("nombra las dos etapas de aprobación", () => {
    assert.equal(expenseStageLabel("manager"), "Jefatura de área");
    assert.equal(expenseStageLabel("finance"), "Finanzas");
  });
});

describe("financeArea — quién aprueba en Finanzas", () => {
  it("reconoce el área sin importar acentos ni mayúsculas", () => {
    assert.equal(isFinanceAreaName("Finanzas"), true);
    assert.equal(isFinanceAreaName("finanzas"), true);
    assert.equal(isFinanceAreaName("  FINANZAS  "), true);
    assert.equal(isFinanceAreaName("Administración y Finanzas"), true);
  });

  it("no confunde Finanzas con otras áreas", () => {
    assert.equal(isFinanceAreaName("Marketing"), false);
    assert.equal(isFinanceAreaName("Informática"), false);
    assert.equal(isFinanceAreaName(""), false);
    assert.equal(isFinanceAreaName(null), false);
  });

  it("Finanzas y Soporte son áreas distintas", () => {
    for (const nombre of FINANCE_AREA_NAMES) {
      assert.equal(isSupportAreaName(nombre), false, nombre);
    }
  });
});

describe("workAreas — slug de área", () => {
  it("resuelve los enlaces históricos de /procesos", () => {
    assert.equal(areaSlug("Logística"), "logistica");
    assert.equal(areaSlug("logistica"), "logistica");
    assert.equal(areaSlug("Control y Gestión"), "control-y-gestion");
    assert.equal(areaSlug("  Informática  "), "informatica");
  });

  it("no deja guiones sueltos en los bordes", () => {
    assert.equal(areaSlug("¡Área!"), "area");
    assert.equal(areaSlug("---"), "");
    assert.equal(areaSlug(""), "");
    assert.equal(areaSlug(null), "");
  });

  it("normalizeAreaName sigue disponible desde supportArea", () => {
    assert.equal(normalizeAreaName("Informática"), "informatica");
    assert.equal(require("../src/constants/supportArea").normalizeAreaName, normalizeAreaName);
  });
});

describe("expenseRequestService — montos del desglose", () => {
  it("acepta el separador de miles y la coma decimal", () => {
    assert.equal(parseAmount("45000"), 45000);
    assert.equal(parseAmount("45.000"), 45000);
    assert.equal(parseAmount("1.234.567"), 1234567);
    assert.equal(parseAmount("45000,50"), 45000.5);
    assert.equal(parseAmount(" 120 "), 120);
    assert.equal(parseAmount(0), 0);
  });

  it("rechaza lo que no es un monto válido", () => {
    assert.equal(parseAmount(""), null);
    assert.equal(parseAmount(null), null);
    assert.equal(parseAmount("abc"), null);
    assert.equal(parseAmount("-100"), null);
  });

  it("redondea a dos decimales", () => {
    assert.equal(parseAmount("10,005"), 10.01);
    assert.equal(parseAmount("10,004"), 10);
  });
});

describe("expenseRequestService — normalización del desglose", () => {
  it("calcula el total desde los ítems, no desde el cliente", () => {
    const r = normalizeItems([
      { detail: "Peaje", amount: "12.500", item_date: "2026-09-01" },
      { detail: "Hotel", amount: "70000", item_date: "2026-09-02" },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.total, 82500);
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0].itemDate, "2026-09-01");
  });

  it("ignora la última fila vacía del formulario", () => {
    const r = normalizeItems([
      { detail: "Peaje", amount: "1000" },
      { detail: "", amount: "" },
      { detail: "  ", amount: null },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 1);
    assert.equal(r.total, 1000);
  });

  it("exige detalle y monto en toda fila iniciada", () => {
    assert.equal(normalizeItems([{ detail: "", amount: "500" }]).ok, false);
    assert.equal(normalizeItems([{ detail: "Peaje", amount: "abc" }]).ok, false);
  });

  it("rechaza un desglose vacío o sin monto", () => {
    assert.equal(normalizeItems([]).ok, false);
    assert.equal(normalizeItems(null).ok, false);
    assert.equal(normalizeItems([{ detail: "Nada", amount: "0" }]).ok, false);
  });

  it("descarta una fecha que no sea ISO", () => {
    const r = normalizeItems([{ detail: "Peaje", amount: "100", item_date: "01/09/2026" }]);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].itemDate, null);
  });

  it("acota el número de líneas", () => {
    const muchas = Array.from({ length: 80 }, (_, i) => ({
      detail: "Línea " + i,
      amount: "1",
    }));
    const r = normalizeItems(muchas);
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 50);
  });
});

describe("expenseRequestService — adjuntos", () => {
  it("sólo acepta rutas servidas por /content", () => {
    const r = normalizeAttachments([
      { name: "boleta.pdf", url: "/content/gastos/2026/1/b.pdf", public_id: "gastos/2026/1/b.pdf" },
      { name: "externo", url: "https://evil.example/x.pdf", public_id: "x" },
      { name: "relativo", url: "../../etc/passwd", public_id: "y" },
    ]);
    assert.equal(r.length, 1);
    assert.equal(r[0].url, "/content/gastos/2026/1/b.pdf");
  });

  it("pone un nombre por defecto y tolera entradas raras", () => {
    const r = normalizeAttachments([{ url: "/content/a.pdf" }]);
    assert.equal(r[0].name, "Comprobante");
    assert.equal(r[0].publicId, null);
    assert.deepEqual(normalizeAttachments(null), []);
    assert.deepEqual(normalizeAttachments("no-es-lista"), []);
  });

  it("acota el número de comprobantes", () => {
    const muchos = Array.from({ length: 25 }, () => ({ url: "/content/a.pdf" }));
    assert.equal(normalizeAttachments(muchos).length, 10);
  });
});

describe("areaManager — el jefe no se aprueba a sí mismo", () => {
  it("una pendiente sin aprobador la resuelve un administrador", () => {
    assert.equal(
      requiresAdminApproval({ status: EXPENSE_STATUS.PENDING, manager_user_id: null }),
      true,
    );
  });

  it("una pendiente con jefe asignado sigue el camino normal", () => {
    assert.equal(
      requiresAdminApproval({ status: EXPENSE_STATUS.PENDING, manager_user_id: 100200 }),
      false,
    );
  });

  it("fuera de 'pending' no aplica", () => {
    assert.equal(
      requiresAdminApproval({
        status: EXPENSE_STATUS.APPROVED_MANAGER,
        manager_user_id: null,
      }),
      false,
    );
  });
});

describe("country — moneda por instancia", () => {
  it("Chile formatea pesos sin decimales", () => {
    const { getCountryConfig, formatMoney } = require("../src/config/country");
    assert.equal(getCountryConfig("CL").currency.code, "CLP");
    assert.equal(getCountryConfig("CL").currency.decimals, 0);
    assert.match(formatMoney(45000, "CL"), /45\.000/);
  });

  it("Perú formatea soles con dos decimales", () => {
    const { getCountryConfig, formatMoney } = require("../src/config/country");
    assert.equal(getCountryConfig("PE").currency.code, "PEN");
    assert.equal(getCountryConfig("PE").currency.decimals, 2);
    assert.match(formatMoney(1234.5, "PE"), /1,234\.50/);
  });

  it("un monto no numérico no rompe la vista", () => {
    const { formatMoney } = require("../src/config/country");
    assert.equal(formatMoney(null, "CL"), "—");
    assert.equal(formatMoney("abc", "CL"), "—");
  });
});
