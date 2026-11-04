const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const ejs = require("ejs");
const C = require("../src/constants/vehicleChecklist");
const P = require("../src/constants/vehiclePhysical");
const { modelFor, GROUPS } = require("../src/constants/vehicleZones");
const {
  normalizePhysicalInput,
  normalizeRepairInput,
  damageKey,
} = require("../src/services/logistics/physicalService");
const { processImage, PhotoError, MAX_EDGE, isOwnPath } = require("../src/services/logistics/damagePhotos");
const { renderPhysicalPdf } = require("../src/services/logistics/physicalPdf");
const { DDL_STATEMENTS } = require("../src/services/logistics/logisticsSchema");
const { getPermission } = require("../src/services/permissions/catalog");
const vehicles = require("../src/services/logistics/vehicleService");
const { getCountryConfig } = require("../src/config/country");

const TODAY = "2026-11-04";
const VEHICULO = { id: 7, plate: "ABCD12", kind: "pickup", active: true, odometer_km: 45000, brand: "Mitsubishi", model: "L200", model_year: 2022 };
const ZONAS = modelFor("pickup").zones;
const ZONA = ZONAS[0];
const DRIVERS = [{ id: 5, name: "Bastián Dummy" }];

const base = (extra = {}) => ({
  review_date: TODAY,
  reason: "incidente",
  odometer_km: "45.230",
  driver_user_id: "5",
  observations: "Golpe en el estacionamiento.",
  declaro: "1",
  ...extra,
});

const validar = (body, { damages = [], photoCounts = [], vehicle = VEHICULO } = {}) =>
  normalizePhysicalInput(body, { vehicle, zones: ZONAS, drivers: DRIVERS, today: TODAY, damages, photoCounts });

describe("revisión física — catálogos, numeración y aviso", () => {
  it("numera RF-00001-AAAA", () => {
    assert.equal(P.formatPhysicalNumber(2026, 1), "RF-00001-2026");
    assert.equal(P.formatPhysicalNumber(2027, 12345), "RF-12345-2027");
  });

  it("avisa «pendiente» si nunca se hizo o pasaron más de 30 días", () => {
    assert.equal(P.physicalReviewAlert(null, TODAY).state, "pendiente");
    assert.equal(P.physicalReviewAlert("2026-10-05", TODAY), null, "30 días justos: al día");
    const aviso = P.physicalReviewAlert("2026-10-04", TODAY);
    assert.equal(aviso.state, "pendiente");
    assert.match(aviso.detail, /31 días/);
  });

  it("los tipos de daño son abolladura, rayón, parte rota y otro", () => {
    assert.deepEqual(P.DAMAGE_TYPES.map((t) => t.value), ["abolladura", "rayon", "rotura", "otro"]);
    assert.equal(P.damageTypeLabel("rotura"), "Parte rota");
    assert.equal(P.reasonLabel("incidente"), "Después de un incidente");
  });
});

describe("revisión física — validación", () => {
  it("acepta una revisión sin daños nuevos", () => {
    const { ok, values, errors } = validar(base());
    assert.equal(ok, true, JSON.stringify(errors));
    assert.equal(values.odometer_km, 45230);
    assert.equal(values.driver_name, "Bastián Dummy");
    assert.equal(values.vehicle_kind, "pickup");
    assert.deepEqual(values.damages, []);
  });

  it("acepta daños con zona del modelo, tipo, observación y fotos", () => {
    const { ok, values, errors } = validar(base(), {
      damages: [{ zone: ZONA.code, type: "rayon", description: "  Rayón   largo bajo la manilla " }],
      photoCounts: [2],
    });
    assert.equal(ok, true, JSON.stringify(errors));
    assert.deepEqual(values.damages[0], {
      position: 1,
      zone_code: ZONA.code,
      zone_label: ZONA.label,
      zone_group: ZONA.group,
      damage_type: "rayon",
      description: "Rayón largo bajo la manilla",
      photo_count: 2,
    });
  });

  it("cada daño exige zona válida, tipo, observación y de 1 a 4 fotos", () => {
    const { ok, errors } = validar(base(), {
      damages: [
        { zone: "no-existe", type: "rayon", description: "algo" },
        { zone: ZONA.code, type: "pintura", description: "algo" },
        { zone: ZONA.code, type: "rayon", description: "x" },
        { zone: ZONA.code, type: "rayon", description: "sin fotos" },
        { zone: ZONA.code, type: "rayon", description: "muchas fotos" },
      ],
      photoCounts: [1, 1, 1, 0, 5],
    });
    assert.equal(ok, false);
    assert.match(errors[damageKey(0)], /zona/);
    assert.match(errors[damageKey(1)], /tipo/);
    assert.match(errors[damageKey(2)], /Describe/);
    assert.match(errors[damageKey(3)], /al menos una foto/);
    assert.match(errors[damageKey(4)], /4 fotos como máximo/);
  });

  it("limita los daños nuevos por revisión", () => {
    const damages = Array.from({ length: P.MAX_DAMAGES + 1 }, () => ({ zone: ZONA.code, type: "rayon", description: "rayón" }));
    const { errors } = validar(base(), { damages, photoCounts: damages.map(() => 1) });
    assert.match(errors.danios, new RegExp(`${P.MAX_DAMAGES} daños`));
  });

  it("revisa fecha, motivo, kilometraje, conductor y declaración", () => {
    const { errors } = validar({ review_date: "2026-12-01", reason: "x", odometer_km: "100", driver_user_id: "99" });
    assert.match(errors.review_date, /futura/);
    assert.match(errors.reason, /motivo/);
    assert.match(errors.odometer_km, /menor al último/);
    assert.match(errors.driver_user_id, /conductor/);
    assert.match(errors.declaro, /por fuera/);
  });

  it("acepta un conductor escrito a mano y rechaza un vehículo dado de baja", () => {
    const otro = validar(base({ driver_user_id: "otro", driver_name_other: "Juan Externo" }));
    assert.equal(otro.ok, true);
    assert.equal(otro.values.driver_user_id, null);
    assert.equal(otro.values.driver_name, "Juan Externo");
    const baja = validar(base(), { vehicle: { ...VEHICULO, active: false } });
    assert.match(baja.errors.general, /dado de baja/);
  });
});

describe("reparación — validación", () => {
  const reparar = (body, photoCount = 1) => normalizeRepairInput(body, { today: TODAY, reportedOn: "2026-10-20", photoCount });

  it("acepta fecha, observación y fotos", () => {
    const { ok, values } = reparar({ repaired_on: "2026-11-01", repair_note: "Desabollado y pintura" });
    assert.equal(ok, true);
    assert.equal(values.repaired_on, "2026-11-01");
  });

  it("la fecha va entre el registro del daño y hoy, y la foto es obligatoria", () => {
    assert.match(reparar({ repaired_on: "2026-10-01", repair_note: "ok ok" }).errors.repaired_on, /anterior/);
    assert.match(reparar({ repaired_on: "2026-11-30", repair_note: "ok ok" }).errors.repaired_on, /futura/);
    assert.match(reparar({ repaired_on: TODAY, repair_note: "x" }).errors.repair_note, /qué se hizo/);
    assert.match(reparar({ repaired_on: TODAY, repair_note: "listo" }, 0).errors.fotos, /al menos una foto/);
    assert.match(reparar({ repaired_on: TODAY, repair_note: "listo" }, 5).errors.fotos, /4 fotos/);
  });
});

/** Un JPEG o PNG de prueba con @napi-rs/canvas. */
function imagenDePrueba(w, h, tipo = "image/png") {
  const { createCanvas } = require("@napi-rs/canvas");
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#26388f";
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = "#d64545";
  ctx.fillRect(w / 4, h / 4, w / 2, h / 2);
  return canvas.toBuffer(tipo);
}

describe("fotos — reducción en el servidor", () => {
  it("vuelve a codificar como JPEG y reduce al máximo por lado", async () => {
    const out = await processImage(imagenDePrueba(3200, 1800));
    assert.equal(out.width, MAX_EDGE);
    assert.equal(out.height, 900);
    assert.equal(out.buffer.subarray(0, 3).toString("hex"), "ffd8ff", "es JPEG");
  });

  it("no agranda las fotos chicas", async () => {
    const out = await processImage(imagenDePrueba(640, 480));
    assert.deepEqual([out.width, out.height], [640, 480]);
  });

  it("rechaza lo que no es una imagen", async () => {
    await assert.rejects(processImage(Buffer.from("no soy una foto")), PhotoError);
  });

  it("sólo reconoce las rutas de Logística", () => {
    assert.equal(isOwnPath("logistica/fisicas/2026/x/danio-1-1.jpg"), true);
    assert.equal(isOwnPath("gastos/2026/1/x.jpg"), false);
    assert.equal(isOwnPath(null), false);
  });
});

function reviewDePrueba(extra = {}) {
  const danio = (id, status = "abierto") => ({
    id,
    zone_code: ZONA.code,
    zone_label: ZONA.label,
    zone_group: ZONA.group,
    damage_type: "abolladura",
    description: "Abolladura de 10 cm en el borde, sin pintura saltada.",
    status,
    repaired_on: status === "reparado" ? "2026-11-02" : null,
    repair_note: status === "reparado" ? "Desabollado en taller." : null,
    repaired_by_name: status === "reparado" ? "Logística" : null,
    review_number: "RF-00001-2026",
    review_date: "2026-10-20",
    damage_photos: [{ id: id * 10 + 1, kind: "danio" }, { id: id * 10 + 2, kind: "danio" }],
    repair_photos: [],
  });
  return {
    id: 2,
    number: "RF-00002-2026",
    review_date: TODAY,
    reason: "incidente",
    vehicle_id: 7,
    vehicle_plate: "ABCD12",
    vehicle_label: "Mitsubishi L200 2022",
    vehicle_kind: "pickup",
    odometer_km: 45230,
    driver_name: "Bastián Dummy",
    observations: "Golpe en el estacionamiento.",
    captures: { izquierdo: "logistica/fisicas/2026/x/captura-izquierdo.jpg" },
    status: "registered",
    created_by: 1,
    created_by_name: "Bastián Sánchez",
    created_at: new Date("2026-11-04T15:00:00Z"),
    damages: [danio(1), danio(2, "reparado")],
    previous: [{ ...danio(3), review_number: "RF-00001-2026" }],
    ...extra,
  };
}

describe("revisión física — PDF", () => {
  it("arma el PDF con capturas, daños y fotos, aunque falten imágenes", async () => {
    const foto = (await processImage(imagenDePrueba(800, 600))).buffer;
    const pdf = await renderPhysicalPdf(reviewDePrueba(), {
      captures: { izquierdo: foto },
      photos: new Map([["11", foto], ["12", foto]]),
    });
    assert.equal(pdf.subarray(0, 5).toString(), "%PDF-");
    assert.ok(pdf.length > 5000);
  });

  it("pasa a otra hoja con muchos daños y marca la anulada", async () => {
    const r = reviewDePrueba({ status: "voided", void_reason: "Patente equivocada", voided_at: new Date() });
    r.damages = Array.from({ length: 12 }, (_, i) => ({ ...r.damages[0], id: 100 + i }));
    const pdf = await renderPhysicalPdf(r, {});
    const paginas = (pdf.toString("latin1").match(/\/Type \/Page\b/g) || []).length;
    assert.ok(paginas >= 3, `páginas: ${paginas}`);
  });
});

describe("revisión física — schema y permisos", () => {
  it("crea revisiones, daños y fotos con RLS y sus reglas", () => {
    const sql = DDL_STATEMENTS.join("\n");
    for (const tabla of ["vehicle_physical_reviews", "vehicle_damages", "vehicle_damage_photos"]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${tabla}`));
      assert.match(sql, new RegExp(`ALTER TABLE ${tabla} ENABLE ROW LEVEL SECURITY`));
    }
    assert.match(sql, /status IN \('abierto','reparado','anulado'\)/);
    assert.match(sql, /kind IN \('danio','reparacion'\)/);
    assert.match(sql, /reason IN \('incidente','periodica','otra'\)/);
  });

  it("tiene permisos propios: ver (lo propio o todo), registrar, anular y reparar", () => {
    for (const country of ["CL", "PE"]) {
      for (const key of ["logistica.fisica.crear", "logistica.fisica.anular", "logistica.danio.reparar"]) {
        assert.ok(getPermission(key, country), `${country} ${key}`);
      }
      assert.deepEqual(getPermission("logistica.fisica.ver", country).scopes, ["propio", "todo"]);
    }
  });
});

describe("revisión física — vistas", () => {
  const VIEWS = path.join(__dirname, "..", "src", "views", "logistica", "flota");
  const locals = (extra) => ({
    country: "CL",
    countryConfig: getCountryConfig(),
    success: null,
    error: null,
    ...C,
    ...P,
    labelFrom: C.labelFrom,
    formatDate: (v) => (v ? String(v).slice(0, 10).split("-").reverse().join("/") : "—"),
    resultLabel: (r) => r,
    vehicleLabel: vehicles.vehicleLabel,
    documentAlerts: vehicles.documentAlerts,
    documentsFor: vehicles.documentsFor,
    FLOTA: "/logistica/flota",
    MECANICA: "/logistica/flota/mecanica",
    ITEMS: "/logistica/flota/mecanica/items",
    FISICA: "/logistica/flota/fisica",
    DANIOS: "/logistica/flota/danios",
    FOTOS: "/logistica/flota/fotos",
    ...extra,
  });
  const permisos = {
    puedeAdministrar: true, puedeRevisar: true, puedeRevisarFisica: true, puedeVerMecanicas: true,
    puedeVerFisicas: true, puedeVerDanios: true, puedeReparar: true, puedeVerRevisiones: true, puedePlantilla: true,
  };
  const render = (vista, datos) => ejs.renderFile(path.join(VIEWS, vista), locals(datos));

  it("la página de revisión física muestra los daños abiertos y el formulario", async () => {
    const r = reviewDePrueba();
    const html = await render("fisica.ejs", {
      vehiculo: VEHICULO, modelo: modelFor("pickup"), grupos: GROUPS, abiertos: r.previous,
      conductores: DRIVERS, driverOther: "otro", today: TODAY, values: { review_date: TODAY }, ...permisos,
    });
    assert.match(html, /data-fisica-form/);
    assert.match(html, /Daños abiertos/);
    assert.match(html, /\/logistica\/flota\/fotos\/31/);
    assert.match(html, new RegExp(`data-zona="${ZONA.code}"[^>]*data-estado="danio"`));
    const json = html.match(/id="fisicaDatos">([^<]*)<\/script>/);
    assert.ok(json, "los datos de la página van en un JSON sin '<'");
    assert.equal(JSON.parse(json[1]).abiertos[0].fotos.length, 2);
  });

  it("quien sólo mira no ve el formulario", async () => {
    const html = await render("fisica.ejs", {
      vehiculo: VEHICULO, modelo: modelFor("pickup"), grupos: GROUPS, abiertos: [],
      conductores: [], driverOther: "otro", today: TODAY, values: {},
      ...permisos, puedeRevisarFisica: false,
    });
    assert.doesNotMatch(html, /data-fisica-form/);
    assert.doesNotMatch(html, /data-danio-form/);
  });

  it("el detalle, el daño y las listas de revisiones se arman", async () => {
    const r = reviewDePrueba();
    const detalle = await render("fisica/detalle.ejs", { review: r, captureViews: P.CAPTURE_VIEWS, puedeAnular: true, puedeReparar: true });
    assert.match(detalle, /RF-00002-2026/);
    assert.match(detalle, /\/logistica\/flota\/fisica\/2\/captura\/izquierdo/);
    assert.match(detalle, /Daños que ya estaban abiertos/);

    const abierto = await render("danio.ejs", { damage: { ...r.damages[0], vehicle_id: 7, vehicle_plate: "ABCD12", review_id: 2, reported_by_name: "Bastián" }, values: {}, errors: {}, today: TODAY, puedeReparar: true, puedeVerSuRevision: true });
    assert.match(abierto, /data-reparar-form/);
    const reparado = await render("danio.ejs", { damage: { ...r.damages[1], vehicle_id: 7, vehicle_plate: "ABCD12", review_id: 2, reported_by_name: "Bastián" }, values: {}, errors: {}, today: TODAY, puedeReparar: true, puedeVerSuRevision: false });
    assert.doesNotMatch(reparado, /data-reparar-form/);
    assert.match(reparado, /Desabollado en taller/);

    const listas = await render("partials/revisiones_listas.ejs", {
      vehiculo: VEHICULO, mecanicas: [], compacto: true, ...permisos,
      fisicas: [{ id: 2, number: "RF-00002-2026", review_date: TODAY, driver_name: "B", odometer_km: 1, status: "registered", danios: 2 }],
      danios: [...r.damages, ...r.previous],
    });
    assert.match(listas, /2 daños nuevos/);
    assert.match(listas, /2 daños abiertos/);
  });
});

describe("historial del vehículo — una pestaña por tipo", () => {
  const VIEWS = path.join(__dirname, "..", "src", "views", "logistica", "flota");
  const r = reviewDePrueba();
  const mecanica = (id, fecha, result, status = "registered") => ({
    id, number: C.formatChecklistNumber(Number(fecha.slice(0, 4)), id), inspection_date: fecha, inspection_kind: "salida",
    driver_name: "B", odometer_km: 40000 + id, result, status, fallas: result === "apto" ? 0 : 1,
  });
  const base = {
    country: "CL", countryConfig: getCountryConfig(), success: null, error: null, ...C, ...P,
    formatDate: (v) => (v ? String(v).slice(0, 10).split("-").reverse().join("/") : "—"),
    resultLabel: (x) => x, vehicleLabel: vehicles.vehicleLabel, documentAlerts: vehicles.documentAlerts,
    documentsFor: vehicles.documentsFor, VEHICLE_FIELDS: vehicles.VEHICLE_FIELDS,
    FLOTA: "/logistica/flota", MECANICA: "/logistica/flota/mecanica", FISICA: "/logistica/flota/fisica",
    DANIOS: "/logistica/flota/danios", FOTOS: "/logistica/flota/fotos",
    vehiculo: { ...VEHICULO, id: 7 }, today: TODAY,
    mecanicas: [mecanica(3, "2026-11-01", "no_apto"), mecanica(2, "2026-06-01", "apto"), mecanica(1, "2025-12-01", "apto", "voided")],
    fisicas: [{ id: 2, number: "RF-00002-2026", review_date: TODAY, reason: "periodica", driver_name: "B", odometer_km: 45230, status: "registered", danios: 0 }],
    danios: [...r.damages, { ...r.damages[0], id: 50, status: "anulado" }],
    visibles: ["mecanicas", "fisicas", "danios", "kilometraje", "ficha"], puedeVerFicha: true,
    lecturas: [], resumenKm: null, cambios: [], cambiosTotal: 0,
    puedeAdministrar: true, puedeRevisar: true, puedeRevisarFisica: true, puedeVerMecanicas: true, puedeVerFisicas: true, puedeVerDanios: true,
  };
  const render = (extra) => ejs.renderFile(path.join(VIEWS, "revisiones.ejs"), { ...base, ...extra });

  it("mecánicas: sólo las mecánicas, agrupadas por año, con su resumen", async () => {
    const html = await render({ ver: "mecanicas" });
    assert.match(html, /aria-current="page"[^>]*>[\s\S]*?Mecánicas/);
    assert.match(html, /historial-anio__titulo"><span>2026<\/span>/);
    assert.match(html, /historial-anio__titulo"><span>2025<\/span>/);
    assert.doesNotMatch(html, /RF-00002-2026/, "no mezcla las físicas");
    assert.match(html, /<strong>2<\/strong><span>revisiones<\/span>/, "las anuladas no cuentan");
  });

  it("físicas y daños van en sus propias pestañas", async () => {
    const fis = await render({ ver: "fisicas" });
    assert.match(fis, /RF-00002-2026/);
    assert.doesNotMatch(fis, /CV-00003-2026/);
    const dan = await render({ ver: "danios" });
    assert.match(dan, /<span>Abiertos<\/span>/);
    assert.match(dan, /<span>Reparados<\/span>/);
    assert.match(dan, /<span>Anulados<\/span>/);
  });

  it("kilometraje: resumen, datos del gráfico y tabla", async () => {
    const lecturas = [
      { date: "2026-09-01", km: 40000, source: "ficha", ref_id: 1 },
      { date: "2026-10-01", km: 42000, source: "mecanica", ref_id: 2, year: 2026, seq: 7 },
      { date: TODAY, km: 44500, source: "fisica", ref_id: 3, year: 2026, seq: 2 },
    ];
    const html = await render({ ver: "kilometraje", lecturas, resumenKm: vehicles.kmSummary(lecturas, TODAY) });
    const datos = JSON.parse(html.match(/id="kmDatos">([^<]*)<\/script>/)[1]);
    assert.equal(datos.length, 3);
    assert.equal(datos[1].numero, "CV-00007-2026");
    assert.equal(datos[2].numero, "RF-00002-2026");
    assert.match(html, /Corrección en la ficha/);
  });

  it("ficha: muestra cada cambio con antes y después", async () => {
    const html = await render({
      ver: "ficha",
      cambiosTotal: 1,
      cambios: [{ id: 1, action: "editado", changed_by_name: "Logística", changed_at: new Date(), changes: [{ field: "insurance_due", from: "2025-11-20", to: "2026-11-20" }, { field: "kind", from: "minivan", to: "pickup" }] }],
    });
    assert.match(html, /Editó la ficha/);
    assert.match(html, /Seguro obligatorio/);
    assert.match(html, /20\/11\/2025/);
    assert.match(html, /Camioneta pickup/);
  });

  it("sin permiso de ver la flota no aparecen kilometraje ni ficha", async () => {
    const html = await render({ ver: "mecanicas", visibles: ["mecanicas", "fisicas"], puedeVerFicha: false });
    assert.doesNotMatch(html, /ver=kilometraje/);
    assert.doesNotMatch(html, /ver=ficha/);
  });
});

describe("ficha del vehículo — cambios y kilometraje", () => {
  it("diffVehicle registra sólo lo que cambió, sin confundir vacío con nulo", () => {
    const antes = { plate: "ABCD12", kind: "pickup", brand: "Toyota", model: "", model_year: 2022, odometer_km: "45000", insurance_due: "2026-11-20", notes: null };
    const despues = { plate: "ABCD12", kind: "pickup", brand: "Toyota", model: null, model_year: 2022, odometer_km: 45200, insurance_due: "2027-11-20", notes: "" };
    assert.deepEqual(vehicles.diffVehicle(antes, despues), [
      { field: "odometer_km", from: 45000, to: 45200 },
      { field: "insurance_due", from: "2026-11-20", to: "2027-11-20" },
    ]);
    assert.deepEqual(vehicles.diffVehicle(antes, antes), []);
  });

  it("al crear, los cambios son los valores iniciales", () => {
    const cambios = vehicles.diffVehicle({}, { plate: "ABCD12", kind: "minivan", brand: "", model_year: null });
    assert.deepEqual(cambios, [{ field: "plate", from: null, to: "ABCD12" }, { field: "kind", from: null, to: "minivan" }]);
  });

  it("kmSummary: última lectura, últimos 30 días y promedio mensual", () => {
    const s = vehicles.kmSummary([
      { date: "2026-08-06", km: 40000 },
      { date: "2026-10-01", km: 42000 },
      { date: "2026-11-04", km: 43000 },
    ], TODAY);
    assert.equal(s.last.km, 43000);
    assert.equal(s.lastMonth, 1000, "desde la lectura anterior a hace 30 días");
    assert.equal(s.perMonth, Math.round((3000 / 90) * 30));
    assert.equal(vehicles.kmSummary([], TODAY), null);
    assert.equal(vehicles.kmSummary([{ date: TODAY, km: 5 }], TODAY).perMonth, null, "con una lectura no hay promedio");
  });

  it("el schema guarda el historial de la ficha con RLS", () => {
    const sql = DDL_STATEMENTS.join("\n");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS logistics_vehicle_changes/);
    assert.match(sql, /action IN \('creado','editado','baja','reactivado'\)/);
    assert.match(sql, /ALTER TABLE logistics_vehicle_changes ENABLE ROW LEVEL SECURITY/);
  });
});
