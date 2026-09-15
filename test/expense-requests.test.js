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
  normalizeAttachments,
  normalizeDraftItems,
  bindItemAttachments,
  ownUploadPath,
  parseUploadPath,
  slugExpenseDetail,
  finalAttachmentName,
  finalAttachmentNumber,
  acceptsAttachment,
  isoDate,
} = require("../src/services/expenses/expenseRequestService");
const {
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_CATEGORY_GROUPS,
  isSelectableCategory,
  categoryRequiresFuel,
  computeFuelLiters,
  computeFuelAmount,
  expenseCategoryLabel,
  formatFuelDetails,
} = require("../src/constants/expenseCategories");
const {
  addBusinessDays,
  reportDueOn,
  isReportOverdue,
  clockOrigin,
} = require("../src/services/expenses/expenseReportDeadline");
const {
  MAX_OPEN_FUNDS,
  fundState,
  countsTowardLimit,
  fundBalance,
  parseFundChoice,
  summarizeFunds,
} = require("../src/services/expenses/expenseFundService");
const {
  cuentaRutNumber,
  parseAccountNumber,
  normalizeBankAccount,
  normalizeDraftBankAccount,
} = require("../src/services/expenses/bankAccountService");
const {
  BANKS_BY_COUNTRY,
  BANK_ENTITY_TYPE,
  RETIRED_BANK_CODES,
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
    assert.equal(banks.find((b) => b.code === "028").name, "Banco BICE");
    assert.equal(banks.find((b) => b.code === "875").entityType, BANK_ENTITY_TYPE.EMISOR_NO_BANCARIO);
    assert.equal(banks.find((b) => b.code === "875").name, "Mercado Pago");
    const entityTypes = Object.values(BANK_ENTITY_TYPE);
    for (const bank of banks) assert.ok(entityTypes.includes(bank.entityType), bank.code);
    for (const code of RETIRED_BANK_CODES) {
      assert.equal(codes.includes(code), false, `${code} salió del catálogo`);
    }
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

describe("expenseRequestService — período de gastos", () => {
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

  it("en una solicitud de fondos el viaje es obligatorio y no se deduce del desglose", () => {
    const items = [{ itemDate: "2026-09-01" }, { itemDate: "2026-09-05" }];
    const sin = normalizePeriod("", "", items, { required: true, deriveFromItems: false });
    assert.equal(sin.ok, false);
    assert.match(sin.error, /período del viaje/);

    const ok = normalizePeriod("2026-09-10", "2026-09-14", items, {
      required: true,
      deriveFromItems: false,
    });
    assert.deepEqual(ok, { ok: true, start: "2026-09-10", end: "2026-09-14" });
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
    // Sin monto queda NULL, no 0: al retomarlo el campo debe verse vacío.
    assert.deepEqual(r.items[0], {
      detail: "Disco SSD",
      amount: null,
      category: null,
      days: null,
      details: null,
      itemDate: null,
      clientKey: null,
    });
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

  it("un 0 escrito en un borrador se conserva como 0", () => {
    const r = normalizeDraftItems([{ detail: "Regalo", amount: "0" }]);
    assert.equal(r.items[0].amount, 0);
  });

  it("sólo reconoce como propios los comprobantes de la carpeta del usuario", () => {
    assert.equal(ownUploadPath(123, "gastos/2026/123/boleta.pdf"), "gastos/2026/123/boleta.pdf");
    assert.equal(ownUploadPath(123, "/content/gastos/2026/123/boleta.pdf"), "gastos/2026/123/boleta.pdf");
    assert.equal(ownUploadPath("123", "gastos/2026/123/boleta.pdf"), "gastos/2026/123/boleta.pdf");
    // Ajenos, fuera de gastos/ o con trucos de ruta: nunca.
    assert.equal(ownUploadPath(123, "gastos/2026/456/boleta.pdf"), null);
    assert.equal(ownUploadPath(123, "gastos/2026/1234/boleta.pdf"), null);
    assert.equal(ownUploadPath(123, "noticias/2026/123/foto.jpg"), null);
    assert.equal(ownUploadPath(123, "gastos/2026/123/../456/boleta.pdf"), null);
    assert.equal(ownUploadPath(123, "gastos/2026/123/sub/boleta.pdf"), null);
    assert.equal(ownUploadPath(null, "gastos/2026/123/boleta.pdf"), null);
    assert.equal(ownUploadPath(123, ""), null);
  });

  it("isoDate no corre las fechas por zona horaria", () => {
    assert.equal(isoDate(new Date(2026, 8, 1)), "2026-09-01");
    assert.equal(isoDate("2026-09-01"), "2026-09-01");
    assert.equal(isoDate(null), "");
  });
});

describe("comprobantes — nombre definitivo", () => {
  it("el slug del detalle es sólo ascii letras y números, sin tildes ni símbolos", () => {
    assert.equal(slugExpenseDetail("Hotel Antofagastá!!!"), "hotelantofagasta");
    assert.equal(slugExpenseDetail("Peaje Ruta 5 — km 12"), "peajeruta5km12");
    assert.equal(slugExpenseDetail("  "), "");
    assert.equal(slugExpenseDetail("***"), "");
    assert.equal(slugExpenseDetail("A".repeat(50)).length, 40);
  });

  it("nombra fondos con el id y n; rendición agrega el slug", () => {
    assert.equal(finalAttachmentName(76587612, 1, "boleta-1789398610958-ab12cd34.PDF"), "76587612_1.pdf");
    assert.equal(finalAttachmentName(76587612, 3, "sin-extension"), "76587612_3");
    assert.equal(
      finalAttachmentName(76587612, 1, "foto.JPG", "Hotel Antofagastá!!!"),
      "76587612_1_hotelantofagasta.jpg",
    );
    assert.equal(finalAttachmentName(76587612, 1, "foto.jpg", "   ***   "), "76587612_1.jpg");
    assert.equal(
      finalAttachmentName(76587612, 2, "a.jpeg", "A".repeat(50)).length,
      "76587612_2_".length + 40 + ".jpeg".length,
    );
  });

  it("reconoce el nombre definitivo sólo para su propia solicitud", () => {
    assert.equal(finalAttachmentNumber(76587612, "76587612_2.pdf"), 2);
    assert.equal(finalAttachmentNumber(76587612, "76587612_1_hotelantofagasta.jpg"), 1);
    assert.equal(finalAttachmentNumber(76587612, "11111111_2.pdf"), null);
    assert.equal(finalAttachmentNumber(76587612, "boleta-1789398610958-ab12cd34.pdf"), null);
    assert.equal(finalAttachmentNumber(76587612, "76587612_1_hotel-antofagasta.jpg"), null);
  });

  it("no acepta el comprobante ya renombrado de otra solicitud", () => {
    const temporal = { url: "/content/gastos/2026/5/boleta-1789398610958-ab12cd34.pdf", publicId: "gastos/2026/5/boleta-1789398610958-ab12cd34.pdf" };
    const propio = { url: "", publicId: "gastos/2026/5/76587612_1.pdf" };
    const propioSlug = { url: "", publicId: "gastos/2026/5/76587612_1_hotelantofagasta.jpg" };
    const deOtra = { url: "", publicId: "gastos/2026/5/11111111_1.pdf" };
    assert.equal(acceptsAttachment(5, null, temporal), true);
    assert.equal(acceptsAttachment(5, 76587612, propio), true);
    assert.equal(acceptsAttachment(5, 76587612, propioSlug), true);
    assert.equal(acceptsAttachment(5, null, propio), false);
    assert.equal(acceptsAttachment(5, 76587612, deOtra), false);
    assert.equal(acceptsAttachment(6, null, temporal), false);
  });

  it("parseUploadPath extrae dueño y nombre, también desde la URL codificada", () => {
    assert.deepEqual(parseUploadPath("/content/gastos/2026/5/76587612_1.pdf"), {
      path: "gastos/2026/5/76587612_1.pdf",
      userId: 5,
      fileName: "76587612_1.pdf",
    });
    assert.equal(parseUploadPath("/content/gastos/2026/5/a%20b.pdf").fileName, "a b.pdf");
    assert.equal(parseUploadPath("noticias/2026/5/x.pdf"), null);
    assert.equal(parseUploadPath("/content/gastos/2026/5/%E0%A4%A.pdf"), null);
  });
});

describe("fondos asignados", () => {
  it("el saldo indica quién paga a quién", () => {
    assert.deepEqual(fundBalance(80000, 100000), { saldo: -20000, monto: 20000, sentido: "devolver" });
    assert.deepEqual(fundBalance(130000, 100000), { saldo: 30000, monto: 30000, sentido: "pagar" });
    assert.deepEqual(fundBalance("50000.00", "50000.00"), { saldo: 0, monto: 0, sentido: "cerrado" });
    // Reembolso sin fondo: la empresa paga todo lo gastado.
    assert.deepEqual(fundBalance(15990, null), { saldo: 15990, monto: 15990, sentido: "pagar" });
  });

  it("el estado del fondo sale de su solicitud y de su rendición activa", () => {
    assert.equal(fundState("pending", null), "en_aprobacion");
    assert.equal(fundState("approved_manager", null), "en_aprobacion");
    assert.equal(fundState("approved_finance", null), "por_rendir");
    assert.equal(fundState("approved_finance", "pending"), "en_revision");
    assert.equal(fundState("approved_finance", "approved_manager"), "en_revision");
    assert.equal(fundState("approved_finance", "approved_finance"), "rendido");
    assert.equal(fundState("rejected", null), null);
    assert.equal(fundState("cancelled", null), null);
    assert.equal(fundState("draft", null), null);
  });

  it("ocupan cupo los fondos no cerrados; los borradores no", () => {
    assert.equal(MAX_OPEN_FUNDS, 3);
    assert.equal(countsTowardLimit("pending", null), true);
    assert.equal(countsTowardLimit("approved_finance", null), true);
    assert.equal(countsTowardLimit("approved_finance", "pending"), true);
    assert.equal(countsTowardLimit("approved_finance", "approved_finance"), false);
    assert.equal(countsTowardLimit("rejected", null), false);
    assert.equal(countsTowardLimit("cancelled", null), false);
    assert.equal(countsTowardLimit("draft", null), false);
  });

  it("interpreta la elección de fondo del formulario", () => {
    assert.deepEqual(parseFundChoice(""), { type: "none" });
    assert.deepEqual(parseFundChoice(null), { type: "none" });
    assert.deepEqual(parseFundChoice("reembolso"), { type: "reembolso" });
    assert.deepEqual(parseFundChoice("12345678"), { type: "fondo", id: 12345678 });
    assert.deepEqual(parseFundChoice("12345678; DROP"), { type: "invalid" });
  });

  it("resume los fondos para la card de Mis solicitudes", () => {
    const r = summarizeFunds(
      [
        { id: 11111111, title: "A", total_amount: "50000.00", status: "approved_finance", rendicion_status: null },
        { id: 22222222, title: "B", total_amount: "50000.00", status: "approved_finance", rendicion_status: "pending" },
        { id: 33333333, title: "C", total_amount: "20000.00", status: "pending", rendicion_status: null },
        { id: 44444444, title: "D", total_amount: "90000.00", status: "approved_finance", rendicion_status: "approved_finance" },
        { id: 55555555, title: "E", total_amount: "10000.00", status: "rejected", rendicion_status: null },
      ],
      [{ id: 66666666, title: "R", total_amount: "80000.00", assigned_amount: "100000.00" }],
    );
    assert.equal(r.usados, 3);
    assert.equal(r.lleno, true);
    // Sólo suma lo que está por rendir: el fondo con rendición en revisión ya está en camino.
    assert.equal(r.asignadoPorRendir, 50000);
    assert.deepEqual(r.porRendir.map((f) => f.id), [11111111]);
    assert.deepEqual(r.abiertos.map((f) => f.state), ["por_rendir", "en_revision", "en_aprobacion"]);
    assert.equal(r.vencidos, 0);
    assert.equal(r.abiertos[0].overdue, false);
    assert.equal(r.porLiquidar[0].balance.sentido, "devolver");
    assert.equal(r.porLiquidar[0].balance.monto, 20000);
  });

  it("los nombres de comprobantes de 6 dígitos ya no son definitivos", () => {
    assert.equal(finalAttachmentNumber(654321, "654321_2.pdf"), null);
  });
});

describe("expenseCategories — compras fuera de viaje", () => {
  it("admite hardware y suscripciones sin pedir días", () => {
    for (const category of ["hardware", "software"]) {
      const r = normalizeItems([{ detail: "Compra", category, amount: "15990" }]);
      assert.equal(r.ok, true, category);
      assert.equal(r.items[0].days, null, category);
      assert.equal(r.items[0].details, null, category);
    }
  });

  it("renombra las categorías existentes y agrega las nuevas al selector", () => {
    assert.equal(expenseCategoryLabel("comidas"), "Alimentación");
    assert.equal(expenseCategoryLabel("combustible"), "Combustible");
    assert.equal(expenseCategoryLabel("transfer"), "Traslado");
    assert.equal(expenseCategoryLabel("arriendo_auto"), "Arriendo de vehículo");
    assert.equal(expenseCategoryLabel("telefono"), "Telefonía");
    assert.equal(expenseCategoryLabel("pasajes"), "Pasajes");
    assert.equal(isSelectableCategory("pasajes"), false);
    assert.equal(isSelectableCategory("pasajes_aereos"), true);
    assert.equal(isSelectableCategory("estacionamiento"), true);
    assert.equal(isSelectableCategory("taxi_apps"), true);
    assert.equal(isSelectableCategory("materiales"), true);
    assert.equal(isSelectableCategory("envios"), true);
    const codes = EXPENSE_CATEGORY_GROUPS.flatMap((g) => g.codes);
    assert.equal(codes.includes("pasajes"), false);
    assert.equal(new Set(codes).size, codes.length);
    assert.ok(Object.keys(EXPENSE_CATEGORY_LABELS).includes("pasajes"));
  });

  it("acepta las categorías nuevas en el desglose", () => {
    for (const category of [
      "pasajes_aereos",
      "pasajes_terrestres",
      "estacionamiento",
      "taxi_apps",
      "materiales",
      "envios",
    ]) {
      const r = normalizeItems([{ detail: "Gasto", category, amount: "1000" }]);
      assert.equal(r.ok, true, category);
      assert.equal(r.items[0].details, null, category);
    }
    const legacy = normalizeItems([{ detail: "Bus", category: "pasajes", amount: "5000" }]);
    assert.equal(legacy.ok, true);
  });
});

describe("expenseCategories — combustible", () => {
  const combustible = {
    detail: "Copec Ruta 5",
    category: "combustible",
    yield_km_l: "12,5",
    distance_km: "530",
    price_per_liter: "1.349",
    amount: "57.198",
  };

  it("calcula litros y monto sugerido", () => {
    assert.equal(computeFuelLiters(12.5, 530), 42.4);
    assert.equal(computeFuelAmount(42.4, 1349), 57197.6);
    assert.equal(categoryRequiresFuel("combustible"), true);
    assert.equal(categoryRequiresFuel("peajes"), false);
  });

  it("al usuario sólo le muestra rendimiento, distancia y precio", () => {
    const texto = formatFuelDetails(
      {
        yield_km_l: 12.5,
        distance_km: 530,
        price_per_liter: 1349,
        liters: 42.4,
      },
      (n) => String(n),
    );
    assert.equal(texto, "12,5 km/L · 530 km · 1349/L");
    assert.equal(texto.includes("42"), false);
  });

  it("exige rendimiento, distancia y precio por litro al enviar", () => {
    assert.equal(normalizeItems([{ ...combustible, yield_km_l: "" }]).ok, false);
    assert.equal(normalizeItems([{ detail: "Copec", category: "combustible", amount: "10000" }]).ok, false);
    const r = normalizeItems([combustible]);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].details.yield_km_l, 12.5);
    assert.equal(r.items[0].details.distance_km, 530);
    assert.equal(r.items[0].details.price_per_liter, 1349);
    assert.equal(r.items[0].details.liters, 42.4);
    assert.equal(r.items[0].amount, 57198);
    const sinMonto = { ...combustible };
    delete sinMonto.amount;
    assert.equal(normalizeItems([sinMonto]).items[0].amount, 57198);
  });

  it("acepta el extra anidado en details e ignora el monto que mande el cliente", () => {
    const r = normalizeItems([
      {
        detail: "Copec",
        category: "combustible",
        amount: "58000",
        details: { yield_km_l: 10, distance_km: 100, price_per_liter: 1200 },
      },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].details.liters, 10);
    assert.equal(r.items[0].amount, 12000);
  });

  it("descarta el extra de combustible en cualquier otra categoría", () => {
    const r = normalizeItems([
      {
        detail: "Almuerzo",
        category: "comidas",
        amount: "12000",
        yield_km_l: "12",
        distance_km: "100",
        price_per_liter: "1300",
      },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].details, null);
  });

  it("en un borrador guarda el combustible a medias y no conserva un monto a mano", () => {
    const r = normalizeDraftItems([
      { detail: "Copec", category: "combustible", yield_km_l: "12,5", amount: "50000" },
    ]);
    assert.equal(r.items[0].details.yield_km_l, 12.5);
    assert.equal(r.items[0].details.distance_km, null);
    assert.equal(r.items[0].amount, null);
  });
});

describe("plazo de rendición — 1+5 días hábiles", () => {
  it("salta fines de semana al contar días hábiles", () => {
    assert.equal(addBusinessDays("2026-09-11", 1), "2026-09-14");
    assert.equal(addBusinessDays("2026-09-09", 1), "2026-09-10");
  });

  it("el plazo parte al día hábil siguiente al fin del viaje y suma 5 hábiles", () => {
    // Miércoles 9: gracia jueves 10; 5 hábiles → jueves 17.
    assert.equal(reportDueOn("2026-09-09"), "2026-09-17");
    // Viernes 11: gracia lunes 14; 5 hábiles → lunes 21.
    assert.equal(reportDueOn("2026-09-11"), "2026-09-21");
  });

  it("si Finanzas aprueba después del viaje, el 1+5 parte de esa aprobación", () => {
    assert.equal(clockOrigin("2026-09-09", "2026-09-12"), "2026-09-12");
    assert.equal(reportDueOn("2026-09-09", "2026-09-12"), "2026-09-21");
    assert.equal(clockOrigin("2026-09-09", "2026-09-01"), "2026-09-09");
  });

  it("está vencido sólo después del último día hábil, y sin período no hay plazo", () => {
    assert.equal(isReportOverdue("2026-09-09", null, "2026-09-17"), false);
    assert.equal(isReportOverdue("2026-09-09", null, "2026-09-18"), true);
    assert.equal(isReportOverdue(null, null, "2026-09-18"), false);
  });

  it("destaca en el resumen del colaborador sólo los fondos por rendir vencidos", () => {
    const r = summarizeFunds(
      [
        {
          id: 11111111,
          title: "Viaje",
          total_amount: "50000.00",
          status: "approved_finance",
          rendicion_status: null,
          period_end: "2026-09-09",
          finance_reviewed_at: "2026-09-01",
        },
        {
          id: 22222222,
          title: "En plazo",
          total_amount: "10000.00",
          status: "approved_finance",
          rendicion_status: null,
          period_end: "2026-09-25",
          finance_reviewed_at: "2026-09-01",
        },
      ],
      [],
      "2026-09-20",
    );
    assert.equal(r.vencidos, 1);
    assert.equal(r.porRendir[0].overdue, true);
    assert.equal(r.porRendir[0].reportDueOn, "2026-09-17");
    assert.equal(r.porRendir[1].overdue, false);
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

  it("conserva la clave que liga el comprobante a su línea", () => {
    const r = normalizeAttachments([
      {
        name: "boleta.pdf",
        url: "/content/gastos/2026/1/b.pdf",
        public_id: "gastos/2026/1/b.pdf",
        item_key: "k1",
      },
    ]);
    assert.equal(r[0].itemKey, "k1");
  });

  it("acota el número de comprobantes", () => {
    const muchos = Array.from({ length: 80 }, () => ({ url: "/content/a.pdf" }));
    assert.equal(normalizeAttachments(muchos).length, 50);
  });
});

describe("expenseRequestService — comprobantes por ítem", () => {
  const items = [
    { detail: "Hotel", clientKey: "k1" },
    { detail: "Taxi", clientKey: "k2" },
  ];
  const files = [
    { url: "/content/a", itemKey: "k1" },
    { url: "/content/b", itemKey: "k2" },
  ];

  it("en una rendición cada línea necesita su comprobante", () => {
    assert.equal(bindItemAttachments(items, files, { required: true }).ok, true);
    const falta = bindItemAttachments(items, [files[0]], { required: true });
    assert.equal(falta.ok, false);
    assert.match(falta.error, /Taxi/);
  });

  it("descarta comprobantes de una línea que ya no está en el desglose", () => {
    const r = bindItemAttachments([items[0]], files);
    assert.equal(r.ok, true);
    assert.equal(r.attachments.length, 1);
    assert.equal(r.attachments[0].itemKey, "k1");
  });

  it("conserva la clave del ítem al normalizar el desglose", () => {
    const r = normalizeItems([
      { key: "k9", detail: "Hotel", category: "hospedaje", days: "2", amount: "40000" },
    ]);
    assert.equal(r.ok, true);
    assert.equal(r.items[0].clientKey, "k9");
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
