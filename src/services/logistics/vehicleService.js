const db = require("../../db");
const { isVehicleKind, formatKm } = require("../../constants/vehicleChecklist");
const { toDateOnly, addDays, formatDisplay } = require("../../utils/vacationDateUtils");
const { cleanText, parseOptionalInt, parseOptionalDate } = require("./inputs");

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

async function createVehicle(values, userId) {
  try {
    const { rows } = await db.query(
      `INSERT INTO logistics_vehicles (
         plate, kind, brand, model, model_year, odometer_km,
         technical_review_due, gas_review_due, circulation_permit_due, insurance_due,
         next_maintenance_km, notes, created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
       RETURNING id`,
      [...vehicleParams(values), userId ?? null],
    );
    return Number(rows[0].id);
  } catch (err) {
    return rethrowPlateTaken(err, values.plate);
  }
}

async function updateVehicle(id, values, userId) {
  try {
    const { rowCount } = await db.query(
      `UPDATE logistics_vehicles
          SET plate = $1, kind = $2, brand = $3, model = $4, model_year = $5,
              odometer_km = $6, technical_review_due = $7, gas_review_due = $8,
              circulation_permit_due = $9, insurance_due = $10, next_maintenance_km = $11,
              notes = $12, updated_by = $13, updated_at = NOW()
        WHERE id = $14`,
      [...vehicleParams(values), userId ?? null, id],
    );
    return rowCount > 0;
  } catch (err) {
    return rethrowPlateTaken(err, values.plate);
  }
}

/** Dar de baja no borra: los checklists del vehículo siguen apuntándolo. */
async function setVehicleActive(id, active, userId) {
  const { rowCount } = await db.query(
    "UPDATE logistics_vehicles SET active = $2, updated_by = $3, updated_at = NOW() WHERE id = $1",
    [id, Boolean(active), userId ?? null],
  );
  return rowCount > 0;
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
};
