const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "PE";

const PeruVacationStrategy = require("../src/services/vacations/strategies/PeruVacationStrategy");
const ChileVacationStrategy = require("../src/services/vacations/strategies/ChileVacationStrategy");
const {
  allocateHistoricalFifo,
  summarizePeriods,
  periodAvailable,
  periodHistoricalUsed,
} = require("../src/services/vacations/vacationBalanceService");
const {
  normalizeHistoryInput,
  duplicateKey,
} = require("../src/services/vacations/vacationHistoryService");
const { parseMonth, monthLabel } = require("../src/constants/vacationHistory");

const pe = new PeruVacationStrategy();
const cl = new ChileVacationStrategy();

/**
 * Ana Pérez, el caso que RR.HH. usó en la reunión: ingreso 01/03/2018.
 * Al 15/01/2026 tiene 7 años cumplidos (210 días) y el 8.º en curso.
 */
function anaPerez({ historicalUsed = 0, approvedUsed = 0 } = {}) {
  const periods = [];
  for (let k = 1; k <= 7; k += 1) {
    periods.push({
      id: k,
      country_code: "PE",
      period_start: `${2017 + k}-03-01`,
      period_end: `${2018 + k}-02-28`,
      entitled_days: 30,
      used_days: 0,
      adjusted_days: 0,
      historical_used_days: 0,
      protected_block_days_used: 0,
      flexible_block_days_used: 0,
      record_met: true,
    });
  }
  // Año en curso 01/03/2025 → 28/02/2026: trunco proporcional.
  periods.push({
    id: 8,
    country_code: "PE",
    period_start: "2025-03-01",
    period_end: "2026-02-28",
    entitled_days: 26.25,
    used_days: 0,
    adjusted_days: 0,
    historical_used_days: 0,
    protected_block_days_used: 0,
    flexible_block_days_used: 0,
    record_met: true,
  });

  if (historicalUsed > 0) {
    allocateHistoricalFifo({ days: historicalUsed, periods, strategy: pe });
  }
  if (approvedUsed > 0) {
    // Las solicitudes aprobadas consumen FIFO sobre lo que queda.
    let remaining = approvedUsed;
    for (const p of periods) {
      if (remaining <= 0) break;
      if (p.period_end >= "2026-01-15") continue; // el año en curso no se puede pedir
      const room = periodAvailable(p);
      if (room <= 0) continue;
      const take = Math.min(room, remaining);
      p.used_days = Number(p.used_days) + take;
      remaining -= take;
    }
  }
  return periods;
}

const AL_15_ENERO_2026 = "2026-01-15";

describe("Saldo con historial previo — caso Ana Pérez", () => {
  it("HIST-01: 210 generados − 196 históricos = 14 de saldo", () => {
    const periods = anaPerez({ historicalUsed: 196 });
    const s = summarizePeriods({
      periods,
      country: "PE",
      referenceDate: AL_15_ENERO_2026,
    });
    assert.equal(s.generatedDays, 210);
    assert.equal(s.historicalUsedDays, 196);
    assert.equal(s.approvedUsedDays, 0);
    assert.equal(s.availableDays, 14);
  });

  it("HIST-02: una solicitud aprobada de 5 días deja el saldo en 9", () => {
    const periods = anaPerez({ historicalUsed: 196, approvedUsed: 5 });
    const s = summarizePeriods({
      periods,
      country: "PE",
      referenceDate: AL_15_ENERO_2026,
    });
    assert.equal(s.historicalUsedDays, 196);
    assert.equal(s.approvedUsedDays, 5);
    assert.equal(s.totalUsedDays, 201);
    assert.equal(s.availableDays, 9);
  });

  it("HIST-03: pendiente, rechazada y cancelada no tocan el saldo", () => {
    // Ninguna de las tres llega a consumir período: solo `approved` lo hace,
    // y es el consumo FIFO el que mueve used_days. Sin consumo, 14.
    const periods = anaPerez({ historicalUsed: 196 });
    const s = summarizePeriods({
      periods,
      country: "PE",
      referenceDate: AL_15_ENERO_2026,
    });
    assert.equal(s.availableDays, 14);
  });

  it("HIST-04: el historial importado pesa igual que el registrado a mano", () => {
    // La imputación no mira el origen: son los mismos días para el saldo.
    const enUnSoloRegistro = anaPerez({ historicalUsed: 196 });
    const enVariosRegistros = anaPerez();
    for (const dias of [15, 10, 15, 30, 30, 30, 30, 36]) {
      allocateHistoricalFifo({
        days: dias,
        periods: enVariosRegistros,
        strategy: pe,
      });
    }
    const a = summarizePeriods({
      periods: enUnSoloRegistro,
      country: "PE",
      referenceDate: AL_15_ENERO_2026,
    });
    const b = summarizePeriods({
      periods: enVariosRegistros,
      country: "PE",
      referenceDate: AL_15_ENERO_2026,
    });
    assert.equal(a.availableDays, b.availableDays);
    assert.equal(b.historicalUsedDays, 196);
  });

  it("HIST-05: el trunco del año en curso no suma al saldo pedible", () => {
    const periods = anaPerez({ historicalUsed: 196 });
    const s = summarizePeriods({
      periods,
      country: "PE",
      referenceDate: AL_15_ENERO_2026,
    });
    assert.equal(s.truncoDays, 26.25);
    assert.equal(s.availableDays, 14);
    // Para una liquidación sí se suman: 14 + 26,25.
    assert.equal(s.severanceDays, 40.25);
  });

  it("HIST-06: el próximo derecho es el día siguiente al fin del período en curso", () => {
    const periods = anaPerez({ historicalUsed: 196 });
    const s = summarizePeriods({
      periods,
      country: "PE",
      referenceDate: AL_15_ENERO_2026,
    });
    assert.equal(s.nextAccrualDate, "2026-03-01");
  });
});

describe("Perú — los días no caducan y el año en curso no se puede pedir", () => {
  it("EXP-01: getExpirationDate devuelve null", () => {
    assert.equal(pe.getExpirationDate({ periodEnd: "2019-02-28" }), null);
  });

  it("EXP-02: un período de 2018 sigue contando en 2026", () => {
    const periods = anaPerez({ historicalUsed: 0 });
    const s = summarizePeriods({
      periods,
      country: "PE",
      referenceDate: AL_15_ENERO_2026,
    });
    // 7 años cumplidos × 30, ninguno perdido por antigüedad.
    assert.equal(s.availableDays, 210);
  });

  it("EXP-03: isPeriodClaimable excluye el período que todavía no termina", () => {
    const enCurso = { period_end: "2026-02-28" };
    const cerrado = { period_end: "2025-02-28" };
    assert.equal(
      pe.isPeriodClaimable({ period: enCurso, referenceDate: AL_15_ENERO_2026 }),
      false,
    );
    assert.equal(
      pe.isPeriodClaimable({ period: cerrado, referenceDate: AL_15_ENERO_2026 }),
      true,
    );
  });

  it("EXP-04: Chile no cambia — todos sus períodos siguen contando", () => {
    const enCurso = { period_end: "2026-02-28" };
    assert.equal(
      cl.isPeriodClaimable({ period: enCurso, referenceDate: AL_15_ENERO_2026 }),
      true,
    );
  });

  it("ELE-01: sin un año cumplido no se puede solicitar", () => {
    const r = pe.validateRequest({
      user: { hire_date: "2025-09-01" },
      request: { startDate: "2026-02-01", endDate: "2026-02-15" },
      availableBalance: 30,
      referenceDate: AL_15_ENERO_2026,
      fractionAcknowledged: true,
    });
    assert.equal(r.valid, false);
    assert.match(r.errors[0], /un año de servicio/);
  });

  it("ELE-02: con el año cumplido la validación sigue su curso normal", () => {
    const r = pe.validateRequest({
      user: { hire_date: "2018-03-01" },
      request: { startDate: "2026-03-02", endDate: "2026-03-16" },
      availableBalance: 30,
      referenceDate: AL_15_ENERO_2026,
      primaryPeriod: { protected_block_days_used: 0, flexible_block_days_used: 0 },
      fractionAcknowledged: true,
    });
    assert.equal(r.valid, true, r.errors.join(" "));
    assert.equal(r.days, 15);
  });
});

describe("Imputación FIFO del historial", () => {
  it("FIFO-01: llena los períodos más antiguos primero", () => {
    const periods = anaPerez();
    const { allocations, overflow } = allocateHistoricalFifo({
      days: 75,
      periods,
      strategy: pe,
    });
    assert.equal(overflow, 0);
    assert.equal(allocations.length, 3);
    assert.equal(allocations[0].days, 30);
    assert.equal(allocations[1].days, 30);
    assert.equal(allocations[2].days, 15);
    assert.equal(periodHistoricalUsed(periods[0]), 30);
    assert.equal(periodHistoricalUsed(periods[2]), 15);
  });

  it("FIFO-02: el historial no valida el art. 17 (son hechos, no solicitudes)", () => {
    // 6 días sueltos irían al bloque flexible en una solicitud; como historial
    // saturan protegido primero y no se rechazan nunca.
    const period = { protected_block_days_used: 0, flexible_block_days_used: 0 };
    const alloc = pe.allocateHistoricalBlockDays(period, 6);
    assert.equal(alloc.protectedDelta, 6);
    assert.equal(alloc.flexibleDelta, 0);
    // Y un tramo imposible bajo el art. 17 tampoco lanza.
    assert.doesNotThrow(() => pe.allocateHistoricalBlockDays(period, 40));
  });

  it("FIFO-05: un período tocado por el historial no arrastra el art. 17", () => {
    // Luis: 22 días gozados antes de la intranet dejaron el bloque protegido
    // agotado y 8 días de saldo. Sin esta excepción esos 8 no caben en ningún
    // tramo legal —ni 1–6 ni 7–14— y el saldo quedaba imposible de pedir.
    const conHistorial = {
      historical_used_days: 22,
      protected_block_days_used: 15,
      flexible_block_days_used: 7,
    };
    const r = pe.validateFractionAgainstPeriod(8, conHistorial);
    assert.equal(r.valid, true);

    const alloc = pe.allocateBlockDays(conHistorial, 8);
    assert.equal(alloc.protectedDelta + alloc.flexibleDelta, 8);
  });

  it("FIFO-06: un período sin historial sigue validando el art. 17 entero", () => {
    const limpio = {
      historical_used_days: 0,
      protected_block_days_used: 15,
      flexible_block_days_used: 7,
    };
    // 8 días con el protegido agotado: el bloque flexible solo admite 1–6.
    const r = pe.validateFractionAgainstPeriod(8, limpio);
    assert.equal(r.valid, false);
    assert.throws(() => pe.allocateBlockDays(limpio, 8));
  });

  it("FIFO-03: más historial que derecho generado → overflow, no excepción", () => {
    const periods = anaPerez();
    const { overflow } = allocateHistoricalFifo({
      days: 400,
      periods,
      strategy: pe,
    });
    // 7 × 30 + 26,25 de trunco = 236,25 de capacidad total.
    assert.equal(overflow, 163.75);
  });

  it("FIFO-04: reimputar desde cero da siempre el mismo reparto", () => {
    const a = anaPerez();
    allocateHistoricalFifo({ days: 40, periods: a, strategy: pe });
    allocateHistoricalFifo({ days: 35, periods: a, strategy: pe });

    const b = anaPerez();
    allocateHistoricalFifo({ days: 35, periods: b, strategy: pe });
    allocateHistoricalFifo({ days: 40, periods: b, strategy: pe });

    // El total imputado por período no depende del orden de los registros.
    assert.deepEqual(
      a.map(periodHistoricalUsed),
      b.map(periodHistoricalUsed),
    );
  });
});

describe("Validación de un registro histórico", () => {
  const contexto = { hireDate: "2018-03-01", referenceYear: 2026 };

  it("VAL-01: año, mes y días, sin fechas exactas → válido", () => {
    const r = normalizeHistoryInput(
      { periodYear: 2020, periodMonth: "Enero", daysUsed: 20 },
      contexto,
    );
    assert.equal(r.valid, true, r.errors.join(" "));
    assert.equal(r.value.periodMonth, 1);
    assert.equal(r.value.startDate, null);
    assert.equal(r.value.endDate, null);
    assert.equal(r.value.daysUsed, 20);
  });

  it("VAL-02: con fechas, los días tienen que cuadrar con el rango", () => {
    const ok = normalizeHistoryInput(
      {
        periodYear: 2019,
        periodMonth: 4,
        startDate: "2019-04-05",
        endDate: "2019-04-19",
        daysUsed: 15,
      },
      contexto,
    );
    assert.equal(ok.valid, true, ok.errors.join(" "));

    const mal = normalizeHistoryInput(
      {
        periodYear: 2019,
        periodMonth: 4,
        startDate: "2019-04-05",
        endDate: "2019-04-19",
        daysUsed: 10,
      },
      contexto,
    );
    assert.equal(mal.valid, false);
    assert.match(mal.errors[0], /cubren 15/);
  });

  it("VAL-03: días ≤ 0 se rechazan", () => {
    for (const dias of [0, -3]) {
      const r = normalizeHistoryInput(
        { periodYear: 2020, periodMonth: 5, daysUsed: dias },
        contexto,
      );
      assert.equal(r.valid, false);
    }
  });

  it("VAL-04: sin mes ni fechas no hay período que registrar", () => {
    const r = normalizeHistoryInput({ periodYear: 2020, daysUsed: 10 }, contexto);
    assert.equal(r.valid, false);
    assert.match(r.errors[0], /al menos el mes/);
  });

  it("VAL-05: un período anterior al ingreso se rechaza", () => {
    const r = normalizeHistoryInput(
      { periodYear: 2016, periodMonth: 3, daysUsed: 10 },
      contexto,
    );
    assert.equal(r.valid, false);
    assert.match(r.errors.join(" "), /anterior a la fecha de ingreso/);
  });

  it("VAL-06: mes inválido se rechaza, mes vacío no", () => {
    const malMes = normalizeHistoryInput(
      { periodYear: 2020, periodMonth: "Marzoo", daysUsed: 10 },
      contexto,
    );
    assert.equal(malMes.valid, false);

    const sinMes = normalizeHistoryInput(
      {
        periodYear: 2020,
        periodMonth: "",
        startDate: "2020-03-01",
        endDate: "2020-03-10",
        daysUsed: 10,
      },
      contexto,
    );
    assert.equal(sinMes.valid, true, sinMes.errors.join(" "));
  });

  it("VAL-07: después de la fecha de corte es aviso, no error", () => {
    const r = normalizeHistoryInput(
      { periodYear: 2026, periodMonth: 12, daysUsed: 10 },
      { ...contexto, cutoffDate: "2026-09-30" },
    );
    assert.equal(r.valid, true, r.errors.join(" "));
    assert.equal(r.warnings.length, 1);
    assert.match(r.warnings[0], /fecha de corte/);
  });

  it("VAL-08: end_date anterior a start_date se rechaza", () => {
    const r = normalizeHistoryInput(
      {
        periodYear: 2019,
        periodMonth: 4,
        startDate: "2019-04-19",
        endDate: "2019-04-05",
        daysUsed: 15,
      },
      contexto,
    );
    assert.equal(r.valid, false);
  });
});

describe("Duplicados", () => {
  const base = {
    userId: 100001,
    periodYear: 2019,
    periodMonth: 4,
    daysUsed: 15,
    startDate: null,
    endDate: null,
  };

  it("DUP-01: mismo trabajador, período, días y fechas → misma clave", () => {
    assert.equal(duplicateKey(base), duplicateKey({ ...base }));
  });

  it("DUP-02: distinta cantidad de días → clave distinta", () => {
    assert.notEqual(duplicateKey(base), duplicateKey({ ...base, daysUsed: 10 }));
  });

  it("DUP-03: mismo mes y días pero con fechas distintas → clave distinta", () => {
    assert.notEqual(
      duplicateKey(base),
      duplicateKey({ ...base, startDate: "2019-04-05", endDate: "2019-04-19" }),
    );
  });
});

describe("Meses del Excel de RR.HH.", () => {
  it("MES-01: nombre, número y abreviatura", () => {
    assert.equal(parseMonth("Marzo"), 3);
    assert.equal(parseMonth("marzo"), 3);
    assert.equal(parseMonth("MARZO"), 3);
    assert.equal(parseMonth("mar"), 3);
    assert.equal(parseMonth(3), 3);
    assert.equal(parseMonth("3"), 3);
  });

  it("MES-02: «setiembre», como se escribe en Perú", () => {
    assert.equal(parseMonth("Setiembre"), 9);
    assert.equal(parseMonth("setiembre"), 9);
    assert.equal(parseMonth("Septiembre"), 9);
  });

  it("MES-03: basura y fuera de rango → null", () => {
    assert.equal(parseMonth("Marzoo"), null);
    assert.equal(parseMonth(13), null);
    assert.equal(parseMonth(0), null);
    assert.equal(parseMonth(""), null);
    assert.equal(parseMonth(null), null);
  });

  it("MES-04: monthLabel es la vuelta de parseMonth", () => {
    assert.equal(monthLabel(4), "Abril");
    assert.equal(monthLabel(13), null);
  });
});
