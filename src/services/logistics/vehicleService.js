const db = require("../../db");
const { VEHICLE_KINDS } = require("../../constants/vehicleChecklist");
const { toDateOnly, addDays } = require("../../utils/vacationDateUtils");
const { cleanText, parseOptionalInt, parseOptionalDate } = require("./inputs");

/**
 * Flota de Logística: la usan el checklist y las hojas de ruta.
 *
 * normalizeVehicleInput y documentAlerts son puras para probarlas sin base;
 * el resto habla con Postgres.
 */

/** Días de anticipación con que un documento del vehículo se marca "por vencer". */
const DUE_SOON_DAYS = 30;

const VEHICLE_DOCUMENTS = Object.freeze([
  { field: "technical_review_due", label: "Revisión técnica" },
  { field: "circulation_permit_due", label: "Permiso de circulación" },
  { field: "insurance_due", label: "Seguro obligatorio" },
]);

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

  values.kind = VEHICLE_KINDS.some((k) => k.value === body.kind) ? body.kind : "camioneta";
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

/**
 * Documentos vencidos o por vencer de un vehículo, para avisar en la flota y
 * en el checklist: [{ label, due, state: 'vencido' | 'por_vencer' }].
 */
function documentAlerts(vehicle, today) {
  const soon = addDays(today, DUE_SOON_DAYS);
  const alerts = [];
  for (const { field, label } of VEHICLE_DOCUMENTS) {
    const due = vehicle && toDateOnly(vehicle[field]);
    if (!due) continue;
    if (due < today) alerts.push({ label, due, state: "vencido" });
    else if (due <= soon) alerts.push({ label, due, state: "por_vencer" });
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
  v.circulation_permit_due::text AS circulation_permit_due,
  v.insurance_due::text AS insurance_due,
  v.notes, v.active, v.created_at, v.updated_at`;

async function listVehicles({ includeInactive = true } = {}) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS},
            (SELECT MAX(c.inspection_date)::text FROM vehicle_checklists c
              WHERE c.vehicle_id = v.id AND c.status = 'registered') AS last_checklist_date
       FROM logistics_vehicles v
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
    values.circulation_permit_due,
    values.insurance_due,
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
         technical_review_due, circulation_permit_due, insurance_due, notes,
         created_by, updated_by
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11)
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
              odometer_km = $6, technical_review_due = $7, circulation_permit_due = $8,
              insurance_due = $9, notes = $10, updated_by = $11, updated_at = NOW()
        WHERE id = $12`,
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
  VEHICLE_DOCUMENTS,
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
