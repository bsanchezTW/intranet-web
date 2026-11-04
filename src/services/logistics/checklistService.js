const db = require("../../db");
const {
  INSPECTION_KINDS,
  ANSWERS,
  RESULTS,
  FUEL_LEVELS,
  MAX_SEQ,
  formatKm,
  formatChecklistNumber,
  computeResult,
} = require("../../constants/vehicleChecklist");
const { cleanText, cleanMultiline, parseOptionalInt, isValidIsoDate, parseId } = require("./inputs");
const { vehicleLabel } = require("./vehicleService");

/**
 * Revisión mecánica (el checklist): validación del formulario, numeración
 * correlativa, registro, listado de documentos y anulación. La plantilla de
 * categorías e ítems está en templateService.js.
 *
 * normalizeChecklistInput es pura para probarla sin
 * base; el resto habla con Postgres.
 *
 * Un checklist registrado no se edita: es el respaldo de que el vehículo se
 * revisó. Si se registró mal, se anula con motivo y se registra otro.
 */

// Serializa la numeración entre peticiones simultáneas. Llave de toda la
// base (chile y peru comparten servidor); la de letras es 7215001.
const NUMBERING_LOCK_KEY = 7215002;
const LIST_LIMIT = 500;
const DRIVER_OTHER = "otro";

class ChecklistError extends Error {
  constructor(message, code = "CHECKLIST_INVALID") {
    super(message);
    this.code = code;
  }
}

const answerKey = (itemId) => `item_${itemId}`;
const commentKey = (itemId) => `nota_${itemId}`;

/**
 * Valida el formulario. `items` es la plantilla activa (en orden), `vehicles`
 * la flota activa, `drivers` las personas elegibles y `today` la fecha del
 * país. Devuelve { values, errors, ok }; `errors` trae un mensaje por campo y
 * uno por ítem (item_<id>).
 */
function normalizeChecklistInput(body = {}, { items = [], vehicles = [], drivers = [], today } = {}) {
  const errors = {};
  const values = {};

  values.inspection_date = cleanText(body.inspection_date, 10) || today;
  if (!isValidIsoDate(values.inspection_date)) {
    errors.inspection_date = "Ingresa una fecha válida.";
  } else if (today && values.inspection_date > today) {
    errors.inspection_date = "La revisión no puede tener fecha futura.";
  }

  values.inspection_kind = INSPECTION_KINDS.some((k) => k.value === body.inspection_kind)
    ? body.inspection_kind
    : "";
  if (!values.inspection_kind) errors.inspection_kind = "Elige el momento de la revisión.";

  const vehicleId = parseId(body.vehicle_id);
  const vehicle = vehicles.find((v) => Number(v.id) === vehicleId) || null;
  values.vehicle_id = vehicle ? vehicleId : cleanText(body.vehicle_id, 15);
  if (!vehicle) errors.vehicle_id = "Elige el vehículo revisado.";

  const km = parseOptionalInt(body.odometer_km);
  values.odometer_km = km.ok && km.value != null ? km.value : cleanText(body.odometer_km, 12);
  if (!km.ok || km.value == null) {
    errors.odometer_km = "Ingresa el kilometraje del tablero.";
  } else if (vehicle && vehicle.odometer_km != null && km.value < Number(vehicle.odometer_km)) {
    errors.odometer_km = `Es menor al último registrado (${formatKm(vehicle.odometer_km)}). Si ese dato está mal, corrígelo en la flota.`;
  }

  values.fuel_level = FUEL_LEVELS.includes(body.fuel_level) ? body.fuel_level : null;

  // Conductor: una persona de la empresa o, si no está, su nombre a mano.
  const rawDriver = String(body.driver_user_id ?? "").trim();
  values.driver_user_id = null;
  values.driver_choice = rawDriver;
  values.driver_name_other = cleanText(body.driver_name_other, 160);
  if (rawDriver === DRIVER_OTHER) {
    values.driver_name = values.driver_name_other;
    if (!values.driver_name) errors.driver_name_other = "Escribe el nombre del conductor.";
  } else {
    const driver = drivers.find((d) => Number(d.id) === parseId(rawDriver));
    values.driver_user_id = driver ? Number(driver.id) : null;
    values.driver_name = driver ? driver.name : "";
    if (!driver) errors.driver_user_id = "Elige al conductor.";
  }

  // Ítems: todos se responden (Sí / No / N/A). La observación es opcional,
  // como la columna OBS de la planilla; el formulario la ofrece al marcar No.
  let sinResponder = 0;
  values.answers = items.map((item, index) => {
    const answer = ANSWERS.some((a) => a.value === body[answerKey(item.id)]) ? body[answerKey(item.id)] : "";
    const comment = cleanText(body[commentKey(item.id)], 300);
    if (!answer) {
      sinResponder += 1;
      errors[answerKey(item.id)] = "Marca Sí, No o N/A.";
    }
    return {
      item_id: Number(item.id),
      position: index + 1,
      category: item.category,
      label: item.label,
      critical: Boolean(item.critical),
      answer,
      comment,
    };
  });
  if (!items.length) errors.items = "La plantilla no tiene ítems activos: pídele a Logística que la configure.";
  else if (sinResponder) {
    errors.items = sinResponder === 1 ? "Falta responder 1 ítem." : `Faltan responder ${sinResponder} ítems.`;
  }

  values.observations = cleanMultiline(body.observations, 1000);
  values.declaro = body.declaro === "1";
  if (!values.declaro) errors.declaro = "Confirma que revisaste el vehículo.";

  values.result = computeResult(values.answers.filter((a) => a.answer));
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

function withNumber(row) {
  return row ? { ...row, number: formatChecklistNumber(row.number_year, row.number_seq) } : row;
}

function resultLabel(result) {
  return (RESULTS[result] || { label: result }).label;
}

// ---------------------------------------------------------------------------
// Base de datos: registro
// ---------------------------------------------------------------------------

/** Personas que pueden figurar como conductor: las cuentas no deshabilitadas. */
async function listDrivers() {
  const { rows } = await db.query(
    `SELECT id, NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name
       FROM users
      WHERE COALESCE(LOWER(TRIM(role)), '') NOT IN ('deshabilitado', 'disabled')
        AND NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') IS NOT NULL
      ORDER BY first_name, last_name`,
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name }));
}

async function userDisplayName(queryable, userId) {
  const { rows } = await queryable.query(
    "SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM users WHERE id = $1",
    [userId],
  );
  return (rows[0] && rows[0].name) || "Usuario de la intranet";
}

/**
 * Registra el checklist en una transacción. `values` es la salida de
 * normalizeChecklistInput con ok = true. La patente y la descripción del
 * vehículo se leen de la base (no del formulario) y quedan congeladas.
 */
async function createChecklist(values, userId) {
  const year = Number(values.inspection_date.slice(0, 4));
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [NUMBERING_LOCK_KEY]);

    const { rows: vehicleRows } = await client.query(
      `SELECT id, plate, brand, model, model_year, active,
              technical_review_due::text AS technical_review_due,
              gas_review_due::text AS gas_review_due,
              circulation_permit_due::text AS circulation_permit_due,
              insurance_due::text AS insurance_due,
              next_maintenance_km
         FROM logistics_vehicles WHERE id = $1 FOR UPDATE`,
      [values.vehicle_id],
    );
    const vehicle = vehicleRows[0];
    if (!vehicle || !vehicle.active) {
      throw new ChecklistError("El vehículo ya no está activo en la flota.", "CHECKLIST_VEHICLE");
    }

    const { rows: seqRows } = await client.query(
      "SELECT COALESCE(MAX(number_seq), 0) + 1 AS next FROM vehicle_checklists WHERE number_year = $1",
      [year],
    );
    const seq = Number(seqRows[0].next);
    if (seq > MAX_SEQ) throw new ChecklistError(`La numeración de ${year} supera ${MAX_SEQ}.`, "CHECKLIST_NUMBER");

    const signer = await userDisplayName(client, userId);
    const { rows } = await client.query(
      `INSERT INTO vehicle_checklists (
         number_year, number_seq, inspection_date, inspection_kind,
         vehicle_id, vehicle_plate, vehicle_label, odometer_km, fuel_level,
         driver_user_id, driver_name, result, observations,
         created_by, created_by_name,
         technical_review_due, gas_review_due, circulation_permit_due, insurance_due,
         next_maintenance_km
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
       RETURNING id`,
      [
        year,
        seq,
        values.inspection_date,
        values.inspection_kind,
        vehicle.id,
        vehicle.plate,
        vehicleLabel(vehicle) || null,
        values.odometer_km,
        values.fuel_level,
        values.driver_user_id,
        values.driver_name,
        values.result,
        values.observations || null,
        userId ?? null,
        signer,
        vehicle.technical_review_due,
        vehicle.gas_review_due,
        vehicle.circulation_permit_due,
        vehicle.insurance_due,
        vehicle.next_maintenance_km,
      ],
    );
    const checklistId = rows[0].id;

    const answers = values.answers;
    await client.query(
      `INSERT INTO vehicle_checklist_answers
         (checklist_id, item_id, position, category, label, critical, answer, comment)
       SELECT $1::bigint, s.item_id, s.position, s.category, s.label, s.critical, s.answer, NULLIF(s.comment, '')
         FROM UNNEST($2::bigint[], $3::smallint[], $4::text[], $5::text[], $6::boolean[], $7::text[], $8::text[])
              AS s(item_id, position, category, label, critical, answer, comment)`,
      [
        checklistId,
        answers.map((a) => a.item_id),
        answers.map((a) => a.position),
        answers.map((a) => a.category),
        answers.map((a) => a.label),
        answers.map((a) => a.critical),
        answers.map((a) => a.answer),
        answers.map((a) => a.comment || ""),
      ],
    );

    // El kilometraje de la flota sólo avanza.
    await client.query(
      `UPDATE logistics_vehicles
          SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2), updated_at = NOW()
        WHERE id = $1`,
      [vehicle.id, values.odometer_km],
    );

    await client.query("COMMIT");
    return { id: Number(checklistId), number: formatChecklistNumber(year, seq) };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    if (err.code === "23505") {
      throw new ChecklistError("Ese número acaba de usarse. Vuelve a intentarlo.", "CHECKLIST_NUMBER");
    }
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Base de datos: documentos
// ---------------------------------------------------------------------------

const COLUMNS = `
  c.id, c.number_year, c.number_seq, c.inspection_date::text AS inspection_date,
  c.inspection_kind, c.vehicle_id, c.vehicle_plate, c.vehicle_label, c.odometer_km,
  c.fuel_level, c.driver_user_id, c.driver_name, c.result, c.observations,
  c.technical_review_due::text AS technical_review_due, c.gas_review_due::text AS gas_review_due,
  c.circulation_permit_due::text AS circulation_permit_due, c.insurance_due::text AS insurance_due,
  c.next_maintenance_km,
  c.status, c.void_reason, c.voided_at, c.created_by, c.created_by_name, c.created_at,
  NULLIF(TRIM(CONCAT_WS(' ', vu.first_name, vu.last_name)), '') AS voided_by_name`;

const RESULT_FILTERS = ["apto", "observado", "no_apto"];

/**
 * Listado de documentos. `scope` es el filtro del permiso de ver
 * ({ clause, params } de perms.sqlFilter sobre c.created_by).
 */
async function listChecklists({ q = "", resultado = "", desde = "", hasta = "", vehiculo = null, scope } = {}) {
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
    where.push(`(c.vehicle_plate LIKE '%' || ${plate} || '%'
                 OR c.driver_name ILIKE ${like}
                 OR c.created_by_name ILIKE ${like}
                 OR ('CV-' || LPAD(c.number_seq::text, 5, '0') || '-' || c.number_year) ILIKE ${like})`);
  }
  if (resultado === "anulados") where.push("c.status = 'voided'");
  else if (RESULT_FILTERS.includes(resultado)) where.push(`c.status = 'registered' AND c.result = ${add(resultado)}`);
  if (isValidIsoDate(desde)) where.push(`c.inspection_date >= ${add(desde)}::date`);
  if (isValidIsoDate(hasta)) where.push(`c.inspection_date <= ${add(hasta)}::date`);
  if (vehiculo) where.push(`c.vehicle_id = ${add(vehiculo)}`);

  const { rows } = await db.query(
    `SELECT ${COLUMNS},
            (SELECT COUNT(*)::int FROM vehicle_checklist_answers a
              WHERE a.checklist_id = c.id AND a.answer = 'falla') AS fallas
       FROM vehicle_checklists c
       LEFT JOIN users vu ON vu.id = c.voided_by
      WHERE ${where.length ? where.join(" AND ") : "TRUE"}
      ORDER BY c.inspection_date DESC, c.id DESC
      LIMIT ${LIST_LIMIT}`,
    params,
  );
  return rows.map(withNumber);
}

async function getChecklist(id) {
  const { rows } = await db.query(
    `SELECT ${COLUMNS}
       FROM vehicle_checklists c
       LEFT JOIN users vu ON vu.id = c.voided_by
      WHERE c.id = $1`,
    [id],
  );
  if (!rows[0]) return null;
  const { rows: answers } = await db.query(
    `SELECT position, category, label, critical, answer, comment
       FROM vehicle_checklist_answers
      WHERE checklist_id = $1
      ORDER BY position`,
    [id],
  );
  return { ...withNumber(rows[0]), answers };
}

/** Anula un checklist registrado. null si no existe o ya estaba anulado. */
async function voidChecklist(id, reason, userId) {
  const motivo = cleanText(reason, 300);
  if (motivo.length < 5) throw new ChecklistError("Explica en pocas palabras por qué se anula.", "CHECKLIST_VOID_REASON");
  const { rows } = await db.query(
    `UPDATE vehicle_checklists
        SET status = 'voided', void_reason = $2, voided_at = NOW(), voided_by = $3
      WHERE id = $1 AND status = 'registered'
      RETURNING id, number_year, number_seq`,
    [id, motivo, userId ?? null],
  );
  return rows[0] ? withNumber(rows[0]) : null;
}

module.exports = {
  DRIVER_OTHER,
  LIST_LIMIT,
  ChecklistError,
  answerKey,
  commentKey,
  normalizeChecklistInput,
  resultLabel,
  listDrivers,
  createChecklist,
  listChecklists,
  getChecklist,
  voidChecklist,
};
