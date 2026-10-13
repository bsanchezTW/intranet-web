const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "PE";

const { integerToWords, amountToWords } = require("../src/utils/amountInWords");
const {
  BILL_DRAWER,
  formatBillNumber,
  formatBillAmount,
  formatBillMoney,
  billDisplayStatus,
} = require("../src/constants/billOfExchange");
const {
  normalizeBatchInput,
  planInstallments,
  parseCents,
  normalizeDoc,
  toPrintable,
} = require("../src/services/billsOfExchange/billOfExchangeService");
const { renderBillsPdf, FORM_WIDTH, FORM_HEIGHT } = require("../src/services/billsOfExchange/billOfExchangePdf");
const { isFeatureEnabled } = require("../src/config/features");

describe("amountInWords — monto en letras", () => {
  it("escribe el importe de la letra de referencia", () => {
    assert.equal(
      amountToWords(6942.4, "DÓLARES AMERICANOS"),
      "SEIS MIL NOVECIENTOS CUARENTA Y DOS CON 40/100 DÓLARES AMERICANOS",
    );
    assert.equal(
      amountToWords(41536, "DÓLARES AMERICANOS"),
      "CUARENTA Y UN MIL QUINIENTOS TREINTA Y SEIS CON 00/100 DÓLARES AMERICANOS",
    );
  });

  it("resuelve los casos especiales del castellano", () => {
    assert.equal(integerToWords(0), "CERO");
    assert.equal(integerToWords(1), "UNO");
    assert.equal(integerToWords(15), "QUINCE");
    assert.equal(integerToWords(21), "VEINTIUNO");
    assert.equal(integerToWords(100), "CIEN");
    assert.equal(integerToWords(101), "CIENTO UNO");
    assert.equal(integerToWords(1000), "MIL");
    assert.equal(integerToWords(1001), "MIL UNO");
    assert.equal(integerToWords(21000), "VEINTIÚN MIL");
    assert.equal(integerToWords(100000), "CIEN MIL");
    assert.equal(integerToWords(1000000), "UN MILLÓN");
    assert.equal(integerToWords(2500000), "DOS MILLONES QUINIENTOS MIL");
    assert.equal(integerToWords(21000000), "VEINTIÚN MILLONES");
    assert.equal(integerToWords(999999), "NOVECIENTOS NOVENTA Y NUEVE MIL NOVECIENTOS NOVENTA Y NUEVE");
  });

  it("redondea los céntimos y los muestra siempre", () => {
    assert.equal(amountToWords(0.5, "SOLES"), "CERO CON 50/100 SOLES");
    assert.equal(amountToWords(10.005, "SOLES"), "DIEZ CON 01/100 SOLES");
    assert.equal(amountToWords(1, "SOLES"), "UNO CON 00/100 SOLES");
  });

  it("rechaza montos negativos", () => {
    assert.throws(() => amountToWords(-1));
  });
});

describe("constants/billOfExchange — formatos", () => {
  it("numera como el talonario", () => {
    assert.equal(formatBillNumber(2026, 421), "LT-00421-2026");
  });

  it("formatea montos al estilo peruano", () => {
    assert.equal(formatBillAmount("6942.4"), "6,942.40");
    assert.equal(formatBillAmount(1234567.891), "1,234,567.89");
    assert.equal(formatBillMoney("27769.60"), "US$ 27,769.60");
    assert.equal(formatBillMoney(10), "US$ 10.00");
  });

  it("deriva 'vencida' de una vigente con fecha pasada", () => {
    assert.equal(billDisplayStatus("issued", "2026-05-01", "2026-05-02").key, "vencida");
    assert.equal(billDisplayStatus("issued", "2026-05-02", "2026-05-02").key, "vigente");
    assert.equal(billDisplayStatus("paid", "2026-01-01", "2026-05-02").key, "pagada");
    assert.equal(billDisplayStatus("voided", "2026-01-01", "2026-05-02").key, "anulada");
  });
});

describe("billOfExchangeService — validación y cronograma", () => {
  const base = {
    acceptor_doc: "20606218762",
    acceptor_name: "LFT REP S.A.C.",
    acceptor_address: "Jr. Cerro Negro 434 Santiago de Surco",
    invoice_ref: "F001-00004989",
    issue_date: "2026-04-15",
    currency_code: "USD",
    total_amount: "27769.60",
    installments_count: "4",
    interval_days: "30",
  };

  it("reproduce el cronograma de la referencia (4 letras cada 30 días)", () => {
    const { ok, values } = normalizeBatchInput(base);
    assert.equal(ok, true);
    assert.deepEqual(values.cuotas, [
      { installment: 1, due_date: "2026-05-15", amount: "6942.40" },
      { installment: 2, due_date: "2026-06-14", amount: "6942.40" },
      { installment: 3, due_date: "2026-07-14", amount: "6942.40" },
      { installment: 4, due_date: "2026-08-13", amount: "6942.40" },
    ]);
    assert.equal(values.issue_place, "Lima");
  });

  it("deja los céntimos sobrantes en la última cuota", () => {
    const plan = planInstallments({ totalCents: 1000, count: 3, firstDueDate: "2026-01-31", intervalDays: 30 });
    assert.deepEqual(plan.map((c) => c.cents), [333, 333, 334]);
    assert.equal(plan.reduce((s, c) => s + c.cents, 0), 1000);
  });

  it("respeta las cuotas editadas a mano", () => {
    const { ok, values } = normalizeBatchInput({
      ...base,
      cuotas: [
        { due_date: "2026-05-30", amount: "1000" },
        { due_date: "2026-06-30", amount: "500.50" },
      ],
    });
    assert.equal(ok, true);
    assert.equal(values.cuotas.length, 2);
    assert.equal(values.computed_total, "1500.50");
  });

  it("exige aceptante identificado y domicilio", () => {
    const { ok, errors } = normalizeBatchInput({ ...base, acceptor_doc: "123", acceptor_address: "" });
    assert.equal(ok, false);
    assert.ok(errors.acceptor_doc);
    assert.ok(errors.acceptor_address);
  });

  it("si se nombra un aval, exige su documento", () => {
    const { errors } = normalizeBatchInput({ ...base, guarantor_name: "Juan Pérez" });
    assert.ok(errors.guarantor_doc);
  });

  it("no acepta vencimientos anteriores al giro", () => {
    const { ok, errors } = normalizeBatchInput({
      ...base,
      cuotas: [{ due_date: "2026-04-01", amount: "100" }],
    });
    assert.equal(ok, false);
    assert.match(errors.cuotas, /antes de la fecha de giro/);
  });

  it("emite siempre en dólares, diga lo que diga el formulario", () => {
    const { ok, values } = normalizeBatchInput({ ...base, currency_code: "PEN" });
    assert.equal(ok, true);
    assert.equal(values.currency_code, "USD");
  });

  it("rechaza fechas inválidas", () => {
    const { errors } = normalizeBatchInput({ ...base, issue_date: "2026-02-30" });
    assert.ok(errors.issue_date);
  });

  it("al editar, toma sólo las cuotas del formulario con su id", () => {
    const { ok, values } = normalizeBatchInput(
      {
        ...base,
        start_number: "50",
        cuotas: [
          { id: "11", installment: "2", due_date: "2026-06-14", amount: "100" },
          { id: "12", installment: "3", due_date: "2026-07-14", amount: "200.5" },
        ],
      },
      { editing: true },
    );
    assert.equal(ok, true);
    assert.equal(values.startNumber, null);
    assert.deepEqual(values.cuotas, [
      { id: 11, installment: 2, due_date: "2026-06-14", amount: "100" },
      { id: 12, installment: 3, due_date: "2026-07-14", amount: "200.5" },
    ]);
  });

  it("al editar sin letras vigentes, no exige cuotas ni generador", () => {
    const { ok, values } = normalizeBatchInput({ ...base, total_amount: "", installments_count: "" }, { editing: true });
    assert.equal(ok, true);
    assert.deepEqual(values.cuotas, []);
  });

  it("al editar, nombra la letra por su cuota", () => {
    const { ok, errors } = normalizeBatchInput(
      { ...base, cuotas: [{ id: "11", installment: "3", due_date: "2026-04-01", amount: "100" }] },
      { editing: true },
    );
    assert.equal(ok, false);
    assert.match(errors.cuotas, /Letra 3: vence antes/);
  });

  it("parsea montos y documentos", () => {
    assert.equal(parseCents("6,942.40"), 694240);
    assert.equal(parseCents("6942,4"), 694240);
    assert.equal(parseCents("abc"), null);
    assert.equal(normalizeDoc("20.606.218.762"), "20606218762");
    assert.equal(normalizeDoc("2060621876"), null);
    assert.equal(normalizeDoc(" 20606218762 "), "20606218762");
    assert.equal(normalizeDoc("08232345"), "08232345");
  });
});

describe("billOfExchangePdf — impresión", () => {
  it("genera una hoja por letra", async () => {
    const { values } = normalizeBatchInput({
      acceptor_doc: "20606218762",
      acceptor_name: "LFT REP S.A.C.",
      acceptor_address: "Jr. Cerro Negro 434",
      issue_date: "2026-04-15",
      total_amount: "300",
      installments_count: "3",
      interval_days: "30",
    });
    const bills = values.cuotas.map((c, i) =>
      toPrintable(values, {
        number: formatBillNumber(2026, i + 1),
        due_date: c.due_date,
        amount: c.amount,
        status: "issued",
      }),
    );
    assert.equal(bills[0].amountWords, "CIEN CON 00/100 DÓLARES AMERICANOS");
    const pdf = await renderBillsPdf(bills);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    const pages = pdf.toString("latin1").match(/\/Type \/Page\b/g) || [];
    assert.equal(pages.length, 3);
  });

  it("imprime en A4 vertical una letra de 21 × 11,6 cm", async () => {
    assert.equal((FORM_WIDTH / 72) * 2.54, 21);
    assert.ok(Math.abs((FORM_HEIGHT / 72) * 2.54 - 11.6) < 1e-9);
    const pdf = await renderBillsPdf([
      toPrintable(
        { issue_date: "2026-04-15", issue_place: "Lima", acceptor_name: "X", acceptor_doc: "20606218762", acceptor_address: "Y" },
        { number: "LT-00001-2026", due_date: "2026-05-15", amount: "10", status: "issued" },
      ),
    ]);
    assert.match(pdf.toString("latin1"), /\/MediaBox \[0 0 595\.28 841\.89\]/);
  });

  it("lleva el DNI del representante legal", () => {
    assert.equal(BILL_DRAWER.representativeDoc, "DNI N.° 08232345");
    assert.equal(BILL_DRAWER.representative, "JORGE ALEJANDRO MARTIN MASSON PAZOS");
  });
});

describe("features — letras de cambio", () => {
  it("sólo existen en Perú", () => {
    assert.equal(isFeatureEnabled("billsOfExchange", "PE"), true);
    assert.equal(isFeatureEnabled("billsOfExchange", "CL"), false);
  });
});
