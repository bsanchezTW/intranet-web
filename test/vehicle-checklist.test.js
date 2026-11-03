const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const {
  computeResult,
  formatChecklistNumber,
  defaultTemplate,
} = require("../src/constants/vehicleChecklist");
const {
  normalizePlate,
  normalizeVehicleInput,
  documentAlerts,
  vehicleLabel,
} = require("../src/services/logistics/vehicleService");
const {
  normalizeChecklistInput,
  normalizeItemInput,
  answerKey,
  commentKey,
} = require("../src/services/logistics/checklistService");
const { renderChecklistPdf } = require("../src/services/logistics/checklistPdf");
const { DDL_STATEMENTS } = require("../src/services/logistics/logisticsSchema");
const { getPermission } = require("../src/services/permissions/catalog");
const { isFeatureEnabled } = require("../src/config/features");

const TODAY = "2026-11-03";
const ITEMS = [
  { id: 11, category: "Luces", label: "Luces de freno", critical: true },
  { id: 12, category: "Luces", label: "Intermitentes", critical: false },
  { id: 13, category: "Cabina", label: "Bocina", critical: false },
];
const VEHICLES = [{ id: 7, plate: "ABCD12", odometer_km: 45000, brand: "Toyota", model: "Hilux", model_year: 2022 }];
const DRIVERS = [{ id: 614793, name: "Bastián Dummy" }];

function body(overrides = {}) {
  return {
    inspection_date: TODAY,
    inspection_kind: "salida",
    vehicle_id: "7",
    odometer_km: "45.230",
    driver_user_id: "614793",
    [answerKey(11)]: "ok",
    [answerKey(12)]: "ok",
    [answerKey(13)]: "na",
    declaro: "1",
    ...overrides,
  };
}

const ctx = { items: ITEMS, vehicles: VEHICLES, drivers: DRIVERS, today: TODAY };

describe("checklist de vehículos — resultado y numeración", () => {
  it("una falla crítica deja no apto; una no crítica, observado", () => {
    assert.equal(computeResult([{ critical: true, answer: "ok" }, { critical: false, answer: "na" }]), "apto");
    assert.equal(computeResult([{ critical: false, answer: "falla" }]), "observado");
    assert.equal(computeResult([{ critical: false, answer: "falla" }, { critical: true, answer: "falla" }]), "no_apto");
    assert.equal(computeResult([]), "apto");
  });

  it("numera CV-00001-2026", () => {
    assert.equal(formatChecklistNumber(2026, 1), "CV-00001-2026");
    assert.equal(formatChecklistNumber(2027, 12345), "CV-12345-2027");
  });

  it("la plantilla inicial nombra los documentos de cada país", () => {
    const cl = defaultTemplate("CL").map((i) => i.label);
    const pe = defaultTemplate("PE").map((i) => i.label);
    assert.ok(cl.includes("Seguro obligatorio (SOAP) vigente"));
    assert.ok(pe.includes("SOAT vigente"));
    const orden = defaultTemplate("CL").map((i) => i.sort_order);
    assert.deepEqual(orden, [...orden].sort((a, b) => a - b));
    assert.ok(defaultTemplate("CL").some((i) => i.critical));
  });
});

describe("flota — formulario y vencimientos", () => {
  it("normaliza la patente", () => {
    assert.equal(normalizePlate("ab-cd 12"), "ABCD12");
    assert.equal(normalizePlate("A1B-234"), "A1B234");
    assert.equal(normalizePlate("AB1"), null);
    assert.equal(normalizePlate("ABC$12"), null);
  });

  it("valida año, kilometraje y fechas", () => {
    const ok = normalizeVehicleInput({ plate: "abcd12", kind: "furgon", model_year: "2022", odometer_km: "120.500", insurance_due: "2027-03-31" });
    assert.equal(ok.ok, true);
    assert.equal(ok.values.plate, "ABCD12");
    assert.equal(ok.values.kind, "furgon");
    assert.equal(ok.values.odometer_km, 120500);
    assert.equal(ok.values.technical_review_due, null);

    const mal = normalizeVehicleInput({ plate: "x", model_year: "22", odometer_km: "12,5", insurance_due: "2027-02-30" });
    assert.equal(mal.ok, false);
    assert.deepEqual(Object.keys(mal.errors).sort(), ["insurance_due", "model_year", "odometer_km", "plate"]);
  });

  it("avisa documentos vencidos y por vencer (30 días)", () => {
    const alertas = documentAlerts(
      { technical_review_due: "2026-11-02", circulation_permit_due: "2026-12-01", insurance_due: "2027-06-01" },
      TODAY,
    );
    assert.deepEqual(alertas.map((a) => [a.label, a.state]), [
      ["Revisión técnica", "vencido"],
      ["Permiso de circulación", "por_vencer"],
    ]);
    assert.equal(vehicleLabel(VEHICLES[0]), "Toyota Hilux 2022");
  });
});

describe("checklist — validación del formulario", () => {
  it("acepta un checklist completo y congela los ítems", () => {
    const { ok, values } = normalizeChecklistInput(body(), ctx);
    assert.equal(ok, true);
    assert.equal(values.odometer_km, 45230);
    assert.equal(values.driver_user_id, 614793);
    assert.equal(values.driver_name, "Bastián Dummy");
    assert.equal(values.result, "apto");
    assert.deepEqual(values.answers.map((a) => [a.position, a.label, a.answer]), [
      [1, "Luces de freno", "ok"],
      [2, "Intermitentes", "ok"],
      [3, "Bocina", "na"],
    ]);
  });

  it("exige responder todo y describir cada falla", () => {
    const { ok, errors, values } = normalizeChecklistInput(
      body({ [answerKey(11)]: "falla", [answerKey(13)]: undefined }),
      ctx,
    );
    assert.equal(ok, false);
    assert.equal(errors[answerKey(11)], "Describe la falla.");
    assert.equal(errors[answerKey(13)], "Marca una opción.");
    assert.equal(errors.items, "Falta responder 1 ítem.");
    assert.equal(values.result, "no_apto");

    const descrita = normalizeChecklistInput(
      body({ [answerKey(12)]: "falla", [commentKey(12)]: "Intermitente izquierdo quemado" }),
      ctx,
    );
    assert.equal(descrita.ok, true);
    assert.equal(descrita.values.result, "observado");
  });

  it("rechaza fecha futura, kilometraje menor al registrado y falta de declaración", () => {
    const { errors } = normalizeChecklistInput(
      body({ inspection_date: "2026-11-04", odometer_km: "44000", declaro: undefined }),
      ctx,
    );
    assert.match(errors.inspection_date, /futura/);
    assert.match(errors.odometer_km, /menor al último registrado/);
    assert.ok(errors.declaro);
  });

  it("no acepta vehículos ni conductores fuera de la lista", () => {
    const { errors } = normalizeChecklistInput(body({ vehicle_id: "99", driver_user_id: "1" }), ctx);
    assert.ok(errors.vehicle_id);
    assert.ok(errors.driver_user_id);
  });

  it("permite escribir el nombre de un conductor externo", () => {
    const falta = normalizeChecklistInput(body({ driver_user_id: "otro" }), ctx);
    assert.ok(falta.errors.driver_name_other);
    const ok = normalizeChecklistInput(body({ driver_user_id: "otro", driver_name_other: "  Juan   Pérez " }), ctx);
    assert.equal(ok.ok, true);
    assert.equal(ok.values.driver_user_id, null);
    assert.equal(ok.values.driver_name, "Juan Pérez");
  });

  it("sin plantilla no se puede registrar", () => {
    const { errors } = normalizeChecklistInput(body(), { ...ctx, items: [] });
    assert.match(errors.items, /plantilla/);
  });

  it("valida los ítems de la plantilla", () => {
    assert.equal(normalizeItemInput({ category: "Luces", label: "Neblineros", critical: "1" }).values.critical, true);
    const mal = normalizeItemInput({ category: "", label: "", sort_order: "x" });
    assert.deepEqual(Object.keys(mal.errors).sort(), ["category", "label", "sort_order"]);
  });
});

describe("checklist — PDF", () => {
  const registro = {
    number: "CV-00001-2026",
    inspection_date: TODAY,
    inspection_kind: "salida",
    vehicle_plate: "ABCD12",
    vehicle_label: "Toyota Hilux 2022",
    odometer_km: 45230,
    fuel_level: "3/4",
    driver_name: "Bastián Dummy",
    result: "observado",
    observations: "Sin novedades.",
    status: "registered",
    created_by_name: "Bastián Dummy",
    created_at: new Date("2026-11-03T12:00:00Z"),
    answers: defaultTemplate("CL").map((item, i) => ({
      ...item,
      position: i + 1,
      answer: i === 3 ? "falla" : "ok",
      comment: i === 3 ? "Licencia vencida el mes pasado." : null,
    })),
  };

  it("genera un PDF", async () => {
    const pdf = await renderChecklistPdf(registro);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
  });

  it("un checklist anulado y largo también se imprime", async () => {
    const largo = {
      ...registro,
      status: "voided",
      void_reason: "Patente equivocada",
      voided_at: new Date(),
      answers: [...registro.answers, ...registro.answers, ...registro.answers],
    };
    const pdf = await renderChecklistPdf(largo);
    const paginas = pdf.toString("latin1").match(/\/Type \/Page\b/g) || [];
    assert.ok(paginas.length >= 2);
  });
});

describe("logística — schema y permisos", () => {
  it("el schema crea las cuatro tablas con RLS", () => {
    const sql = DDL_STATEMENTS.join("\n");
    for (const tabla of ["logistics_vehicles", "vehicle_checklist_items", "vehicle_checklists", "vehicle_checklist_answers"]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tabla}`));
      assert.match(sql, new RegExp(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY`));
    }
    assert.match(sql, /UNIQUE \(number_year, number_seq\)/);
  });

  it("el módulo existe en los dos países con sus permisos", () => {
    for (const country of ["CL", "PE"]) {
      assert.equal(isFeatureEnabled("logistics", country), true);
      for (const key of ["logistica.checklist.crear", "logistica.checklist.anular", "logistica.vehiculo.administrar", "logistica.plantilla.administrar"]) {
        assert.ok(getPermission(key, country), `${country} ${key}`);
      }
      assert.deepEqual(getPermission("logistica.checklist.ver", country).scopes, ["propio", "todo"]);
    }
  });
});
