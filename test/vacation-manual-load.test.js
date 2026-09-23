const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "PE";

const PeruVacationStrategy = require("../src/services/vacations/strategies/PeruVacationStrategy");
const {
  allocateHistoricalFifo,
  simulateHistoryImputation,
  summarizePeriods,
  balanceAt,
  expectedPeriodRanges,
  planPeriodRealignment,
  periodHistoricalUsed,
} = require("../src/services/vacations/vacationBalanceService");
const {
  previewBatch,
  parseYearMonth,
  normalizeHistoryInput,
} = require("../src/services/vacations/vacationHistoryService");
const { compareReference } = require("../src/services/vacations/vacationReferenceService");
const {
  mapHistoryAuditForView,
  periodShortLabel,
} = require("../src/utils/schemaMappers");

const pe = new PeruVacationStrategy();

/**
 * Datos reales de la hoja «Base» del Excel de RR.HH. (setiembre 2026): una
 * fila por salida, «MM-AAAA» y días. Los saldos esperados son los de la hoja
 * «Agendas» (saldo legal = años cumplidos × 30 − gozados), que es la que
 * cuadra; «Base» sobrecuenta el año en curso y tiene rangos de fórmula rotos.
 */
const AL_16_SET_2026 = "2026-09-16";

const ROCIO_LOPEZ = {
  hire: "2018-10-25",
  salidas: [
    ["09-2019", 1], ["08-2020", 15], ["09-2020", 7], ["10-2020", 7],
    ["09-2021", 7], ["11-2021", 8], ["12-2021", 2], ["04-2022", 2],
    ["06-2022", 4], ["07-2022", 7], ["09-2022", 7], ["10-2022", 1],
    ["11-2022", 7], ["01-2023", 7], ["07-2023", 3], ["09-2023", 7],
    ["10-2023", 28], ["01-2024", 9], ["07-2024", 7], ["08-2024", 7],
    ["10-2024", 7], ["08-2025", 7], ["10-2025", 7], ["11-2025", 7],
    ["12-2025", 1], ["01-2026", 1], ["02-2026", 6], ["03-2026", 2],
    ["04-2026", 1], ["05-2026", 7], ["07-2026", 7], ["08-2026", 7],
  ],
};

const SANTIAGO_QUISPE = {
  hire: "2020-03-02",
  salidas: [
    ["05-2021", 30], ["12-2021", 2], ["04-2022", 1], ["09-2022", 7],
    ["11-2022", 7], ["10-2023", 2], ["11-2023", 5], ["12-2023", 15],
    ["01-2024", 11], ["02-2024", 1], ["05-2024", 9], ["06-2024", 7],
    ["10-2024", 7], ["03-2025", 7], ["09-2025", 9], ["10-2025", 5],
    ["12-2025", 7], ["01-2026", 14], ["05-2026", 7],
  ],
};

/** En la fila de 08-2026 la planilla dice 1 día en «TOTAL» pero 1 + 3 por período. */
const MEUDY_MARCANO = {
  hire: "2024-10-14",
  salidas: [["11-2025", 7], ["03-2026", 7], ["05-2026", 7], ["07-2026", 8], ["08-2026", 1]],
};

/** Períodos de un colaborador a una fecha: años cumplidos a 30 y el en curso proporcional. */
function periodosDesde(hire, referencia) {
  const rangos = expectedPeriodRanges(hire, referencia);
  return rangos.map((r, i) => ({
    id: i + 1,
    country_code: "PE",
    period_start: r.periodStart,
    period_end: r.periodEnd,
    entitled_days:
      i < rangos.length - 1
        ? 30
        : pe.getProportionalDays({ hireDate: r.periodStart, referenceDate: referencia }),
    used_days: 0,
    adjusted_days: 0,
    historical_used_days: 0,
    protected_block_days_used: 0,
    flexible_block_days_used: 0,
    record_met: true,
  }));
}

/** «MM-AAAA» de la planilla → registro de vacation_history. */
function registros(salidas) {
  return salidas.map(([mesAnio, dias], i) => {
    const [mes, anio] = mesAnio.split("-").map(Number);
    return { id: i + 1, period_year: anio, period_month: mes, days_used: dias };
  });
}

/** Salidas de la planilla → filas del formulario de carga por lotes. */
function filasDeCarga(salidas) {
  return salidas.map(([mesAnio, dias]) => {
    const [mes, anio] = mesAnio.split("-");
    return { month: `${anio}-${mes}`, days: String(dias), start: "", end: "", observation: "" };
  });
}

const total = (salidas) => salidas.reduce((s, [, d]) => s + d, 0);

describe("Conciliación con la planilla de RR.HH. (datos reales)", () => {
  it("XLS-01: Rocío López — 7 años cumplidos, 203 gozados → saldo 7 (Agendas)", () => {
    assert.equal(total(ROCIO_LOPEZ.salidas), 203);
    const periods = periodosDesde(ROCIO_LOPEZ.hire, AL_16_SET_2026);
    const history = registros(ROCIO_LOPEZ.salidas);

    assert.equal(balanceAt({ periods, history, asOf: AL_16_SET_2026 }), 7);

    const sim = simulateHistoryImputation({ periods, records: history, strategy: pe });
    const s = summarizePeriods({ periods: sim.periods, country: "PE", referenceDate: AL_16_SET_2026 });
    assert.equal(s.generatedDays, 210);
    assert.equal(s.availableDays, 7);
    assert.equal(sim.overflow, 0);
  });

  it("XLS-02: Rocío López — el FIFO reparte igual que las columnas por período", () => {
    const periods = periodosDesde(ROCIO_LOPEZ.hire, AL_16_SET_2026);
    const sim = simulateHistoryImputation({
      periods,
      records: registros(ROCIO_LOPEZ.salidas),
      strategy: pe,
    });
    const porId = new Map(sim.results.map((r) => [r.record.id, r.allocations]));
    // 09-2019 + 08-2020 + 09-2020 + 10-2020 = 30 llenan el primer período.
    assert.equal(periodHistoricalUsed(sim.periods[0]), 30);
    // 09-2023 (fila 16): 5 días al 2020–2021 y 2 al 2021–2022, como K25/L25.
    const partida = porId.get(16);
    assert.deepEqual(
      partida.map((a) => [periodShortLabel(periods[a.periodId - 1]), a.days]),
      [["2020–2021", 5], ["2021–2022", 2]],
    );
  });

  it("XLS-03: Santiago Quispe — saldo 27 (la fórmula de «Base» decía 55)", () => {
    assert.equal(total(SANTIAGO_QUISPE.salidas), 153);
    const periods = periodosDesde(SANTIAGO_QUISPE.hire, AL_16_SET_2026);
    assert.equal(
      balanceAt({ periods, history: registros(SANTIAGO_QUISPE.salidas), asOf: AL_16_SET_2026 }),
      27,
    );
  });

  it("XLS-04: Meudy Marcano — 30 gozados dan 0; si fueron 33, −3 y el resto sale del trunco", () => {
    const periods = periodosDesde(MEUDY_MARCANO.hire, AL_16_SET_2026);
    assert.equal(balanceAt({ periods, history: registros(MEUDY_MARCANO.salidas), asOf: AL_16_SET_2026 }), 0);

    const con33 = [...MEUDY_MARCANO.salidas.slice(0, -1), ["08-2026", 4]];
    assert.equal(balanceAt({ periods, history: registros(con33), asOf: AL_16_SET_2026 }), -3);

    const sim = simulateHistoryImputation({ periods, records: registros(con33), strategy: pe });
    const s = summarizePeriods({ periods: sim.periods, country: "PE", referenceDate: AL_16_SET_2026 });
    assert.equal(s.availableDays, 0);
    assert.equal(sim.overflow, 0); // los 3 días caben en el trunco (adelanto)
  });

  it("XLS-05: la referencia de Agendas cuadra; la de Base no", () => {
    const periods = periodosDesde(ROCIO_LOPEZ.hire, AL_16_SET_2026);
    const history = registros(ROCIO_LOPEZ.salidas);
    const agendas = compareReference({
      reference: { as_of_date: AL_16_SET_2026, expected_days: 7 },
      periods,
      history,
      requests: [],
    });
    assert.equal(agendas.matches, true);

    // «Base» sumaba el período 2025–2026 que todavía no se cumple: 37.
    const base = compareReference({
      reference: { as_of_date: AL_16_SET_2026, expected_days: 37 },
      periods,
      history,
      requests: [],
    });
    assert.equal(base.matches, false);
    assert.equal(base.difference, -30);
  });

  it("XLS-06: balanceAt solo cuenta lo gozado hasta el mes de la referencia", () => {
    const periods = periodosDesde(ROCIO_LOPEZ.hire, AL_16_SET_2026);
    const history = registros(ROCIO_LOPEZ.salidas);
    // Al 31-07-2026: mismos 210 generados, sin la salida de 08-2026 (7 días).
    assert.equal(balanceAt({ periods, history, asOf: "2026-07-31" }), 14);
    // Una solicitud de la intranet también descuenta.
    assert.equal(
      balanceAt({
        periods,
        history,
        requests: [{ start_date: "2026-09-01", calendar_days: 5 }],
        asOf: AL_16_SET_2026,
      }),
      2,
    );
  });
});

describe("simulateHistoryImputation", () => {
  it("SIM-01: da lo mismo que imputar registro a registro", () => {
    const periods = periodosDesde(SANTIAGO_QUISPE.hire, AL_16_SET_2026);
    const records = registros(SANTIAGO_QUISPE.salidas);

    const aMano = periodosDesde(SANTIAGO_QUISPE.hire, AL_16_SET_2026);
    for (const r of records) allocateHistoricalFifo({ days: r.days_used, periods: aMano, strategy: pe });

    const sim = simulateHistoryImputation({ periods, records, strategy: pe });
    assert.deepEqual(sim.periods.map(periodHistoricalUsed), aMano.map(periodHistoricalUsed));
  });

  it("SIM-02: no depende del orden en que llegan los registros ni muta la entrada", () => {
    const periods = periodosDesde(ROCIO_LOPEZ.hire, AL_16_SET_2026);
    const records = registros(ROCIO_LOPEZ.salidas);
    const a = simulateHistoryImputation({ periods, records, strategy: pe });
    const b = simulateHistoryImputation({ periods, records: [...records].reverse(), strategy: pe });
    assert.deepEqual(a.periods.map(periodHistoricalUsed), b.periods.map(periodHistoricalUsed));
    assert.equal(periods[0].historical_used_days, 0);
  });

  it("SIM-03: parte de los bloques que ya consumieron las solicitudes", () => {
    const periods = periodosDesde("2024-01-10", AL_16_SET_2026);
    const approvedBlocks = new Map([[1, { protectedDelta: 10, flexibleDelta: 2 }]]);
    const sim = simulateHistoryImputation({
      periods,
      records: [{ id: 1, period_year: 2025, period_month: 3, days_used: 3 }],
      strategy: pe,
      approvedBlocks,
    });
    assert.equal(sim.periods[0].protected_block_days_used, 13);
    assert.equal(sim.periods[0].flexible_block_days_used, 2);
  });
});

describe("Carga manual por lotes — vista previa", () => {
  const employee = { id: 7, hire_date: "2023-08-07" };
  const periods = periodosDesde(employee.hire_date, AL_16_SET_2026);
  const base = {
    employee,
    existingHistory: [],
    periods,
    strategy: pe,
    country: "PE",
    referenceDate: AL_16_SET_2026,
    periodLabels: new Map(periods.map((p) => [p.id, periodShortLabel(p)])),
  };

  it("LOTE-01: Gustavo Valenzuela entero → 43 gozados, saldo 47", () => {
    const salidas = [
      ["08-2025", 14], ["12-2025", 9], ["02-2026", 6], ["03-2026", 1],
      ["05-2026", 7], ["07-2026", 4], ["08-2026", 2],
    ];
    const p = previewBatch({ ...base, rows: filasDeCarga(salidas) });
    assert.equal(p.valid, true);
    assert.equal(p.entries, 7);
    assert.equal(p.addedDays, 43);
    assert.equal(p.before.availableDays, 90);
    assert.equal(p.after.availableDays, 47);
    assert.deepEqual(p.rows[0].allocations, [{ label: "2023–2024", days: 14 }]);
  });

  it("LOTE-02: una fila con error invalida el lote y se señala por número", () => {
    const filas = filasDeCarga([["08-2025", 14], ["12-2025", 9]]);
    filas.push({ month: "2026-12", days: "5" }); // mes futuro
    filas.push({ month: "2025-01", days: "0" }); // sin días
    const p = previewBatch({ ...base, rows: filas });
    assert.equal(p.valid, false);
    assert.equal(p.errorCount, 2);
    assert.equal(p.rows[0].errors.length, 0);
    assert.match(p.rows[2].errors.join(" "), /todavía no llega/);
    assert.match(p.rows[3].errors.join(" "), /cuántos días/);
    // Las filas buenas igual muestran a qué período van.
    assert.equal(p.rows[1].allocations.length > 0, true);
  });

  it("LOTE-03: dos salidas iguales el mismo mes son un aviso, no un error", () => {
    // Rocío Rivera, 08-2024: dos salidas de 7 días.
    const p = previewBatch({ ...base, rows: filasDeCarga([["08-2024", 7], ["08-2024", 7]]) });
    assert.equal(p.valid, true);
    assert.equal(p.rows[0].warnings.length, 0);
    assert.equal(p.rows[1].warnings.length, 1);
  });

  it("LOTE-04: repetir una salida ya guardada también avisa", () => {
    const p = previewBatch({
      ...base,
      existingHistory: [{ id: 1, period_year: 2025, period_month: 8, days_used: 14 }],
      rows: filasDeCarga([["08-2025", 14]]),
    });
    assert.equal(p.valid, true);
    assert.equal(p.rows[0].warnings.length, 1);
    assert.equal(p.before.availableDays, 76);
    assert.equal(p.after.availableDays, 62);
  });

  it("LOTE-05: las filas vacías se ignoran; sin filas con datos no hay lote", () => {
    const vacio = { month: "", days: "", start: "", end: "", observation: "" };
    const p = previewBatch({ ...base, rows: [vacio, ...filasDeCarga([["08-2025", 7]]), vacio] });
    assert.equal(p.entries, 1);
    assert.equal(p.valid, true);
    assert.equal(p.rows[0].blank, true);

    const nada = previewBatch({ ...base, rows: [vacio] });
    assert.equal(nada.entries, 0);
    assert.equal(nada.valid, false);
  });

  it("LOTE-06: más días que el derecho → se ve el sobrante antes de guardar", () => {
    const p = previewBatch({ ...base, rows: filasDeCarga([["08-2025", 30], ["09-2025", 30], ["10-2025", 60]]) });
    assert.equal(p.valid, true);
    assert.equal(p.after.unimputedDays > 0, true);
    assert.equal(p.rows[2].unallocated > 0, true);
  });

  it("LOTE-07: con fechas exactas, los días tienen que calzar", () => {
    const ok = previewBatch({
      ...base,
      rows: [{ month: "2025-08", days: "14", start: "2025-08-04", end: "2025-08-17" }],
    });
    assert.equal(ok.valid, true);
    const mal = previewBatch({
      ...base,
      rows: [{ month: "2025-08", days: "10", start: "2025-08-04", end: "2025-08-17" }],
    });
    assert.equal(mal.valid, false);
  });
});

describe("Mes y año en un solo campo", () => {
  it("YM-01: «2024-03» se parte en año y mes", () => {
    assert.deepEqual(parseYearMonth("2024-03"), { year: 2024, month: 3 });
    assert.equal(parseYearMonth("2024-13"), null);
    assert.equal(parseYearMonth("03-2024"), null);
    assert.equal(parseYearMonth(""), null);
  });

  it("YM-02: normalizeHistoryInput acepta yearMonth", () => {
    const r = normalizeHistoryInput(
      { yearMonth: "2020-05", daysUsed: 30 },
      { hireDate: "2020-03-02", referenceDate: AL_16_SET_2026 },
    );
    assert.equal(r.valid, true, r.errors.join(" "));
    assert.equal(r.value.periodYear, 2020);
    assert.equal(r.value.periodMonth, 5);
  });

  it("YM-03: el mes en curso vale; el siguiente, no", () => {
    const ctx = { hireDate: "2020-03-02", referenceDate: AL_16_SET_2026 };
    assert.equal(normalizeHistoryInput({ yearMonth: "2026-09", daysUsed: 7 }, ctx).valid, true);
    assert.equal(normalizeHistoryInput({ yearMonth: "2026-10", daysUsed: 7 }, ctx).valid, false);
  });
});

describe("Cambiar la fecha de ingreso no duplica períodos", () => {
  const conPeriodos = (hire, ref, extra = {}) =>
    periodosDesde(hire, ref).map((p) => ({ ...p, ...extra[p.id] }));

  it("REAL-01: Jean Pierre Lara, 01-08-2025 → 21-07-2025: mueve, no agrega", () => {
    const existentes = conPeriodos("2025-08-01", AL_16_SET_2026);
    const plan = planPeriodRealignment({
      existing: existentes,
      expected: expectedPeriodRanges("2025-07-21", AL_16_SET_2026),
    });
    assert.equal(plan.needed, true);
    assert.equal(plan.blocked.length, 0);
    assert.equal(plan.deletions.length, 0);
    assert.deepEqual(
      plan.moves.map((m) => [m.id, m.periodStart, m.periodEnd]),
      [
        [1, "2025-07-21", "2026-07-20"],
        [2, "2026-07-21", "2027-07-20"],
      ],
    );
  });

  it("REAL-02: sin cambios no hay nada que hacer", () => {
    const plan = planPeriodRealignment({
      existing: conPeriodos("2023-08-07", AL_16_SET_2026),
      expected: expectedPeriodRanges("2023-08-07", AL_16_SET_2026),
    });
    assert.equal(plan.needed, false);
  });

  it("REAL-03: el ingreso se corre un año adelante → el período sobrante se borra si está limpio", () => {
    const plan = planPeriodRealignment({
      existing: conPeriodos("2023-08-07", AL_16_SET_2026),
      expected: expectedPeriodRanges("2024-08-07", AL_16_SET_2026),
    });
    assert.equal(plan.blocked.length, 0);
    assert.deepEqual(plan.deletions, [4]);
  });

  it("REAL-04: …y se bloquea si ese período tiene días aprobados o ajustes", () => {
    const plan = planPeriodRealignment({
      existing: conPeriodos("2023-08-07", AL_16_SET_2026, { 4: { adjusted_days: 2 } }),
      expected: expectedPeriodRanges("2024-08-07", AL_16_SET_2026),
    });
    assert.equal(plan.blocked.length, 1);
  });

  it("REAL-05: el historial queda en los períodos realineados, sin sobrante", () => {
    // Con la fecha corregida el mismo historial se reparte sobre los mismos
    // registros de período: nada de 30 días fantasma de la fecha anterior.
    const hire = "2025-07-21";
    const periods = periodosDesde(hire, AL_16_SET_2026);
    const sim = simulateHistoryImputation({
      periods,
      records: registros([["04-2026", 7], ["08-2026", 14]]),
      strategy: pe,
    });
    const s = summarizePeriods({ periods: sim.periods, country: "PE", referenceDate: AL_16_SET_2026 });
    assert.equal(s.generatedDays, 30);
    assert.equal(s.availableDays, 9);
  });
});

describe("Plazo para gozar (art. 23 D.L. 713)", () => {
  const periodo = { period_end: "2025-10-24" };

  it("PLZ-01: vence un año después de cerrar el período", () => {
    assert.equal(pe.getEnjoymentDeadline({ periodEnd: "2025-10-24" }), "2026-10-24");
    assert.equal(pe.getEnjoymentDeadline({ periodEnd: "2024-02-29" }), "2025-02-28");
  });

  it("PLZ-02: Rocío López, 7 días del 2024–2025 → vence pronto; al día siguiente, vencido", () => {
    const antes = pe.getEnjoymentStatus({ period: periodo, available: 7, referenceDate: "2026-09-23" });
    assert.equal(antes.dueSoon, true);
    assert.equal(antes.overdue, false);
    const despues = pe.getEnjoymentStatus({ period: periodo, available: 7, referenceDate: "2026-10-25" });
    assert.equal(despues.overdue, true);
  });

  it("PLZ-03: sin saldo no hay alerta", () => {
    const s = pe.getEnjoymentStatus({ period: periodo, available: 0, referenceDate: "2027-01-01" });
    assert.equal(s.overdue, false);
    assert.equal(s.dueSoon, false);
  });
});

describe("Bitácora", () => {
  it("BIT-01: un cambio de fecha de ingreso se lee en palabras", () => {
    const v = mapHistoryAuditForView({
      action: "PROFILE",
      old_value: { hire_date: "2025-08-01", national_id: null },
      new_value: { hire_date: "2025-07-21", national_id: "70917210" },
      source: "Contrato",
      created_at: "2026-09-23T15:00:00Z",
    });
    assert.equal(v.actionLabel, "Datos del cálculo");
    assert.deepEqual(v.details, [
      "Fecha de ingreso: 01-08-2025 → 21-07-2025",
      "Documento: sin dato → 70917210",
    ]);
    assert.equal(v.note, "Contrato");
  });

  it("BIT-02: una salida editada muestra antes y después", () => {
    const v = mapHistoryAuditForView({
      action: "UPDATE",
      old_value: JSON.stringify({ period_year: 2026, period_month: 8, days_used: 1 }),
      new_value: JSON.stringify({ period_year: 2026, period_month: 8, days_used: 4 }),
    });
    assert.deepEqual(v.details, ["Antes: Agosto 2026 · 1 día(s)", "Después: Agosto 2026 · 4 día(s)"]);
  });
});
