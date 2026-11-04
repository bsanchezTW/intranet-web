const db = require("../../db");
const { isVehicleKind, formatKm } = require("../../constants/vehicleChecklist");
const { toDateOnly, addDays, formatDisplay } = require("../../utils/vacationDateUtils");
const { cleanText, parseOptionalInt, parseOptionalDate } = require("./inputs");
const { getCountryConfig } = require("../../config/country");

/**
 * Flota de Logística: la usan el checklist y las hojas de ruta.
 *
 * normalizeVehicleInput y documentAlerts son puras para probarlas sin base;
 * el resto habla con Postgres.
 */

/** Días de anticipación con que un documento del vehículo se marca "por vencer". */
const DUE_SOON_DAYS = 30;
/** Kilómetros de anticipación para avisar la próxima mantención. */
const MAINTENANCE_SOON_KM = 1000;

/**
 * Documentos con vencimiento, como en el encabezado de la planilla. La
 * revisión de gases es chilena (`countries`); en Perú no se pide.
 */
const VEHICLE_DOCUMENTS = Object.freeze([
  { field: "technical_review_due", label: "Revisión técnica" },
  { field: "gas_review_due", label: "Revisión de gases", countries: ["CL"] },
  { field: "circulation_permit_due", label: "Permiso de circulación" },
  { field: "insurance_due", label: "Seguro obligatorio" },
]);

/** Documentos que se piden en el país. */
function documentsFor(countryCode) {
  const code = String(countryCode || "").toUpperCase();
  return VEHICLE_DOCUMENTS.filter((d) => !d.countries || d.countries.includes(code));
}

class VehicleInputError extends Error {
  constructor(message, field = "plate") {
    super(message);
    this.code = "VEHICLE_INVALID";
    this.field = field;
  }
}

/** Patente sin espacios, puntos ni guiones, en mayúsculas. null si no calza. */
function normalizePlate(value) {
  const plate = String(value ?? "").toUpperCase().replace(/[\s.\-·]/g, "");
  return /^[A-Z0-9]{5,8}$/.test(plate) ? plate : null;
}

/** Valida el formulario de un vehículo. Devuelve { values, errors, ok }. */
function normalizeVehicleInput(body = {}) {
  const errors = {};
  const values = {};

  const plate = normalizePlate(body.plate);
  values.plate = plate || cleanText(body.plate, 12);
  if (!plate) errors.plate = "Ingresa la patente: de 5 a 8 letras y números.";

  // El tipo define el modelo de la revisión física: no hay uno por defecto.
  values.kind = isVehicleKind(body.kind) ? body.kind : "";
  if (!values.kind) errors.kind = "Elige el tipo de vehículo.";
  values.brand = cleanText(body.brand, 60);
  values.model = cleanText(body.model, 60);
  values.notes = cleanText(body.notes, 300);

  const year = parseOptionalInt(body.model_year);
  values.model_year = year.value;
  if (!year.ok || (year.value != null && (year.value < 1950 || year.value > 2100))) {
    values.model_year = cleanText(body.model_year, 4);
    errors.model_year = "Ingresa un año de 4 dígitos.";
  }

  const km = parseOptionalInt(body.odometer_km);
  values.odometer_km = km.value;
  if (!km.ok) {
    values.odometer_km = cleanText(body.odometer_km, 12);
    errors.odometer_km = "Ingresa el kilometraje en números enteros.";
  }

  const next = parseOptionalInt(body.next_maintenance_km);
  values.next_maintenance_km = next.value;
  if (!next.ok) {
    values.next_maintenance_km = cleanText(body.next_maintenance_km, 12);
    errors.next_maintenance_km = "Ingresa el kilometraje en números enteros.";
  }

  for (const { field } of VEHICLE_DOCUMENTS) {
    const date = parseOptionalDate(body[field]);
    values[field] = date.value;
    if (!date.ok) {
      values[field] = cleanText(body[field], 10);
      errors[field] = "Fecha inválida.";
    }
  }

  return { values, errors, ok: Object.keys(errors).length === 0 };
}

function displayDate(iso) {
  return formatDisplay(iso).replace(/-/g, "/");
}

/**
 * Documentos vencidos o por vencer y mantención cercana de un vehículo, para
 * avisar en la flota y en el checklist:
 *   [{ label, state: 'vencido' | 'por_vencer', detail, due? }]
 * `detail` es el texto corto que acompaña la etiqueta ("venció el 30/10/2026").
 */
function documentAlerts(vehicle, today) {
  const soon = addDays(today, DUE_SOON_DAYS);
  const alerts = [];
  if (!vehicle) return alerts;
  for (const { field, label } of VEHICLE_DOCUMENTS) {
    const due = toDateOnly(vehicle[field]);
    if (!due) continue;
    if (due < today) alerts.push({ label, due, state: "vencido", detail: `venció el ${displayDate(due)}` });
    else if (due <= soon) alerts.push({ label, due, state: "por_vencer", detail: `vence el ${displayDate(due)}` });
  }
  const next = vehicle.next_maintenance_km == null ? null : Number(vehicle.next_maintenance_km);
  const km = vehicle.odometer_km == null ? null : Number(vehicle.odometer_km);
  if (next != null && km != null) {
    if (km >= next) alerts.push({ label: "Mantención", state: "vencido", detail: `tocaba a los ${formatKm(next)}` });
    else if (next - km <= MAINTENANCE_SOON_KM) alerts.push({ label: "Mantención", state: "por_vencer", detail: `a los ${formatKm(next)}` });
  }
  return alerts;
}

/** "Toyota Hilux 2022" */
function vehicleLabel(vehicle) {
  if (!vehicle) return "";
  return [vehicle.brand, vehicle.model, vehicle.model_year].filter(Boolean).join(" ");
}

// ---------------------------------------------------------------------------
// Base de datos
// ---------------------------------------------------------------------------

const COLUMNS = `
  v.id, v.plate, v.kind, v.brand, v.model, v.model_year, v.odometer_km,
  v.technical_review_due::text AS technical_review_due,
  v.gas_review_due::text AS gas_review_due,
  v.circulation_permit_due::text AS circulation_permit_due,
  v.insurance_due::text AS insurance_due,
  v.next_maintenance_km,
  v.notes, v.active, v.created_at, v.updated_at`;

async function listVehicles({ includeInactive = true } = {}) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS},
            ult.id AS last_checklist_id,
            ult.inspection_date::text AS last_checklist_date,
            ult.result AS last_checklist_result,
            ult.number_year AS last_checklist_year,
            ult.number_seq AS last_checklist_seq,
            (SELECT COUNT(*)::int FROM vehicle_checklists c
              WHERE c.vehicle_id = v.id AND c.status = 'registered') AS checklists_count,
            (SELECT MAX(r.review_date)::text FROM vehicle_physical_reviews r
              WHERE r.vehicle_id = v.id AND r.status = 'registered') AS last_physical_date,
            (SELECT COUNT(*)::int FROM vehicle_damages d
              WHERE d.vehicle_id = v.id AND d.status = 'abierto') AS open_damages
       FROM logistics_vehicles v
       LEFT JOIN LATERAL (
         SELECT c.id, c.inspection_date, c.result, c.number_year, c.number_seq
           FROM vehicle_checklists c
          WHERE c.vehicle_id = v.id AND c.status = 'registered'
          ORDER BY c.inspection_date DESC, c.id DESC
          LIMIT 1
       ) ult ON TRUE
      WHERE $1::boolean OR v.active
      ORDER BY v.active DESC, v.plate ASC`,
    [includeInactive],
  );
  return rows;
}

async function getVehicle(id) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM logistics_vehicles v WHERE v.id = $1`, [id]);
  return rows[0] || null;
}

function vehicleParams(values) {
  return [
    values.plate,
    values.kind,
    values.brand || null,
    values.model || null,
    values.model_year,
    values.odometer_km,
    values.technical_review_due,
    values.gas_review_due,
    values.circulation_permit_due,
    values.insurance_due,
    values.next_maintenance_km,
    values.notes || null,
  ];
}

function rethrowPlateTaken(err, plate) {
  if (err.code === "23505") {
    throw new VehicleInputError(`Ya hay un vehículo con la patente ${plate}.`);
  }
  throw err;
}

// ---------------------------------------------------------------------------
// Historial de la ficha
// ---------------------------------------------------------------------------

/**
 * Campos de la ficha que se registran al cambiar, en el orden en que se
 * muestran. `type` dice cómo compararlos y mostrarlos.
 */
const VEHICLE_FIELDS = Object.freeze([
  { field: "plate", label: "Patente", type: "text" },
  { field: "kind", label: "Tipo", type: "kind" },
  { field: "brand", label: "Marca", type: "text" },
  { field: "model", label: "Modelo", type: "text" },
  { field: "model_year", label: "Año", type: "number" },
  { field: "odometer_km", label: "Kilometraje", type: "km" },
  ...VEHICLE_DOCUMENTS.map((d) => ({ field: d.field, label: d.label, type: "date" })),
  { field: "next_maintenance_km", label: "Próx. mantención", type: "km" },
  { field: "notes", label: "Notas", type: "text" },
]);

/** Valor comparable: texto vacío y ausente son lo mismo (null). */
function comparable(type, value) {
  if (value == null || value === "") return null;
  if (type === "number" || type === "km") {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  if (type === "date") return toDateOnly(value) || null;
  return String(value).trim() || null;
}

/** Campos que cambiaron entre dos fichas: [{ field, from, to }]. Pura. */
function diffVehicle(before = {}, after = {}) {
  const changes = [];
  for (const { field, type } of VEHICLE_FIELDS) {
    if (!(field in after)) continue;
    const from = comparable(type, before[field]);
    const to = comparable(type, after[field]);
    if (from !== to) changes.push({ field, from, to });
  }
  return changes;
}

async function signerName(queryable, userId) {
  if (userId == null) return "Usuario de la intranet";
  const { rows } = await queryable.query(
    "SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM users WHERE id = $1",
    [userId],
  );
  return (rows[0] && rows[0].name) || "Usuario de la intranet";
}

async function recordChange(client, vehicleId, action, changes, userId) {
  await client.query(
    `INSERT INTO logistics_vehicle_changes (vehicle_id, action, changes, changed_by, changed_by_name)
     VALUES ($1, $2, $3::jsonb, $4, $5)`,
    [vehicleId, action, JSON.stringify(changes || []), userId ?? null, await signerName(client, userId)],
  );
}

/** Corre `work(client)` en una transacción. */
async function inTransaction(work) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function createVehicle(values, userId) {
  try {
    return await inTransaction(async (client) => {
      const { rows } = await client.query(
        `INSERT INTO logistics_vehicles (
           plate, kind, brand, model, model_year, odometer_km,
           technical_review_due, gas_review_due, circulation_permit_due, insurance_due,
           next_maintenance_km, notes, created_by, updated_by
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
         RETURNING id`,
        [...vehicleParams(values), userId ?? null],
      );
      const id = Number(rows[0].id);
      await recordChange(client, id, "creado", diffVehicle({}, values), userId);
      return id;
    });
  } catch (err) {
    return rethrowPlateTaken(err, values.plate);
  }
}

/**
 * Guarda la ficha y registra lo que cambió. Devuelve los cambios ([] si no
 * cambió nada) o null si el vehículo no existe.
 */
async function updateVehicle(id, values, userId) {
  try {
    return await inTransaction(async (client) => {
      const { rows } = await client.query(`SELECT ${COLUMNS} FROM logistics_vehicles v WHERE v.id = $1 FOR UPDATE`, [id]);
      if (!rows[0]) return null;
      const changes = diffVehicle(rows[0], values);
      if (!changes.length) return changes;
      await client.query(
        `UPDATE logistics_vehicles
            SET plate = $1, kind = $2, brand = $3, model = $4, model_year = $5,
                odometer_km = $6, technical_review_due = $7, gas_review_due = $8,
                circulation_permit_due = $9, insurance_due = $10, next_maintenance_km = $11,
                notes = $12, updated_by = $13, updated_at = NOW()
          WHERE id = $14`,
        [...vehicleParams(values), userId ?? null, id],
      );
      await recordChange(client, id, "editado", changes, userId);
      return changes;
    });
  } catch (err) {
    return rethrowPlateTaken(err, values.plate);
  }
}

/** Dar de baja no borra: las revisiones del vehículo siguen apuntándolo. */
async function setVehicleActive(id, active, userId) {
  return inTransaction(async (client) => {
    const { rows } = await client.query(
      `UPDATE logistics_vehicles SET active = $2, updated_by = $3, updated_at = NOW()
        WHERE id = $1 AND active IS DISTINCT FROM $2
        RETURNING id`,
      [id, Boolean(active), userId ?? null],
    );
    if (!rows[0]) return false;
    await recordChange(client, id, active ? "reactivado" : "baja", [], userId);
    return true;
  });
}

/**
 * Historial de la ficha, del más reciente al más antiguo. Los vehículos que
 * existían antes del historial no tienen «creado»: se agrega uno con su
 * fecha de alta para que la lista empiece en algún lado.
 */
async function listVehicleChanges(vehicleId) {
  const { rows } = await db.query(
    `SELECT id, action, changes, changed_by, changed_by_name, changed_at
       FROM logistics_vehicle_changes
      WHERE vehicle_id = $1
      ORDER BY changed_at DESC, id DESC`,
    [vehicleId],
  );
  if (rows.some((r) => r.action === "creado")) return rows;
  const { rows: alta } = await db.query(
    `SELECT v.created_at, NULLIF(TRIM(CONCAT_WS(' ', u.first_name, u.last_name)), '') AS name
       FROM logistics_vehicles v LEFT JOIN users u ON u.id = v.created_by
      WHERE v.id = $1`,
    [vehicleId],
  );
  if (!alta[0]) return rows;
  return [...rows, {
    id: null, action: "creado", changes: [], changed_by: null,
    changed_by_name: alta[0].name || "—", changed_at: alta[0].created_at, previous: true,
  }];
}

async function countVehicleChanges(vehicleId) {
  const { rows } = await db.query(
    "SELECT COUNT(*)::int AS n FROM logistics_vehicle_changes WHERE vehicle_id = $1",
    [vehicleId],
  );
  return rows[0].n;
}

// ---------------------------------------------------------------------------
// Kilometraje
// ---------------------------------------------------------------------------

/**
 * Lecturas de kilometraje del vehículo, de la más antigua a la más nueva: las
 * de cada revisión registrada (mecánica y física), la del alta y las correcciones hechas
 * en la ficha. [{ date, km, source, ref_id, year, seq, at }]
 */
async function listKmReadings(vehicleId) {
  const { rows } = await db.query(
    `SELECT inspection_date::text AS date, odometer_km AS km, 'mecanica' AS source,
            id AS ref_id, number_year AS year, number_seq AS seq, created_at AS at
       FROM vehicle_checklists
      WHERE vehicle_id = $1 AND status = 'registered'
     UNION ALL
     SELECT review_date::text, odometer_km, 'fisica', id, number_year, number_seq, created_at
       FROM vehicle_physical_reviews
      WHERE vehicle_id = $1 AND status = 'registered'
     UNION ALL
     SELECT (c.changed_at AT TIME ZONE $2)::date::text, (ch->>'to')::int, CASE c.action WHEN 'creado' THEN 'alta' ELSE 'ficha' END, c.id, NULL, NULL, c.changed_at
       FROM logistics_vehicle_changes c
       CROSS JOIN LATERAL jsonb_array_elements(c.changes) ch
      WHERE c.vehicle_id = $1 AND ch->>'field' = 'odometer_km' AND ch->>'to' IS NOT NULL
     ORDER BY date, at`,
    [vehicleId, getCountryConfig().timezone],
  );
  return rows.map((r) => ({ ...r, km: Number(r.km) }));
}

/**
 * Resumen de las lecturas (pura): última, recorrido en los últimos 30 días y
 * promedio mensual entre la primera y la última.
 */
function kmSummary(readings, today) {
  const list = (readings || []).filter((r) => Number.isFinite(r.km));
  if (!list.length) return null;
  const first = list[0];
  const last = list[list.length - 1];
  const dayMs = 86400000;
  const toTime = (iso) => Date.parse(`${String(iso).slice(0, 10)}T00:00:00Z`);
  const desde = toTime(today) - 30 * dayMs;
  const antes = [...list].reverse().find((r) => toTime(r.date) <= desde) || first;
  const dias = Math.max(0, Math.round((toTime(last.date) - toTime(first.date)) / dayMs));
  const recorrido = last.km - first.km;
  return {
    last,
    first,
    count: list.length,
    lastMonth: Math.max(0, last.km - antes.km),
    lastMonthFrom: antes.date,
    total: recorrido,
    days: dias,
    perMonth: dias >= 28 && recorrido > 0 ? Math.round((recorrido / dias) * 30) : null,
  };
}

module.exports = {
  DUE_SOON_DAYS,
  MAINTENANCE_SOON_KM,
  VEHICLE_DOCUMENTS,
  documentsFor,
  VehicleInputError,
  normalizePlate,
  normalizeVehicleInput,
  documentAlerts,
  vehicleLabel,
  listVehicles,
  getVehicle,
  createVehicle,
  updateVehicle,
  setVehicleActive,
  VEHICLE_FIELDS,
  diffVehicle,
  listVehicleChanges,
  countVehicleChanges,
  listKmReadings,
  kmSummary,
};
