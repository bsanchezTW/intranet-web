const db = require("../../db");
const {
  MAX_SEQ,
  MAX_STOPS,
  formatRouteSheetNumber,
  localityWithArticle,
  parseTime,
} = require("../../constants/routeSheet");
const { formatKm, formatChecklistNumber } = require("../../constants/vehicleChecklist");
const { cleanText, cleanMultiline, parseOptionalInt, isValidIsoDate, parseId } = require("./inputs");
const { vehicleLabel } = require("./vehicleService");
const { DRIVER_OTHER } = require("./checklistService");

/**
 * Hojas de ruta: la jornada de un vehículo con su conductor, su peoneta y
 * las paradas del día (cliente, comuna, guía de despacho, nota de venta y
 * horas), como la «Hoja de ruta» en papel.
 *
 * A diferencia de las revisiones, una hoja no se registra de una vez: se
 * abre en la mañana con el km inicial (HR-00001-2026), se le agregan
 * paradas durante el día y se cierra con el km final, que sube el
 * kilometraje de la flota. Mientras está abierta se corrige; cerrada ya no,
 * y si quedó mal se anula con motivo. Un vehículo no tiene dos hojas
 * abiertas a la vez.
 *
 * Las funciones normalize* son puras; el resto habla con Postgres. Quién
 * puede abrir, completar o cerrar cada hoja lo deciden las rutas.
 */

// Numeración de HR-…: 7215001 es letras, 7215002 la revisión mecánica y
// 7215004 la física.
const NUMBERING_LOCK_KEY = 7215003;
const LIST_LIMIT = 500;
const HELPER_NONE = "";

class RouteSheetError extends Error {
  constructor(message, code = "ROUTE_SHEET_INVALID") {
    super(message);
    this.code = code;
  }
}

/**
 * Una persona de la lista, un nombre a mano ("otro") o, si `optional`,
 * nadie. Deja en `values` <prefix>_user_id, <prefix>_name y lo elegido para
 * volver a mostrar el formulario.
 */
function readPerson(body, prefix, people, values, errors, { optional = false, missing }) {
  const raw = String(body[`${prefix}_user_id`] ?? "").trim();
  const other = cleanText(body[`${prefix}_name_other`], 160);
  values[`${prefix}_user_id`] = null;
  values[`${prefix}_choice`] = raw;
  values[`${prefix}_name_other`] = other;
  values[`${prefix}_name`] = "";

  if (raw === DRIVER_OTHER) {
    values[`${prefix}_name`] = other;
    if (!other) errors[`${prefix}_name_other`] = "Escribe el nombre.";
    return;
  }
  if (optional && raw === HELPER_NONE) return;

  const person = people.find((p) => Number(p.id) === parseId(raw));
  if (!person) {
    errors[`${prefix}_user_id`] = missing;
    return;
  }
  values[`${prefix}_user_id`] = Number(person.id);
  values[`${prefix}_name`] = person.name;
}

/**
 * Encabezado de la hoja, al abrirla o al corregirla mientras está abierta.
 * `vehicles` es la flota activa, `drivers` las personas elegibles, `today`
 * la fecha del país y `current` la hoja que se corrige (si no, se abre una).
 *
 * El km inicial no puede ser menor al último de la flota. Al corregir, si
 * no cambian ni el vehículo ni el km, no se vuelve a comparar: otra revisión
 * pudo subir el de la flota durante el día.
 */
function normalizeHeaderInput(body = {}, { vehicles = [], drivers = [], today, current = null } = {}) {
  const errors = {};
  const values = {};

  values.route_date = cleanText(body.route_date, 10) || today;
  if (!isValidIsoDate(values.route_date)) {
    errors.route_date = "Ingresa una fecha válida.";
  } else if (today && values.route_date > today) {
    errors.route_date = "La hoja no puede tener fecha futura.";
  }

  const vehicleId = parseId(body.vehicle_id);
  const vehicle = vehicles.find((v) => Number(v.id) === vehicleId) || null;
  values.vehicle_id = vehicle ? vehicleId : cleanText(body.vehicle_id, 15);
  if (!vehicle) errors.vehicle_id = "Elige el vehículo.";

  const km = parseOptionalInt(body.km_start);
  values.km_start = km.ok && km.value != null ? km.value : cleanText(body.km_start, 12);
  const sinCambios =
    current && vehicle && Number(current.vehicle_id) === vehicleId && Number(current.km_start) === km.value;
  if (!km.ok || km.value == null) {
    errors.km_start = "Ingresa el kilometraje inicial del tablero.";
  } else if (!sinCambios && vehicle && vehicle.odometer_km != null && km.value < Number(vehicle.odometer_km)) {
    errors.km_start = `Es menor al último registrado (${formatKm(vehicle.odometer_km)}). Si ese dato está mal, corrígelo en la flota.`;
  }

  readPerson(body, "driver", drivers, values, errors, { missing: "Elige al conductor." });
  readPerson(body, "helper", drivers, values, errors, { optional: true, missing: "Elige a la peoneta o deja «Sin peoneta»." });
  if (values.helper_user_id != null && values.helper_user_id === values.driver_user_id) {
    errors.helper_user_id = "La peoneta no puede ser el mismo conductor.";
  }

  values.observations = cleanMultiline(body.observations, 1000);
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

/**
 * Una parada: cliente y comuna obligatorios; guía, nota de venta, horas y
 * observación opcionales (no toda parada lleva documentos). Si están las
 * dos horas, la salida no puede ser antes de la llegada.
 */
function normalizeStopInput(body = {}) {
  const errors = {};
  const values = {};

  values.client_name = cleanText(body.client_name, 120);
  if (values.client_name.length < 2) errors.client_name = "Escribe el cliente.";

  values.locality = cleanText(body.locality, 80);
  if (!values.locality) errors.locality = `Escribe ${localityWithArticle()}.`;

  values.dispatch_guide = cleanText(body.dispatch_guide, 30);
  values.sales_note = cleanText(body.sales_note, 30);

  for (const field of ["arrived_at", "left_at"]) {
    const raw = cleanText(body[field], 8);
    const time = parseTime(raw);
    values[field] = time || raw;
    if (raw && !time) errors[field] = "Usa el formato 24 horas, por ejemplo 14:30.";
  }
  if (!errors.arrived_at && !errors.left_at && values.arrived_at && values.left_at && values.left_at < values.arrived_at) {
    errors.left_at = "La salida no puede ser antes de la llegada.";
  }

  values.observations = cleanText(body.observations, 300);
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

/**
 * Cierre: el km final (no menor al inicial) y la observación de la
 * jornada. `sheet` es la hoja abierta y `stopCount` sus paradas: sin
 * paradas no se cierra.
 */
function normalizeCloseInput(body = {}, { sheet, stopCount = 0 } = {}) {
  const errors = {};
  const values = {};

  const km = parseOptionalInt(body.km_end);
  values.km_end = km.ok && km.value != null ? km.value : cleanText(body.km_end, 12);
  if (!km.ok || km.value == null) {
    errors.km_end = "Ingresa el kilometraje final del tablero.";
  } else if (sheet && km.value < Number(sheet.km_start)) {
    errors.km_end = `Es menor al inicial (${formatKm(sheet.km_start)}).`;
  }

  if (!stopCount) errors.stops = "Agrega al menos una parada antes de cerrar la hoja.";

  values.observations = cleanMultiline(body.observations ?? (sheet && sheet.observations), 1000);
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

function withNumber(row) {
  return row ? { ...row, number: formatRouteSheetNumber(row.number_year, row.number_seq) } : row;
}

// ---------------------------------------------------------------------------
// Base de datos: abrir y corregir
// ---------------------------------------------------------------------------

async function userDisplayName(queryable, userId) {
  const { rows } = await queryable.query(
    "SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM users WHERE id = $1",
    [userId],
  );
  return (rows[0] && rows[0].name) || "Usuario de la intranet";
}

async function inTransaction(fn) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505" && /uq_route_sheets_open_vehicle/.test(err.constraint || err.message)) {
      throw new RouteSheetError("Ese vehículo ya tiene una hoja abierta.", "ROUTE_SHEET_OPEN_VEHICLE");
    }
    if (err.code === "23505") {
      throw new RouteSheetError("Ese número acaba de usarse. Vuelve a intentarlo.", "ROUTE_SHEET_NUMBER");
    }
    throw err;
  } finally {
    client.release();
  }
}

/** El vehículo activo, bloqueado; la patente y la descripción se congelan de aquí. */
async function lockVehicle(client, vehicleId) {
  const { rows } = await client.query(
    "SELECT id, plate, brand, model, model_year, active FROM logistics_vehicles WHERE id = $1 FOR UPDATE",
    [vehicleId],
  );
  const vehicle = rows[0];
  if (!vehicle || !vehicle.active) {
    throw new RouteSheetError("El vehículo ya no está activo en la flota.", "ROUTE_SHEET_VEHICLE");
  }
  return vehicle;
}

/** Avisa con el número si el vehículo ya tiene otra hoja abierta. */
async function assertNoOtherOpen(client, vehicleId, exceptId = null) {
  const { rows } = await client.query(
    `SELECT number_year, number_seq FROM route_sheets
      WHERE vehicle_id = $1 AND status = 'open' AND ($2::bigint IS NULL OR id <> $2)
      LIMIT 1`,
    [vehicleId, exceptId],
  );
  if (rows[0]) {
    const number = formatRouteSheetNumber(rows[0].number_year, rows[0].number_seq);
    throw new RouteSheetError(
      `Ese vehículo ya tiene abierta la ${number}: ciérrala o anúlala antes de abrir otra.`,
      "ROUTE_SHEET_OPEN_VEHICLE",
    );
  }
}

/** La hoja abierta, bloqueada para el resto de la transacción. */
async function lockOpenSheet(client, sheetId) {
  const { rows } = await client.query(
    "SELECT id, number_year, number_seq, km_start, status FROM route_sheets WHERE id = $1 FOR UPDATE",
    [sheetId],
  );
  const sheet = rows[0];
  if (!sheet) throw new RouteSheetError("La hoja de ruta no existe.", "ROUTE_SHEET_NOT_FOUND");
  if (sheet.status !== "open") {
    throw new RouteSheetError("La hoja ya está cerrada o anulada: no se puede cambiar.", "ROUTE_SHEET_NOT_OPEN");
  }
  return sheet;
}

/**
 * Abre una hoja con el número siguiente del año de su fecha. `values` es la
 * salida de normalizeHeaderInput con ok = true.
 */
async function openRouteSheet(values, userId) {
  const year = Number(values.route_date.slice(0, 4));
  return inTransaction(async (client) => {
    await client.query("SELECT pg_advisory_xact_lock($1)", [NUMBERING_LOCK_KEY]);
    const vehicle = await lockVehicle(client, values.vehicle_id);
    await assertNoOtherOpen(client, vehicle.id);

    const { rows: seqRows } = await client.query(
      "SELECT COALESCE(MAX(number_seq), 0) + 1 AS next FROM route_sheets WHERE number_year = $1",
      [year],
    );
    const seq = Number(seqRows[0].next);
    if (seq > MAX_SEQ) throw new RouteSheetError(`La numeración de ${year} supera ${MAX_SEQ}.`, "ROUTE_SHEET_NUMBER");

    const signer = await userDisplayName(client, userId);
    const { rows } = await client.query(
      `INSERT INTO route_sheets (
         number_year, number_seq, route_date, vehicle_id, vehicle_plate, vehicle_label,
         driver_user_id, driver_name, helper_user_id, helper_name, km_start, observations,
         created_by, created_by_name
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING id`,
      [
        year,
        seq,
        values.route_date,
        vehicle.id,
        vehicle.plate,
        vehicleLabel(vehicle) || null,
        values.driver_user_id,
        values.driver_name,
        values.helper_user_id,
        values.helper_name || null,
        values.km_start,
        values.observations || null,
        userId ?? null,
        signer,
      ],
    );
    return { id: Number(rows[0].id), number: formatRouteSheetNumber(year, seq) };
  });
}

/**
 * Corrige el encabezado de una hoja abierta. El número no cambia aunque
 * cambie el año de la fecha: es el que se le dio al abrirla.
 */
async function updateRouteSheet(sheetId, values) {
  return inTransaction(async (client) => {
    const sheet = await lockOpenSheet(client, sheetId);
    const vehicle = await lockVehicle(client, values.vehicle_id);
    await assertNoOtherOpen(client, vehicle.id, sheet.id);
    await client.query(
      `UPDATE route_sheets
          SET route_date = $2, vehicle_id = $3, vehicle_plate = $4, vehicle_label = $5,
              driver_user_id = $6, driver_name = $7, helper_user_id = $8, helper_name = $9,
              km_start = $10, observations = $11, updated_at = NOW()
        WHERE id = $1`,
      [
        sheet.id,
        values.route_date,
        vehicle.id,
        vehicle.plate,
        vehicleLabel(vehicle) || null,
        values.driver_user_id,
        values.driver_name,
        values.helper_user_id,
        values.helper_name || null,
        values.km_start,
        values.observations || null,
      ],
    );
    return withNumber(sheet);
  });
}

// ---------------------------------------------------------------------------
// Base de datos: paradas
// ---------------------------------------------------------------------------

function stopParams(values) {
  return [
    values.client_name,
    values.locality,
    values.dispatch_guide || null,
    values.sales_note || null,
    values.arrived_at || null,
    values.left_at || null,
    values.observations || null,
  ];
}

async function touch(client, sheetId) {
  await client.query("UPDATE route_sheets SET updated_at = NOW() WHERE id = $1", [sheetId]);
}

/** Agrega una parada al final. Devuelve su id y posición. */
async function addStop(sheetId, values, userId) {
  return inTransaction(async (client) => {
    const sheet = await lockOpenSheet(client, sheetId);
    const { rows: countRows } = await client.query(
      "SELECT COUNT(*)::int AS n FROM route_sheet_stops WHERE sheet_id = $1",
      [sheet.id],
    );
    const n = countRows[0].n;
    if (n >= MAX_STOPS) {
      throw new RouteSheetError(`Una hoja tiene hasta ${MAX_STOPS} paradas: abre otra para seguir.`, "ROUTE_SHEET_STOPS");
    }
    const { rows } = await client.query(
      `INSERT INTO route_sheet_stops (
         sheet_id, position, client_name, locality, dispatch_guide, sales_note,
         arrived_at, left_at, observations, created_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING id`,
      [sheet.id, n + 1, ...stopParams(values), userId ?? null],
    );
    await touch(client, sheet.id);
    return { id: Number(rows[0].id), position: n + 1 };
  });
}

/** Corrige una parada de una hoja abierta. false si la parada no es de la hoja. */
async function updateStop(sheetId, stopId, values) {
  return inTransaction(async (client) => {
    const sheet = await lockOpenSheet(client, sheetId);
    const { rowCount } = await client.query(
      `UPDATE route_sheet_stops
          SET client_name = $3, locality = $4, dispatch_guide = $5, sales_note = $6,
              arrived_at = $7, left_at = $8, observations = $9, updated_at = NOW()
        WHERE id = $2 AND sheet_id = $1`,
      [sheet.id, stopId, ...stopParams(values)],
    );
    if (rowCount) await touch(client, sheet.id);
    return rowCount > 0;
  });
}

/** Renumera 1..n en el orden actual (la restricción se valida al COMMIT). */
async function renumber(client, sheetId) {
  await client.query(
    `UPDATE route_sheet_stops s
        SET position = o.n
       FROM (SELECT id, ROW_NUMBER() OVER (ORDER BY position, id) AS n
               FROM route_sheet_stops WHERE sheet_id = $1) o
      WHERE s.id = o.id AND s.position <> o.n`,
    [sheetId],
  );
}

/** Quita una parada y corre las siguientes. false si no es de la hoja. */
async function removeStop(sheetId, stopId) {
  return inTransaction(async (client) => {
    const sheet = await lockOpenSheet(client, sheetId);
    const { rowCount } = await client.query(
      "DELETE FROM route_sheet_stops WHERE id = $2 AND sheet_id = $1",
      [sheet.id, stopId],
    );
    if (!rowCount) return false;
    await renumber(client, sheet.id);
    await touch(client, sheet.id);
    return true;
  });
}

/**
 * Sube (-1) o baja (+1) una parada un lugar; en los extremos no hace nada.
 * false si la parada no es de la hoja.
 */
async function moveStop(sheetId, stopId, direction) {
  const step = direction < 0 ? -1 : 1;
  return inTransaction(async (client) => {
    const sheet = await lockOpenSheet(client, sheetId);
    const { rows } = await client.query(
      "SELECT id, position FROM route_sheet_stops WHERE sheet_id = $1 ORDER BY position",
      [sheet.id],
    );
    const index = rows.findIndex((r) => Number(r.id) === Number(stopId));
    if (index === -1) return false;
    const other = rows[index + step];
    if (!other) return true;
    await client.query(
      `UPDATE route_sheet_stops
          SET position = CASE id WHEN $2 THEN $5::smallint WHEN $3 THEN $4::smallint END
        WHERE sheet_id = $1 AND id IN ($2, $3)`,
      [sheet.id, rows[index].id, other.id, rows[index].position, other.position],
    );
    await touch(client, sheet.id);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Base de datos: cerrar y anular
// ---------------------------------------------------------------------------

/**
 * Cierra la hoja con el km final y sube el kilometraje de la flota (que
 * sólo avanza). Vuelve a validar dentro de la transacción: el km inicial o
 * las paradas pudieron cambiar desde que se mostró el formulario.
 */
async function closeRouteSheet(sheetId, values, userId) {
  return inTransaction(async (client) => {
    const sheet = await lockOpenSheet(client, sheetId);
    const { rows: countRows } = await client.query(
      "SELECT COUNT(*)::int AS n FROM route_sheet_stops WHERE sheet_id = $1",
      [sheet.id],
    );
    const check = normalizeCloseInput(
      { km_end: String(values.km_end), observations: values.observations },
      { sheet, stopCount: countRows[0].n },
    );
    if (!check.ok) throw new RouteSheetError(Object.values(check.errors)[0], "ROUTE_SHEET_CLOSE");

    const { rows } = await client.query(
      `UPDATE route_sheets
          SET status = 'closed', km_end = $2, observations = $3,
              closed_at = NOW(), closed_by = $4, updated_at = NOW()
        WHERE id = $1
        RETURNING vehicle_id`,
      [sheet.id, check.values.km_end, check.values.observations || null, userId ?? null],
    );
    await client.query(
      `UPDATE logistics_vehicles
          SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2), updated_at = NOW()
        WHERE id = $1`,
      [rows[0].vehicle_id, check.values.km_end],
    );
    return withNumber(sheet);
  });
}

/**
 * Anula una hoja abierta o cerrada. null si no existe o ya estaba anulada.
 * El kilometraje que subió a la flota no se devuelve: la flota se corrige
 * en su ficha.
 */
async function voidRouteSheet(sheetId, reason, userId) {
  const motivo = cleanText(reason, 300);
  if (motivo.length < 5) throw new RouteSheetError("Explica en pocas palabras por qué se anula.", "ROUTE_SHEET_VOID_REASON");
  const { rows } = await db.query(
    `UPDATE route_sheets
        SET status = 'voided', void_reason = $2, voided_at = NOW(), voided_by = $3, updated_at = NOW()
      WHERE id = $1 AND status IN ('open', 'closed')
      RETURNING id, number_year, number_seq`,
    [sheetId, motivo, userId ?? null],
  );
  return rows[0] ? withNumber(rows[0]) : null;
}

// ---------------------------------------------------------------------------
// Base de datos: consultas
// ---------------------------------------------------------------------------

const COLUMNS = `
  h.id, h.number_year, h.number_seq, h.route_date::text AS route_date,
  h.vehicle_id, h.vehicle_plate, h.vehicle_label,
  h.driver_user_id, h.driver_name, h.helper_user_id, h.helper_name,
  h.km_start, h.km_end, h.observations, h.status,
  h.closed_at, h.void_reason, h.voided_at,
  h.created_by, h.created_by_name, h.created_at, h.updated_at,
  NULLIF(TRIM(CONCAT_WS(' ', cu.first_name, cu.last_name)), '') AS closed_by_name,
  NULLIF(TRIM(CONCAT_WS(' ', vu.first_name, vu.last_name)), '') AS voided_by_name`;

const JOINS = `
  LEFT JOIN users cu ON cu.id = h.closed_by
  LEFT JOIN users vu ON vu.id = h.voided_by`;

const STATUS_FILTERS = ["open", "closed", "voided"];

/**
 * Listado: las abiertas primero y después por fecha. `scope` es el filtro
 * del permiso de ver ({ clause, params }, con $1… propios), que arman las
 * rutas sobre las columnas de h.
 */
async function listRouteSheets({ q = "", estado = "", desde = "", hasta = "", vehiculo = null, scope } = {}) {
  const params = [];
  const where = [];
  const add = (value) => {
    params.push(value);
    return `$${params.length}`;
  };

  if (scope) {
    const offset = params.length;
    where.push(scope.clause.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`));
    params.push(...scope.params);
  }

  const term = cleanText(q, 80);
  if (term) {
    const like = add(`%${term.replace(/[%_\\]/g, "\\$&")}%`);
    const plate = add(term.toUpperCase().replace(/[\s.\-]/g, ""));
    where.push(`(h.vehicle_plate LIKE '%' || ${plate} || '%'
                 OR h.driver_name ILIKE ${like}
                 OR h.helper_name ILIKE ${like}
                 OR ('HR-' || LPAD(h.number_seq::text, 5, '0') || '-' || h.number_year) ILIKE ${like}
                 OR EXISTS (SELECT 1 FROM route_sheet_stops s
                             WHERE s.sheet_id = h.id
                               AND (s.client_name ILIKE ${like} OR s.locality ILIKE ${like}
                                    OR s.dispatch_guide ILIKE ${like} OR s.sales_note ILIKE ${like})))`);
  }
  if (STATUS_FILTERS.includes(estado)) where.push(`h.status = ${add(estado)}`);
  if (isValidIsoDate(desde)) where.push(`h.route_date >= ${add(desde)}::date`);
  if (isValidIsoDate(hasta)) where.push(`h.route_date <= ${add(hasta)}::date`);
  if (vehiculo) where.push(`h.vehicle_id = ${add(vehiculo)}`);

  const { rows } = await db.query(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*)::int FROM route_sheet_stops s WHERE s.sheet_id = h.id) AS stop_count
       FROM route_sheets h
       ${JOINS}
      WHERE ${where.length ? where.join(" AND ") : "TRUE"}
      ORDER BY (h.status = 'open') DESC, h.route_date DESC, h.id DESC
      LIMIT ${LIST_LIMIT}`,
    params,
  );
  return rows.map(withNumber);
}

/** La hoja con sus paradas en orden; null si no existe. */
async function getRouteSheet(sheetId) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM route_sheets h ${JOINS} WHERE h.id = $1`,
    [sheetId],
  );
  if (!rows[0]) return null;
  const { rows: stops } = await db.query(
    `SELECT id, position, client_name, locality, dispatch_guide, sales_note,
            to_char(arrived_at, 'HH24:MI') AS arrived_at, to_char(left_at, 'HH24:MI') AS left_at,
            observations
       FROM route_sheet_stops
      WHERE sheet_id = $1
      ORDER BY position`,
    [sheetId],
  );
  return { ...withNumber(rows[0]), stops: stops.map((s) => ({ ...s, id: Number(s.id) })) };
}

// ---------------------------------------------------------------------------
// Base de datos: ayudas del formulario
// ---------------------------------------------------------------------------

const SUGGESTION_DAYS = 365;

/**
 * Lo escrito antes, para sugerirlo al agregar una parada: los clientes del
 * último año (los más visitados primero) con la comuna de su última visita,
 * y las comunas por uso. Las hojas anuladas no cuentan. Un cliente escrito
 * de varias formas ("Cliente Uno", "cliente uno") se sugiere con la más
 * usada; si empatan, con la primera.
 */
async function stopSuggestions() {
  const [clientes, comunas] = await Promise.all([
    db.query(
      `WITH s AS (
         SELECT s.id, s.client_name, s.locality, s.created_at, LOWER(s.client_name) AS k
           FROM route_sheet_stops s
           JOIN route_sheets h ON h.id = s.sheet_id
          WHERE h.status <> 'voided' AND s.created_at > NOW() - make_interval(days => $1)
       ),
       visitas AS (SELECT k, COUNT(*) AS n FROM s GROUP BY k),
       nombre AS (
         SELECT DISTINCT ON (k) k, client_name
           FROM s GROUP BY k, client_name
          ORDER BY k, COUNT(*) DESC, MIN(created_at)
       ),
       ultima AS (SELECT DISTINCT ON (k) k, locality FROM s ORDER BY k, created_at DESC, id DESC)
       SELECT nombre.client_name, ultima.locality
         FROM visitas JOIN nombre USING (k) JOIN ultima USING (k)
        ORDER BY visitas.n DESC, nombre.client_name
        LIMIT 300`,
      [SUGGESTION_DAYS],
    ),
    db.query(
      `SELECT MIN(s.locality) AS locality
         FROM route_sheet_stops s
         JOIN route_sheets h ON h.id = s.sheet_id
        WHERE h.status <> 'voided' AND s.created_at > NOW() - make_interval(days => $1)
        GROUP BY LOWER(s.locality)
        ORDER BY COUNT(*) DESC, MIN(s.locality)
        LIMIT 150`,
      [SUGGESTION_DAYS],
    ),
  ]);
  return {
    clients: clientes.rows.map((r) => ({ name: r.client_name, locality: r.locality })),
    localities: comunas.rows.map((r) => r.locality),
  };
}

/**
 * La revisión mecánica del vehículo en la fecha de la hoja (la última si
 * hubo varias), o null. Sólo para avisar: la hoja se abre igual.
 */
async function dailyChecklist(vehicleId, routeDate) {
  const { rows } = await db.query(
    `SELECT id, number_year, number_seq, inspection_kind, result
       FROM vehicle_checklists
      WHERE vehicle_id = $1 AND inspection_date = $2::date AND status = 'registered'
      ORDER BY created_at DESC, id DESC
      LIMIT 1`,
    [vehicleId, routeDate],
  );
  const r = rows[0];
  return r ? { id: Number(r.id), number: formatChecklistNumber(r.number_year, r.number_seq), kind: r.inspection_kind, result: r.result } : null;
}

module.exports = {
  DRIVER_OTHER,
  HELPER_NONE,
  LIST_LIMIT,
  RouteSheetError,
  normalizeHeaderInput,
  normalizeStopInput,
  normalizeCloseInput,
  openRouteSheet,
  updateRouteSheet,
  addStop,
  updateStop,
  removeStop,
  moveStop,
  closeRouteSheet,
  voidRouteSheet,
  listRouteSheets,
  getRouteSheet,
  stopSuggestions,
  dailyChecklist,
};
