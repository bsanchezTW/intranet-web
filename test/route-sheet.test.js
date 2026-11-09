const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const {
  MAX_STOPS,
  formatRouteSheetNumber,
  statusLabel,
  localityLabel,
  localityWithArticle,
  parseTime,
  formatTime,
} = require("../src/constants/routeSheet");
const {
  DRIVER_OTHER,
  normalizeHeaderInput,
  normalizeStopInput,
  normalizeCloseInput,
} = require("../src/services/logistics/routeSheetService");
const { DDL_STATEMENTS } = require("../src/services/logistics/logisticsSchema");
const { getPermission } = require("../src/services/permissions/catalog");
const migrations = require("../src/migrations");

const TODAY = "2026-10-30";
const VEHICLES = [
  { id: 7, plate: "ABCD12", odometer_km: 98376, brand: "Chevrolet", model: "NPR", model_year: 2020 },
  { id: 8, plate: "EFGH34", odometer_km: null, brand: "Maxus", model: "eDeliver 3", model_year: 2023 },
];
const DRIVERS = [
  { id: 614793, name: "Bastián Dummy" },
  { id: 614794, name: "Peoneta Dummy" },
];

function header(overrides = {}) {
  return {
    route_date: TODAY,
    vehicle_id: "7",
    km_start: "98.376",
    driver_user_id: "614793",
    helper_user_id: "614794",
    observations: "",
    ...overrides,
  };
}

const ctx = (extra = {}) => ({ vehicles: VEHICLES, drivers: DRIVERS, today: TODAY, ...extra });

describe("hojas de ruta — numeración, estados y horas", () => {
  it("numera HR-00001-2026", () => {
    assert.equal(formatRouteSheetNumber(2026, 1), "HR-00001-2026");
    assert.equal(formatRouteSheetNumber(2026, 12345), "HR-12345-2026");
  });

  it("los estados se leen En ruta, Cerrada y Anulada", () => {
    assert.equal(statusLabel("open"), "En ruta");
    assert.equal(statusLabel("closed"), "Cerrada");
    assert.equal(statusLabel("voided"), "Anulada");
  });

  it("la comuna es distrito en Perú", () => {
    assert.equal(localityLabel("CL"), "Comuna");
    assert.equal(localityLabel("PE"), "Distrito");
    assert.equal(localityWithArticle("CL"), "la comuna");
    assert.equal(localityWithArticle("PE"), "el distrito");
  });

  it("lee horas como en el papel y rechaza las imposibles", () => {
    assert.equal(parseTime("10:10"), "10:10");
    assert.equal(parseTime("9:05"), "09:05");
    assert.equal(parseTime("0905"), "09:05");
    assert.equal(parseTime("13.25"), "13:25");
    assert.equal(parseTime("15:20:00"), "15:20");
    assert.equal(parseTime("24:00"), null);
    assert.equal(parseTime("10:60"), null);
    assert.equal(parseTime("diez"), null);
    assert.equal(formatTime(null), "—");
    assert.equal(formatTime("08:30:00"), "08:30");
  });
});

describe("hojas de ruta — encabezado", () => {
  it("acepta una hoja completa con conductor y peoneta", () => {
    const r = normalizeHeaderInput(header(), ctx());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.values.km_start, 98376);
    assert.equal(r.values.driver_user_id, 614793);
    assert.equal(r.values.driver_name, "Bastián Dummy");
    assert.equal(r.values.helper_user_id, 614794);
    assert.equal(r.values.helper_name, "Peoneta Dummy");
  });

  it("la peoneta es opcional y puede escribirse a mano", () => {
    const sin = normalizeHeaderInput(header({ helper_user_id: "" }), ctx());
    assert.equal(sin.ok, true);
    assert.equal(sin.values.helper_user_id, null);
    assert.equal(sin.values.helper_name, "");

    const otra = normalizeHeaderInput(header({ helper_user_id: DRIVER_OTHER, helper_name_other: "  Juan   Externo " }), ctx());
    assert.equal(otra.ok, true);
    assert.equal(otra.values.helper_name, "Juan Externo");

    const vacia = normalizeHeaderInput(header({ helper_user_id: DRIVER_OTHER }), ctx());
    assert.ok(vacia.errors.helper_name_other);
  });

  it("exige conductor, y que no sea también la peoneta", () => {
    assert.ok(normalizeHeaderInput(header({ driver_user_id: "" }), ctx()).errors.driver_user_id);
    assert.ok(normalizeHeaderInput(header({ driver_user_id: "999" }), ctx()).errors.driver_user_id);
    assert.ok(normalizeHeaderInput(header({ helper_user_id: "614793" }), ctx()).errors.helper_user_id);
    const externo = normalizeHeaderInput(header({ driver_user_id: DRIVER_OTHER, driver_name_other: "Conductor Externo" }), ctx());
    assert.equal(externo.ok, true);
    assert.equal(externo.values.driver_user_id, null);
  });

  it("rechaza fecha futura, vehículos fuera de la flota y km menor al registrado", () => {
    assert.ok(normalizeHeaderInput(header({ route_date: "2026-10-31" }), ctx()).errors.route_date);
    assert.ok(normalizeHeaderInput(header({ route_date: "2026-02-30" }), ctx()).errors.route_date);
    assert.ok(normalizeHeaderInput(header({ vehicle_id: "99" }), ctx()).errors.vehicle_id);
    assert.match(normalizeHeaderInput(header({ km_start: "98000" }), ctx()).errors.km_start, /menor al último/);
    assert.ok(normalizeHeaderInput(header({ km_start: "" }), ctx()).errors.km_start);
    assert.ok(normalizeHeaderInput(header({ km_start: "-5" }), ctx()).errors.km_start);
    // Sin kilometraje en la flota, cualquiera sirve.
    assert.equal(normalizeHeaderInput(header({ vehicle_id: "8", km_start: "10" }), ctx()).ok, true);
  });

  it("al corregir, el mismo vehículo y km no se comparan de nuevo con la flota", () => {
    // Otra revisión subió la flota a 98.500 durante el día.
    const flota = [{ ...VEHICLES[0], odometer_km: 98500 }];
    const current = { vehicle_id: 7, km_start: 98376 };
    assert.equal(normalizeHeaderInput(header(), ctx({ vehicles: flota, current })).ok, true);
    assert.ok(normalizeHeaderInput(header({ km_start: "98377" }), ctx({ vehicles: flota, current })).errors.km_start);
    assert.ok(normalizeHeaderInput(header(), ctx({ vehicles: flota })).errors.km_start);
  });
});

describe("hojas de ruta — paradas", () => {
  it("cliente y comuna obligatorios; documentos y horas opcionales", () => {
    const r = normalizeStopInput({ client_name: "Cliente Uno", locality: "Renca" });
    assert.equal(r.ok, true);
    assert.equal(r.values.arrived_at, "");
    assert.equal(r.values.dispatch_guide, "");

    const vacia = normalizeStopInput({});
    assert.ok(vacia.errors.client_name);
    assert.equal(vacia.errors.locality, "Escribe la comuna.");
  });

  it("normaliza las horas y la salida no va antes de la llegada", () => {
    const r = normalizeStopInput({
      client_name: "Cliente Uno",
      locality: "Maipú",
      dispatch_guide: " 52763 ",
      sales_note: "21866",
      arrived_at: "9:55",
      left_at: "1030",
    });
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    assert.equal(r.values.arrived_at, "09:55");
    assert.equal(r.values.left_at, "10:30");
    assert.equal(r.values.dispatch_guide, "52763");

    assert.ok(normalizeStopInput({ client_name: "Cliente", locality: "Renca", arrived_at: "14:30", left_at: "14:00" }).errors.left_at);
    assert.ok(normalizeStopInput({ client_name: "Cliente", locality: "Renca", arrived_at: "25:00" }).errors.arrived_at);
    // Llegada sin salida (la última parada del papel) es válida.
    assert.equal(normalizeStopInput({ client_name: "Cliente", locality: "Renca", arrived_at: "15:20" }).ok, true);
  });
});

describe("hojas de ruta — cierre", () => {
  const sheet = { km_start: 98376, observations: "Sin observaciones" };

  it("cierra con km final y al menos una parada", () => {
    const r = normalizeCloseInput({ km_end: "98.530" }, { sheet, stopCount: 6 });
    assert.equal(r.ok, true);
    assert.equal(r.values.km_end, 98530);
    // Sin observación nueva conserva la de la hoja.
    assert.equal(r.values.observations, "Sin observaciones");
  });

  it("no cierra con km menor al inicial, sin km o sin paradas", () => {
    assert.match(normalizeCloseInput({ km_end: "98000" }, { sheet, stopCount: 1 }).errors.km_end, /menor al inicial/);
    assert.ok(normalizeCloseInput({ km_end: "" }, { sheet, stopCount: 1 }).errors.km_end);
    assert.ok(normalizeCloseInput({ km_end: "98530" }, { sheet, stopCount: 0 }).errors.stops);
  });

  it(`una hoja admite hasta ${MAX_STOPS} paradas`, () => {
    assert.ok(MAX_STOPS >= 10, "al menos las 10 filas del papel");
  });
});

describe("hojas de ruta — schema, permisos y migración", () => {
  const sql = DDL_STATEMENTS.join("\n");

  it("crea la hoja y sus paradas con RLS", () => {
    for (const table of ["route_sheets", "route_sheet_stops"]) {
      assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table} \\(`));
      assert.match(sql, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
    }
  });

  it("un vehículo no tiene dos hojas abiertas y las paradas se pueden reordenar", () => {
    assert.match(sql, /UNIQUE INDEX IF NOT EXISTS uq_route_sheets_open_vehicle\s+ON route_sheets \(vehicle_id\) WHERE status = 'open'/);
    assert.match(sql, /UNIQUE \(sheet_id, position\) DEFERRABLE INITIALLY DEFERRED/);
  });

  it("los permisos existen en los dos países; ver distingue lo propio de todo", () => {
    for (const country of ["CL", "PE"]) {
      for (const key of ["ver", "crear", "administrar", "anular"]) {
        assert.ok(getPermission(`logistica.hoja_ruta.${key}`, country), `${country} ${key}`);
      }
      assert.deepEqual(getPermission("logistica.hoja_ruta.ver", country).scopes, ["propio", "todo"]);
    }
  });

  it("la migración pasa a «todo» lo que se concedió sin alcance", async () => {
    const migration = migrations.find((m) => m.id === "007_route_sheet_view_scope");
    assert.ok(migration);
    const calls = [];
    const client = {
      async query(text, params) {
        calls.push(text.replace(/\s+/g, " ").trim());
        if (/to_regclass/.test(text)) return { rows: [{ a: true, s: true }] };
        if (/^UPDATE perm_assignments/.test(text.trim())) return { rowCount: 2, rows: [] };
        if (/^UPDATE perm_set_items/.test(text.trim())) return { rowCount: 1, rows: [] };
        assert.ok(!params || params.every((p) => typeof p === "string"));
        return { rowCount: 0, rows: [] };
      },
    };
    await migration.up(client);
    assert.ok(calls.some((q) => /UPDATE perm_assignments SET scope = 'todo'.*effect = 'concede'/.test(q)));
    assert.ok(calls.some((q) => /DELETE FROM perm_set_items/.test(q)));
    assert.ok(calls.some((q) => /INSERT INTO perm_audit/.test(q)));
    assert.ok(calls.some((q) => /UPDATE perm_meta/.test(q)));
  });

  it("en una base desde cero la migración no toca nada", async () => {
    const migration = migrations.find((m) => m.id === "007_route_sheet_view_scope");
    const calls = [];
    await migration.up({
      async query(text) {
        calls.push(text);
        return { rows: [{ a: false, s: false }], rowCount: 0 };
      },
    });
    assert.equal(calls.length, 1);
  });
});

describe("hojas de ruta — quién ve, completa y anula", () => {
  const access = require("../src/services/logistics/routeSheetAccess");
  const { KEYS } = access;

  // Permisos de prueba: `keys` las que tiene y `todo` si ver alcanza a todas.
  function perms(keys, { todo = false } = {}) {
    const set = new Set(keys);
    return {
      can: (key) => set.has(key),
      canOnRecord: (key) => set.has(key),
      coverage: (key) => (key === KEYS.VER && set.has(key) ? { all: todo, own: !todo, areaIds: [] } : null),
    };
  }
  const YO = 10;
  const ajena = { id: 1, status: "open", created_by: 99, driver_user_id: 98, helper_user_id: null };
  const comoConductor = { ...ajena, driver_user_id: YO };
  const comoPeoneta = { ...ajena, helper_user_id: YO };
  const abiertaPorMi = { ...ajena, created_by: YO };

  it("lo propio es lo que abrí o donde voy de conductor o peoneta", () => {
    assert.equal(access.esPropia(ajena, YO), false);
    assert.equal(access.esPropia(comoConductor, YO), true);
    assert.equal(access.esPropia(comoPeoneta, String(YO)), true);
    assert.equal(access.esPropia(abiertaPorMi, YO), true);
  });

  it("ver lo propio no muestra las ajenas; ver todo o administrar, sí", () => {
    const propio = perms([KEYS.VER]);
    assert.equal(access.canView(propio, YO, ajena), false);
    assert.equal(access.canView(propio, YO, comoPeoneta), true);
    assert.equal(access.canView(perms([KEYS.VER], { todo: true }), YO, ajena), true);
    assert.equal(access.canView(perms([KEYS.ADMINISTRAR]), YO, ajena), true);
    assert.equal(access.canView(perms([]), YO, comoConductor), false);
  });

  it("el listado filtra por las tres columnas de lo propio", () => {
    const propio = access.listScope(perms([KEYS.CREAR]), YO);
    assert.match(propio.clause, /h\.created_by = \$1 OR h\.driver_user_id = \$1 OR h\.helper_user_id = \$1/);
    assert.deepEqual(propio.params, [YO]);
    assert.deepEqual(access.listScope(perms([KEYS.ADMINISTRAR]), YO), { clause: "TRUE", params: [] });
    assert.deepEqual(access.listScope(perms([KEYS.VER], { todo: true }), YO), { clause: "TRUE", params: [] });
    assert.equal(access.listScope(perms([KEYS.ANULAR]), YO).clause, "FALSE");
  });

  it("crear completa las propias abiertas; administrar, cualquiera abierta", () => {
    const crear = perms([KEYS.CREAR]);
    assert.equal(access.canEdit(crear, YO, comoConductor), true);
    assert.equal(access.canEdit(crear, YO, ajena), false);
    assert.equal(access.canEdit(perms([KEYS.VER], { todo: true }), YO, comoConductor), false, "ver no completa");
    assert.equal(access.canEdit(perms([KEYS.ADMINISTRAR]), YO, ajena), true);
    assert.equal(access.canEdit(perms([KEYS.ADMINISTRAR]), YO, { ...ajena, status: "closed" }), false);
  });

  it("anular pide el permiso y poder ver la hoja; una anulada no se vuelve a anular", () => {
    assert.equal(access.canVoid(perms([KEYS.ANULAR, KEYS.VER], { todo: true }), YO, { ...ajena, status: "closed" }), true);
    assert.equal(access.canVoid(perms([KEYS.ANULAR]), YO, ajena), false);
    assert.equal(access.canVoid(perms([KEYS.ANULAR, KEYS.CREAR]), YO, abiertaPorMi), true);
    assert.equal(access.canVoid(perms([KEYS.ANULAR, KEYS.ADMINISTRAR]), YO, { ...ajena, status: "voided" }), false);
  });

  it("botones del módulo según los permisos", () => {
    assert.deepEqual(access.accessFor(perms([KEYS.VER])), {
      entra: true, veTodas: false, puedeAbrir: false, puedeAdministrar: false, puedeAnular: false,
    });
    assert.equal(access.accessFor(perms([KEYS.CREAR])).puedeAbrir, true);
    assert.equal(access.accessFor(perms([KEYS.ANULAR])).entra, false);
  });
});
