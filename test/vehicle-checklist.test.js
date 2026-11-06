const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const {
  ANSWERS,
  VEHICLE_KINDS,
  isVehicleKind,
  computeResult,
  formatChecklistNumber,
  defaultTemplate,
  PROVISIONAL_TEMPLATE_LABELS,
} = require("../src/constants/vehicleChecklist");
const {
  normalizePlate,
  normalizeVehicleInput,
  documentAlerts,
  documentsFor,
  vehicleLabel,
} = require("../src/services/logistics/vehicleService");
const {
  normalizeChecklistInput,
  answerKey,
  commentKey,
} = require("../src/services/logistics/checklistService");
const {
  normalizeCategoryInput,
  normalizeItemInput,
  reorder,
} = require("../src/services/logistics/templateService");
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

  it("la plantilla inicial es la del «Check list diario» en papel", () => {
    const items = defaultTemplate();
    assert.equal(items.length, 52);
    assert.deepEqual([...new Set(items.map((i) => i.category))], [
      "Sistema de luces", "Sistema motor", "Frenos", "Neumáticos", "Carrocería y chasis",
      "Dirección", "Líquidos y filtros", "Transmisión", "Accesorios", "Implementos",
    ]);
    const labels = items.map((i) => i.label);
    assert.ok(labels.includes("Foco faenero"));
    assert.ok(labels.includes("Caja de herramientas Bauker (116 piezas)"));
    assert.equal(new Set(labels).size, labels.length, "sin ítems repetidos");
    const orden = items.map((i) => i.sort_order);
    assert.deepEqual(orden, [...orden].sort((a, b) => a - b));
    assert.ok(items.find((i) => i.label === "Frenos").critical);
    assert.equal(items.find((i) => i.label === "Antena radial").critical, false);
  });

  it("la plantilla provisoria no comparte el conjunto con la real", () => {
    // Si coincidieran, seedDefaultTemplate borraría la plantilla real.
    const reales = defaultTemplate().map((i) => i.label);
    assert.ok(reales.some((l) => !PROVISIONAL_TEMPLATE_LABELS.includes(l)));
  });

  it("las respuestas se leen Sí / No / N/A", () => {
    assert.deepEqual(ANSWERS.map((a) => [a.value, a.short]), [["ok", "Sí"], ["falla", "No"], ["na", "N/A"]]);
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
    const ok = normalizeVehicleInput({ plate: "abcd12", kind: "minivan", model_year: "2022", odometer_km: "120.500", insurance_due: "2027-03-31" });
    assert.equal(ok.ok, true);
    assert.equal(ok.values.plate, "ABCD12");
    assert.equal(ok.values.kind, "minivan");
    assert.equal(ok.values.odometer_km, 120500);
    assert.equal(ok.values.technical_review_due, null);

    const mal = normalizeVehicleInput({ plate: "x", model_year: "22", odometer_km: "12,5", insurance_due: "2027-02-30", gas_review_due: "ayer", next_maintenance_km: "diez" });
    assert.equal(mal.ok, false);
    assert.deepEqual(Object.keys(mal.errors).sort(), ["gas_review_due", "insurance_due", "kind", "model_year", "next_maintenance_km", "odometer_km", "plate"]);
    assert.equal(normalizeVehicleInput({ plate: "ABCD12", kind: "pickup", next_maintenance_km: "50.000" }).values.next_maintenance_km, 50000);
  });

  it("el tipo es minivan, camioneta pickup o camión, sin uno por defecto", () => {
    assert.deepEqual(VEHICLE_KINDS.map((k) => k.value), ["minivan", "pickup", "camion"]);
    for (const tipo of ["minivan", "pickup", "camion"]) {
      assert.equal(normalizeVehicleInput({ plate: "ABCD12", kind: tipo }).ok, true, tipo);
    }
    for (const viejo of ["", "camioneta", "furgon", "automovil", "otro"]) {
      const { errors } = normalizeVehicleInput({ plate: "ABCD12", kind: viejo });
      assert.equal(errors.kind, "Elige el tipo de vehículo.", viejo);
    }
    assert.equal(isVehicleKind("camion"), true);
    assert.equal(isVehicleKind("motocicleta"), false);
  });

  it("avisa documentos vencidos, por vencer (30 días) y la mantención (1.000 km)", () => {
    const alertas = documentAlerts(
      {
        technical_review_due: "2026-11-02",
        gas_review_due: "2026-11-20",
        circulation_permit_due: "2026-12-10",
        insurance_due: "2027-06-01",
        odometer_km: 49500,
        next_maintenance_km: 50000,
      },
      TODAY,
    );
    assert.deepEqual(alertas.map((a) => [a.label, a.state, a.detail]), [
      ["Revisión técnica", "vencido", "venció el 02/11/2026"],
      ["Revisión de gases", "por_vencer", "vence el 20/11/2026"],
      ["Mantención", "por_vencer", "a los 50.000 km"],
    ]);
    assert.equal(documentAlerts({ odometer_km: 50100, next_maintenance_km: 50000 }, TODAY)[0].state, "vencido");
    assert.equal(vehicleLabel(VEHICLES[0]), "Toyota Hilux 2022");
  });

  it("la revisión de gases sólo se pide en Chile", () => {
    assert.ok(documentsFor("CL").some((d) => d.field === "gas_review_due"));
    assert.ok(!documentsFor("PE").some((d) => d.field === "gas_review_due"));
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

  it("exige responder todo; la observación de un No es opcional", () => {
    const { ok, errors, values } = normalizeChecklistInput(
      body({ [answerKey(11)]: "falla", [answerKey(13)]: undefined }),
      ctx,
    );
    assert.equal(ok, false);
    assert.equal(errors[answerKey(11)], undefined, "un No sin observación vale");
    assert.equal(errors[answerKey(13)], "Marca Sí, No o N/A.");
    assert.equal(errors.items, "Falta responder 1 ítem.");
    assert.equal(values.result, "no_apto");

    const descrita = normalizeChecklistInput(
      body({ [answerKey(12)]: "falla", [commentKey(12)]: "Intermitente izquierdo quemado" }),
      ctx,
    );
    assert.equal(descrita.ok, true);
    assert.equal(descrita.values.result, "observado");
    assert.equal(descrita.values.answers[1].comment, "Intermitente izquierdo quemado");
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

  it("valida las categorías y los ítems de la plantilla", () => {
    assert.deepEqual(normalizeCategoryInput({ name: "  Sistema   eléctrico " }).values, { name: "Sistema eléctrico" });
    assert.ok(normalizeCategoryInput({ name: "   " }).errors.name);
    assert.deepEqual(normalizeItemInput({ label: "Neblineros", critical: "1" }).values, { label: "Neblineros", critical: true });
    assert.equal(normalizeItemInput({ label: "Neblineros" }).values.critical, false);
    assert.ok(normalizeItemInput({ label: "" }).errors.label);
  });

  it("subir o bajar mueve un lugar y no se sale de los extremos", () => {
    assert.deepEqual(reorder([1, 2, 3], 2, "arriba"), [2, 1, 3]);
    assert.deepEqual(reorder([1, 2, 3], 2, "abajo"), [1, 3, 2]);
    assert.deepEqual(reorder([1, 2, 3], 1, "arriba"), [1, 2, 3]);
    assert.deepEqual(reorder([1, 2, 3], 3, "abajo"), [1, 2, 3]);
    assert.deepEqual(reorder(["7", "9"], 9, "arriba"), ["9", "7"]);
    assert.equal(reorder([1, 2], 5, "arriba"), null);
    assert.equal(reorder([1, 2], 1, "costado"), null);
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
    technical_review_due: "2026-10-01",
    gas_review_due: "2027-01-15",
    insurance_due: "2027-03-31",
    next_maintenance_km: 50000,
    answers: defaultTemplate().map((item, i) => ({
      ...item,
      position: i + 1,
      answer: i === 5 ? "falla" : i === 40 ? "na" : "ok",
      comment: i === 5 ? "Foco faenero sin ampolleta." : null,
    })),
  };

  const paginas = (pdf) => (pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length;

  it("la planilla completa cabe en una hoja", async () => {
    const pdf = await renderChecklistPdf(registro);
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.equal(paginas(pdf), 1);
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
    assert.ok(paginas(pdf) >= 2);
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

  it("los vehículos de la primera versión pasan a los tipos nuevos", () => {
    const sql = DDL_STATEMENTS.join("\n");
    assert.match(sql, /WHEN 'camioneta' THEN 'pickup' WHEN 'furgon' THEN 'minivan'/);
    assert.match(sql, /ALTER COLUMN kind SET DEFAULT 'pickup'/);
  });
});

describe("Gestión de flota — direcciones de la primera versión", () => {
  const express = require("express");
  let server;
  let base;

  before(async () => {
    const app = express();
    // Sesión y permisos de prueba: las redirecciones no tocan la base.
    app.use((req, res, next) => {
      req.session = { user: { id: 1, active: true } };
      req.perms = { mode: "aplicar", can: () => true, canOnRecord: () => true };
      next();
    });
    app.use("/logistica", require("../src/routes/logistica"));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  const destino = async (path) => {
    const res = await fetch(base + path, { redirect: "manual" });
    return [res.status, res.headers.get("location")];
  };

  it("la flota y el checklist redirigen a Gestión de flota", async () => {
    assert.deepEqual(await destino("/logistica/vehiculos"), [301, "/logistica/flota"]);
    assert.deepEqual(await destino("/logistica/vehiculos/nuevo"), [301, "/logistica/flota/nuevo"]);
    assert.deepEqual(await destino("/logistica/vehiculos/7/editar"), [301, "/logistica/flota/7/editar"]);
    // El listado general ya no existe: lleva a Gestión de flota.
    assert.deepEqual(await destino("/logistica/checklists"), [301, "/logistica/flota"]);
    assert.deepEqual(await destino("/logistica/checklists?vehiculo=3"), [301, "/logistica/flota"]);
    assert.deepEqual(await destino("/logistica/flota/mecanica"), [301, "/logistica/flota"]);
    assert.deepEqual(await destino("/logistica/flota/7/historial"), [301, "/logistica/flota/7/revisiones"]);
    assert.deepEqual(await destino("/logistica/checklists/nuevo?vehiculo=3"), [301, "/logistica/flota/mecanica/nueva?vehiculo=3"]);
    assert.deepEqual(await destino("/logistica/checklists/plantilla"), [301, "/logistica/flota/mecanica/items"]);
    assert.deepEqual(await destino("/logistica/checklists/12"), [301, "/logistica/flota/mecanica/12"]);
    assert.deepEqual(await destino("/logistica/checklists/12/pdf"), [301, "/logistica/flota/mecanica/12/pdf"]);
  });
});
