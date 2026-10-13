const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const ChileVacationStrategy = require("../src/services/vacations/strategies/ChileVacationStrategy");
const PeruVacationStrategy = require("../src/services/vacations/strategies/PeruVacationStrategy");
const {
  effectiveEntitled,
  periodAvailable,
  detectAccumulationAlert,
} = require("../src/services/vacations/vacationBalanceService");
const { countBusinessDays } = require("../src/utils/vacationDateUtils");

const cl = new ChileVacationStrategy();
const pe = new PeruVacationStrategy();

describe("ChileVacationStrategy — progresivo art. 68", () => {
  it("CL-01: 3 años → 15 días base", () => {
    assert.equal(cl.getAnnualEntitlement({ yearsOfService: 3 }), 15);
  });

  it("CL-02: 13 años → 16 días", () => {
    assert.equal(cl.getProgressiveDays(13), 1);
    assert.equal(cl.getAnnualEntitlement({ yearsOfService: 13 }), 16);
  });

  it("CL-03: 19 años → 18 días", () => {
    assert.equal(cl.getProgressiveDays(19), 3);
    assert.equal(cl.getAnnualEntitlement({ yearsOfService: 19 }), 18);
  });

  it("CL-04: 25 años → 20 días", () => {
    assert.equal(cl.getProgressiveDays(25), 5);
    assert.equal(cl.getAnnualEntitlement({ yearsOfService: 25 }), 20);
  });

  it("CL-05: 8 en empresa + 6 previos acreditados → 16 días", () => {
    assert.equal(
      cl.getAnnualEntitlement({ yearsOfService: 8, priorYearsCredited: 6 }),
      16,
    );
  });

  it("T-01: no caduca — getExpirationDate null", () => {
    assert.equal(cl.getExpirationDate({ periodEnd: "2024-12-31" }), null);
  });

  it("CL-06: lunes a lunes → 6 días hábiles", () => {
    const days = countBusinessDays("2026-08-03", "2026-08-10", new Set());
    assert.equal(days, 6);
  });
});

describe("PeruVacationStrategy — fraccionamiento art. 17", () => {
  const emptyPeriod = {
    protected_block_days_used: 0,
    flexible_block_days_used: 0,
  };

  it("PE-05: 1 día con bloque flexible disponible → aceptada", () => {
    const r = pe.validateFractionAgainstPeriod(1, emptyPeriod);
    assert.equal(r.valid, true);
  });

  it("PE-06: 5 días con bloque flexible agotado → rechazada", () => {
    const period = {
      protected_block_days_used: 15,
      flexible_block_days_used: 15,
    };
    const r = pe.validateFractionAgainstPeriod(5, period);
    assert.equal(r.valid, false);
    assert.match(r.error, /tramos cortos/);
  });

  it("PE-07: tramo 7 + tramo 6 sobre bloque protegido → segunda rechazada", () => {
    const afterSeven = {
      protected_block_days_used: 7,
      flexible_block_days_used: 0,
    };
    const r = pe.validateFractionAgainstPeriod(6, afterSeven);
    assert.equal(r.valid, false);
    assert.match(r.error, /7 u 8 días/);
  });

  it("T-04: min sugerido genera warning, no error", () => {
    const result = pe.validateRequest({
      request: { startDate: "2026-09-01", endDate: "2026-09-01" },
      availableBalance: 30,
      existingActiveRequests: [],
      referenceDate: "2026-08-03",
      config: { suggestedMinFractionDaysPE: 7 },
      primaryPeriod: emptyPeriod,
      fractionAcknowledged: true,
    });
    assert.equal(result.valid, true);
    assert.ok(result.warnings.length > 0);
  });
});

describe("PeruVacationStrategy — allocateBlockDays", () => {
  const emptyPeriod = {
    protected_block_days_used: 0,
    flexible_block_days_used: 0,
  };

  it("PE-alloc-01: 1–6 días → solo bloque flexible (art. 17.ii)", () => {
    const alloc = pe.allocateBlockDays(emptyPeriod, 5);
    assert.equal(alloc.protectedDelta, 0);
    assert.equal(alloc.flexibleDelta, 5);
  });

  it("PE-alloc-02: 7–14 días → solo bloque protegido (art. 17.i)", () => {
    const alloc = pe.allocateBlockDays(emptyPeriod, 7);
    assert.equal(alloc.protectedDelta, 7);
    assert.equal(alloc.flexibleDelta, 0);
  });

  it("PE-alloc-03: ≥15 días → protegido primero, excedente a flexible", () => {
    const alloc = pe.allocateBlockDays(emptyPeriod, 20);
    assert.equal(alloc.protectedDelta, 15);
    assert.equal(alloc.flexibleDelta, 5);
  });

  it("PE-alloc-04: 1 día no consume protegido (regresión bug FIFO)", () => {
    const alloc = pe.allocateBlockDays(emptyPeriod, 1);
    assert.equal(alloc.protectedDelta, 0);
    assert.equal(alloc.flexibleDelta, 1);
  });

  it("PE-alloc-05: tramo 8 tras 7 protegidos → completa protegido", () => {
    const afterSeven = {
      protected_block_days_used: 7,
      flexible_block_days_used: 0,
    };
    const alloc = pe.allocateBlockDays(afterSeven, 8);
    assert.equal(alloc.protectedDelta, 8);
    assert.equal(alloc.flexibleDelta, 0);
  });

  it("PE-fifo-01: validación multi-período imputa tramos por período", () => {
    const periods = [
      {
        entitled_days: 3,
        adjusted_days: 0,
        used_days: 0,
        record_met: true,
        available: 3,
        protected_block_days_used: 0,
        flexible_block_days_used: 0,
      },
      {
        entitled_days: 30,
        adjusted_days: 0,
        used_days: 0,
        record_met: true,
        available: 30,
        protected_block_days_used: 0,
        flexible_block_days_used: 0,
      },
    ];
    // 5 días: 3 flex en P1 + 2 flex en P2 (antes fallaba validando 5 contra P1)
    const r = pe.validateFractionAcrossPeriods(5, periods);
    assert.equal(r.valid, true);
  });

  it("PE-fifo-02: tramo flexible agotado en período que absorbe → rechaza", () => {
    const periods = [
      {
        entitled_days: 10,
        adjusted_days: 0,
        used_days: 0,
        record_met: true,
        available: 10,
        protected_block_days_used: 0,
        flexible_block_days_used: 15,
      },
    ];
    const r = pe.validateFractionAcrossPeriods(5, periods);
    assert.equal(r.valid, false);
    assert.match(r.error, /tramos cortos/);
  });
});

describe("vacationBalanceService — récord y acumulación", () => {
  it("PE-12: record_met=false → entitled efectivo 0", () => {
    const period = {
      entitled_days: 30,
      adjusted_days: 0,
      used_days: 0,
      record_met: false,
    };
    assert.equal(effectiveEntitled(period), 0);
    assert.equal(periodAvailable(period), 0);
  });

  it("T-01: alerta acumulación CL con ≥2 períodos con saldo", () => {
    const periods = [
      { entitled_days: 15, adjusted_days: 0, used_days: 0, record_met: true },
      { entitled_days: 15, adjusted_days: 0, used_days: 0, record_met: true },
    ];
    const r = detectAccumulationAlert(periods, "CL");
    assert.equal(r.alert, true);
    assert.equal(r.periodsWithBalance, 2);
  });
});

describe("Resumen — días vencidos y plazo legal (Perú)", () => {
  const { enjoymentDeadlines } = require("../src/services/vacations/vacationReportService");
  const { summarizePeriods } = require("../src/services/vacations/vacationBalanceService");

  // Ramón (reunión RR.HH. 25/09/2026): ingresó el 08/04/2024, lleva dos años
  // cumplidos (60 días) y gozó 29. RR.HH. espera ver 31 días vencidos.
  const periodo = (start, end, historical) => ({
    period_start: start,
    period_end: end,
    entitled_days: 30,
    adjusted_days: 0,
    used_days: 0,
    historical_used_days: historical,
    record_met: true,
  });
  const periods = [
    periodo("2024-04-08", "2025-04-07", 29),
    periodo("2025-04-08", "2026-04-07", 0),
    periodo("2026-04-08", "2027-04-07", 0),
  ];
  const today = "2026-09-28";

  it("los días vencidos son todo el saldo de años cumplidos (31)", () => {
    const summary = summarizePeriods({ periods, country: "PE", referenceDate: today });
    assert.equal(summary.availableDays, 31);
  });

  it("solo 1 día pasó el plazo legal y el próximo plazo es el del 2.º período", () => {
    const d = enjoymentDeadlines(periods, pe, today);
    assert.equal(d.overdueDays, 1);
    assert.equal(d.dueSoonDays, 0);
    assert.equal(d.nextDeadline, "2027-04-07");
  });

  it("el plazo más próximo se informa aunque todavía no venza pronto", () => {
    const d = enjoymentDeadlines([periodo("2025-04-08", "2026-04-07", 21)], pe, today);
    assert.equal(d.overdueDays, 0);
    assert.equal(d.nextDeadline, "2027-04-07");
  });

  it("sin saldo no hay plazo que mostrar", () => {
    const d = enjoymentDeadlines([periodo("2025-04-08", "2026-04-07", 30)], pe, today);
    assert.equal(d.nextDeadline, null);
  });
});

describe("Aviso manual de días vencidos (correo)", () => {
  const { buildPendingReminder } = require("../src/services/vacations/vacationNotificationService");
  const user = { first_name: "Ramón", last_name: "Cerna", email: "ramon@transworld.pe" };
  const periods = [
    { periodLabel: "2024–2025", available: 1, overdue: true, enjoyByFmt: "07-04-2026", inProgress: false },
    { periodLabel: "2025–2026", available: 30, overdue: false, enjoyByFmt: "07-04-2027", inProgress: false },
    { periodLabel: "2026–2027", available: 12.5, overdue: false, enjoyByFmt: null, inProgress: true },
  ];

  it("va al colaborador con el total y el detalle por período, sin el trunco", () => {
    const mail = buildPendingReminder({ user, summary: { availableDays: 31 }, periods });
    assert.equal(mail.to, "ramon@transworld.pe");
    assert.match(mail.subject, /31 día\(s\)/);
    assert.match(mail.html, /2024–2025/);
    assert.match(mail.html, /Fuera de plazo/);
    assert.match(mail.html, /Tomar antes del 07-04-2027/);
    assert.doesNotMatch(mail.html, /2026–2027/);
    assert.equal(mail.cta.href, "/RRHH/vacaciones/mis-vacaciones");
  });

  it("incluye el mensaje de RR.HH. escapado", () => {
    const mail = buildPendingReminder({ user, summary: { availableDays: 31 }, periods, note: "Coordina <b>octubre</b>" });
    assert.match(mail.html, /Coordina &lt;b&gt;octubre&lt;\/b&gt;/);
    assert.match(mail.text, /Coordina <b>octubre<\/b>/);
  });
});
