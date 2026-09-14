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
  normalizePeriod,
  parseAssignedAmount,
  normalizeAttachments,
  normalizeDraftItems,
  isoDate,
} = require("../src/services/expenses/expenseRequestService");
const {
  ALL_EXPENSE_FUND_TYPES,
  isExpenseFundType,
  expenseFundTypeLabel,
} = require("../src/constants/expenseFundTypes");
const {
  cuentaRutNumber,
  parseAccountNumber,
  normalizeBankAccount,
  normalizeDraftBankAccount,
} = require("../src/services/expenses/bankAccountService");
const {
  BANKS_BY_COUNTRY,
  BANCO_ESTADO_CODE,
  banksForCountry,
  isAccountTypeAllowedForBank,
} = require("../src/constants/banks");

describe("expenseStatuses — estados y etiquetas", () => {
  it("declara el flujo de dos etapas", () => {
    assert.deepEqual(ALL_EXPENSE_STATUSES, [
      "draft",
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
      { detail: "Peaje", category: "peajes", amount: "12.500", item_date: "2026-09-01" },
      { detail: "Hotel", category: "hospedaje", days: "2", amount: "70000", item_date: "2026-09-02" },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.total, 82500);
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0].itemDate, "2026-09-01");
  });

  it("ignora la última fila vacía del formulario", () => {
    const r = normalizeItems([
      { detail: "Peaje", category: "peajes", amount: "1000" },
      { detail: "", amount: "", category: "" },
      { detail: "  ", amount: null },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 1);
    assert.equal(r.total, 1000);
  });

  it("exige detalle y monto en toda fila iniciada", () => {
    assert.equal(normalizeItems([{ detail: "", category: "peajes", amount: "500" }]).ok, false);
    assert.equal(normalizeItems([{ detail: "Peaje", category: "peajes", amount: "abc" }]).ok, false);
  });

  it("rechaza un desglose vacío o sin monto", () => {
    assert.equal(normalizeItems([]).ok, false);
    assert.equal(normalizeItems(null).ok, false);
    assert.equal(normalizeItems([{ detail: "Nada", category: "otros", amount: "0" }]).ok, false);
  });

  it("descarta una fecha que no sea ISO", () => {
    const r = normalizeItems([
      { detail: "Peaje", category: "peajes", amount: "100", item_date: "01/09/2026" },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].itemDate, null);
  });

  it("acota el número de líneas", () => {
    const muchas = Array.from({ length: 80 }, (_, i) => ({
      detail: "Línea " + i,
      category: "otros",
      amount: "1",
    }));
    const r = normalizeItems(muchas);
    assert.equal(r.ok, true);
    assert.equal(r.items.length, 50);
  });
});

describe("expenseRequestService — categoría y días", () => {
  it("exige una categoría conocida en cada línea", () => {
    const sin = normalizeItems([{ detail: "Alargador 3M", amount: "8990" }]);
    assert.equal(sin.ok, false);
    assert.match(sin.error, /categoría/);
    assert.equal(
      normalizeItems([{ detail: "Alargador 3M", category: "marciano", amount: "8990" }]).ok,
      false,
    );
    const ok = normalizeItems([{ detail: "Alargador 3M", category: "otros", amount: "8990" }]);
    assert.equal(ok.ok, true);
    assert.equal(ok.items[0].category, "otros");
    assert.equal(ok.items[0].days, null);
  });

  it("una fila con sólo la categoría elegida no es una fila vacía", () => {
    assert.equal(normalizeItems([{ detail: "", amount: "", category: "comidas" }]).ok, false);
  });

  it("el hospedaje exige días entre 1 y 365", () => {
    const base = { detail: "Hotel Antofagasta", category: "hospedaje", amount: "90000" };
    assert.equal(normalizeItems([base]).ok, false);
    assert.equal(normalizeItems([{ ...base, days: "0" }]).ok, false);
    assert.equal(normalizeItems([{ ...base, days: "366" }]).ok, false);
    assert.equal(normalizeItems([{ ...base, days: "2,5" }]).ok, false);
    const r = normalizeItems([{ ...base, days: 3 }]);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].days, 3);
  });

  it("descarta los días en cualquier categoría que no sea hospedaje", () => {
    const r = normalizeItems([{ detail: "Almuerzo", category: "comidas", days: "4", amount: "12000" }]);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].days, null);
  });
});

describe("bankAccountService — cuenta de destino", () => {
  const banks = BANKS_BY_COUNTRY.CL;
  const nationalId = "12345678-5";

  it("el catálogo usa el código SBIF como clave, sin repetidos", () => {
    const codes = banks.map((b) => b.code);
    assert.equal(new Set(codes).size, codes.length);
    for (const code of codes) assert.match(code, /^\d{3}$/);
    assert.equal(banks.find((b) => b.code === BANCO_ESTADO_CODE).name, "Banco Estado");
    assert.deepEqual(banksForCountry("PE"), []);
  });

  it("la CuentaRUT es el RUT sin puntos ni dígito verificador", () => {
    assert.equal(cuentaRutNumber("12345678-5"), "12345678");
    assert.equal(cuentaRutNumber("12.345.678-5"), "12345678");
    assert.equal(cuentaRutNumber(null), null);
    assert.equal(cuentaRutNumber("12345678-9"), null);
  });

  it("en CuentaRUT ignora el número que manda el cliente", () => {
    const r = normalizeBankAccount(
      { bank_code: "012", account_type: "rut", account_number: "999999" },
      { banks, nationalId },
    );
    assert.equal(r.ok, true);
    assert.equal(r.account.accountNumber, "12345678");
    assert.equal(r.account.bankName, "Banco Estado");
  });

  it("la CuentaRUT sólo existe en Banco Estado", () => {
    const r = normalizeBankAccount(
      { bank_code: "001", account_type: "rut", account_number: "12345678" },
      { banks, nationalId },
    );
    assert.equal(r.ok, false);
    assert.equal(isAccountTypeAllowedForBank("rut", "012"), true);
    assert.equal(isAccountTypeAllowedForBank("vista", "012"), true);
    assert.equal(isAccountTypeAllowedForBank("corriente", "037"), true);
  });

  it("limpia guiones y espacios del número y exige sólo dígitos", () => {
    const r = normalizeBankAccount(
      { bank_code: "001", account_type: "corriente", account_number: " 00-123-45678-09 " },
      { banks, nationalId },
    );
    assert.equal(r.ok, true);
    assert.equal(r.account.accountNumber, "001234567809");
    assert.equal(parseAccountNumber("12a45"), null);
    assert.equal(parseAccountNumber("123"), null);
    assert.equal(parseAccountNumber(""), null);
  });

  it("rechaza bancos fuera del catálogo y tipos desconocidos", () => {
    assert.equal(
      normalizeBankAccount({ bank_code: "999", account_type: "vista", account_number: "1234" }, { banks, nationalId }).ok,
      false,
    );
    assert.equal(
      normalizeBankAccount({ bank_code: "001", account_type: "bitcoin", account_number: "1234" }, { banks, nationalId }).ok,
      false,
    );
    assert.equal(normalizeBankAccount(null, { banks, nationalId }).ok, false);
  });
});

describe("expenseRequestService — encabezado del fondo", () => {
  it("reconoce los dos tipos de fondo de la planilla", () => {
    assert.deepEqual(ALL_EXPENSE_FUND_TYPES, ["fijo", "rendir"]);
    assert.equal(expenseFundTypeLabel("fijo"), "Fondo fijo");
    assert.equal(expenseFundTypeLabel("rendir"), "Fondo a rendir");
    assert.equal(isExpenseFundType("caja"), false);
    assert.equal(expenseFundTypeLabel(null), "—");
  });

  const items = [
    { itemDate: "2026-09-03" },
    { itemDate: null },
    { itemDate: "2026-09-01" },
  ];

  it("respeta el período que indica el usuario", () => {
    const r = normalizePeriod("2026-08-30", "2026-09-05", items);
    assert.deepEqual(r, { ok: true, start: "2026-08-30", end: "2026-09-05" });
  });

  it("sin período lo deduce de las fechas del desglose", () => {
    assert.deepEqual(normalizePeriod("", "", items), {
      ok: true,
      start: "2026-09-01",
      end: "2026-09-03",
    });
  });

  it("con un solo extremo y sin fechas usa el mismo día", () => {
    assert.deepEqual(normalizePeriod("2026-09-10", "", []), {
      ok: true,
      start: "2026-09-10",
      end: "2026-09-10",
    });
  });

  it("sin fechas en ningún lado el período queda vacío (compras, suscripciones)", () => {
    const vacio = { ok: true, start: null, end: null };
    assert.deepEqual(normalizePeriod("", "", [{ itemDate: null }]), vacio);
    assert.deepEqual(normalizePeriod("10/09/2026", "", []), vacio);
  });

  it("rechaza un período invertido", () => {
    assert.equal(normalizePeriod("2026-09-10", "2026-09-01", []).ok, false);
  });

  it("el fondo asignado es opcional y sólo aplica a rendiciones", () => {
    assert.deepEqual(parseAssignedAmount("rendicion", ""), { ok: true, value: null });
    assert.deepEqual(parseAssignedAmount("rendicion", null), { ok: true, value: null });
    assert.deepEqual(parseAssignedAmount("rendicion", "100.000"), { ok: true, value: 100000 });
    assert.deepEqual(parseAssignedAmount("rendicion", "0"), { ok: true, value: 0 });
    assert.equal(parseAssignedAmount("rendicion", "abc").ok, false);
    assert.equal(parseAssignedAmount("rendicion", "-5").ok, false);
    assert.deepEqual(parseAssignedAmount("fondos", "50000"), { ok: true, value: null });
  });
});

describe("borradores", () => {
  it("el borrador es un estado propio, con etiqueta y badge", () => {
    assert.equal(EXPENSE_STATUS.DRAFT, "draft");
    assert.equal(expenseStatusLabel("draft"), "Borrador");
    assert.match(expenseStatusBadge("draft"), /gasto-badge--draft/);
  });

  it("conserva las líneas a medias y descarta las vacías", () => {
    const r = normalizeDraftItems([
      { detail: "Disco SSD", amount: "", category: "" },
      { detail: "", amount: "12.000", category: "marciano" },
      { detail: "", amount: "", category: "", item_date: "2026-09-10" },
      { detail: "  ", amount: "", category: "" },
    ]);
    assert.equal(r.items.length, 3);
    assert.deepEqual(r.items[0], { detail: "Disco SSD", amount: 0, category: null, days: null, itemDate: null });
    assert.equal(r.items[1].amount, 12000);
    assert.equal(r.items[1].category, null);
    assert.equal(r.items[2].itemDate, "2026-09-10");
    assert.equal(r.total, 12000);
  });

  it("guarda los días sólo si la línea es de hospedaje y son válidos", () => {
    const r = normalizeDraftItems([
      { detail: "Hotel", category: "hospedaje", days: "2" },
      { detail: "Hotel", category: "hospedaje", days: "0" },
      { detail: "Almuerzo", category: "comidas", days: "3" },
    ]);
    assert.deepEqual(r.items.map((i) => i.days), [2, null, null]);
    assert.deepEqual(normalizeDraftItems(null), { items: [], total: 0 });
  });

  it("de la cuenta de un borrador conserva lo que sirva", () => {
    const opts = { banks: BANKS_BY_COUNTRY.CL, nationalId: "12345678-5" };
    const completa = normalizeDraftBankAccount(
      { bank_code: "012", account_type: "rut", account_number: "" },
      opts,
    );
    assert.equal(completa.accountNumber, "12345678");

    const aMedias = normalizeDraftBankAccount({ bank_code: "001", account_type: "", account_number: "" }, opts);
    assert.deepEqual(aMedias, { bankCode: "001", bankName: "Banco de Chile", accountType: null, accountNumber: null });

    assert.equal(normalizeDraftBankAccount({ bank_code: "999", account_number: "" }, opts), null);
    assert.equal(normalizeDraftBankAccount(null, opts), null);
  });

  it("isoDate no corre las fechas por zona horaria", () => {
    assert.equal(isoDate(new Date(2026, 8, 1)), "2026-09-01");
    assert.equal(isoDate("2026-09-01"), "2026-09-01");
    assert.equal(isoDate(null), "");
  });
});

describe("expenseCategories — compras fuera de viaje", () => {
  it("admite hardware y suscripciones sin pedir días", () => {
    for (const category of ["hardware", "software"]) {
      const r = normalizeItems([{ detail: "Compra", category, amount: "15990" }]);
      assert.equal(r.ok, true, category);
      assert.equal(r.items[0].days, null, category);
    }
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
