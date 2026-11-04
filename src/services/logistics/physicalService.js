const db = require("../../db");
const {
  REVIEW_REASONS,
  DAMAGE_TYPES,
  MIN_PHOTOS,
  MAX_PHOTOS,
  MAX_DAMAGES,
  CAPTURE_VIEWS,
  MAX_SEQ,
  formatPhysicalNumber,
} = require("../../constants/vehiclePhysical");
const { formatKm } = require("../../constants/vehicleChecklist");
const { cleanText, cleanMultiline, parseOptionalInt, isValidIsoDate, parseId } = require("./inputs");
const { vehicleLabel } = require("./vehicleService");
const { DRIVER_OTHER } = require("./checklistService");
const photos = require("./damagePhotos");

/**
 * Revisión física y registro vivo de daños.
 *
 * Una revisión física es un documento (RF-00001-2026): fecha, motivo,
 * kilometraje, conductor, observaciones, las capturas del modelo 3D y los
 * daños nuevos que se encontraron, cada uno sobre una zona del modelo, con
 * tipo, observación y de 1 a 4 fotos. Los daños quedan abiertos hasta que
 * Logística los marca reparados (fecha, observación y fotos).
 *
 * Como la mecánica, una revisión registrada no se edita: se anula con
 * motivo, y sus daños quedan anulados.
 *
 * Las funciones normalize* son puras; el resto habla con Postgres y Storage.
 */

// Numeración de RF-…: 7215001 es letras, 7215002 la revisión mecánica y
// 7215003 queda para hojas de ruta.
const NUMBERING_LOCK_KEY = 7215004;
const LIST_LIMIT = 500;

class PhysicalError extends Error {
  constructor(message, code = "PHYSICAL_INVALID") {
    super(message);
    this.code = code;
  }
}

const damageKey = (index) => `danio_${index}`;
const photoField = (index) => `foto_${index}`;
const captureField = (vista) => `captura_${vista}`;

/** Conductor: una persona de la empresa o, si no está, su nombre a mano. */
function readDriver(body, drivers, values, errors) {
  const raw = String(body.driver_user_id ?? "").trim();
  values.driver_user_id = null;
  values.driver_choice = raw;
  values.driver_name_other = cleanText(body.driver_name_other, 160);
  if (raw === DRIVER_OTHER) {
    values.driver_name = values.driver_name_other;
    if (!values.driver_name) errors.driver_name_other = "Escribe el nombre del conductor.";
    return;
  }
  const driver = drivers.find((d) => Number(d.id) === parseId(raw));
  values.driver_user_id = driver ? Number(driver.id) : null;
  values.driver_name = driver ? driver.name : "";
  if (!driver) errors.driver_user_id = "Elige al conductor.";
}

function readDescription(value) {
  const text = cleanMultiline(value, 500);
  if (text.length < 3) return { text, error: "Describe el daño en pocas palabras." };
  return { text, error: null };
}

function photoCountError(count, { min = MIN_PHOTOS, max = MAX_PHOTOS } = {}) {
  if (count < min) return min === 1 ? "Agrega al menos una foto." : `Agrega al menos ${min} fotos.`;
  if (count > max) return `Son ${max} fotos como máximo.`;
  return null;
}

/**
 * Valida la revisión. `damages` es el arreglo que arma el formulario
 * ([{ zone, type, description }]) y `photoCounts[i]` cuántas fotos llegaron
 * para el daño i. `zones` son las del modelo del vehículo. Devuelve
 * { values, errors, ok }; los errores de cada daño van en danio_<i>.
 */
function normalizePhysicalInput(body = {}, { vehicle, zones = [], drivers = [], today, damages = [], photoCounts = [] } = {}) {
  const errors = {};
  const values = {};

  if (!vehicle) errors.general = "El vehículo ya no existe.";
  else if (!vehicle.active) errors.general = "El vehículo está dado de baja.";
  values.vehicle_id = vehicle ? Number(vehicle.id) : null;
  values.vehicle_kind = vehicle ? vehicle.kind : null;

  values.review_date = cleanText(body.review_date, 10) || today;
  if (!isValidIsoDate(values.review_date)) errors.review_date = "Ingresa una fecha válida.";
  else if (today && values.review_date > today) errors.review_date = "La revisión no puede tener fecha futura.";

  values.reason = REVIEW_REASONS.some((r) => r.value === body.reason) ? body.reason : "";
  if (!values.reason) errors.reason = "Elige el motivo de la revisión.";

  const km = parseOptionalInt(body.odometer_km);
  values.odometer_km = km.ok && km.value != null ? km.value : cleanText(body.odometer_km, 12);
  if (!km.ok || km.value == null) {
    errors.odometer_km = "Ingresa el kilometraje del tablero.";
  } else if (vehicle && vehicle.odometer_km != null && km.value < Number(vehicle.odometer_km)) {
    errors.odometer_km = `Es menor al último registrado (${formatKm(vehicle.odometer_km)}). Si ese dato está mal, corrígelo en la flota.`;
  }

  readDriver(body, drivers, values, errors);
  values.observations = cleanMultiline(body.observations, 1000);

  const zoneMap = new Map(zones.map((z) => [z.code, z]));
  const list = Array.isArray(damages) ? damages : [];
  if (list.length > MAX_DAMAGES) {
    errors.danios = `Son ${MAX_DAMAGES} daños nuevos por revisión como máximo. Registra el resto en otra revisión.`;
  }
  values.damages = list.slice(0, MAX_DAMAGES).map((raw, index) => {
    const d = raw && typeof raw === "object" ? raw : {};
    const zone = zoneMap.get(String(d.zone || ""));
    const type = DAMAGE_TYPES.some((t) => t.value === d.type) ? d.type : "";
    const description = readDescription(d.description);
    const count = Number(photoCounts[index]) || 0;
    const problems = [];
    if (!zone) problems.push("Elige la zona del daño.");
    if (!type) problems.push("Elige el tipo de daño.");
    if (description.error) problems.push(description.error);
    const fotoError = photoCountError(count);
    if (fotoError) problems.push(fotoError);
    if (problems.length) errors[damageKey(index)] = problems.join(" ");
    return {
      position: index + 1,
      zone_code: zone ? zone.code : String(d.zone || "").slice(0, 40),
      zone_label: zone ? zone.label : "",
      zone_group: zone ? zone.group : "",
      damage_type: type,
      description: description.text,
      photo_count: count,
    };
  });

  values.declaro = body.declaro === "1";
  if (!values.declaro) errors.declaro = "Confirma que revisaste el vehículo por fuera.";

  return { values, errors, ok: Object.keys(errors).length === 0 };
}

/** Valida la reparación de un daño. `reportedOn` es la fecha de su revisión. */
function normalizeRepairInput(body = {}, { today, reportedOn, photoCount = 0 } = {}) {
  const errors = {};
  const values = {};
  values.repaired_on = cleanText(body.repaired_on, 10) || today;
  if (!isValidIsoDate(values.repaired_on)) errors.repaired_on = "Ingresa una fecha válida.";
  else if (today && values.repaired_on > today) errors.repaired_on = "La reparación no puede tener fecha futura.";
  else if (reportedOn && values.repaired_on < String(reportedOn).slice(0, 10)) {
    errors.repaired_on = "Es anterior a la revisión en que se registró el daño.";
  }
  values.repair_note = cleanMultiline(body.repair_note, 500);
  if (values.repair_note.length < 3) errors.repair_note = "Cuenta qué se hizo (taller, pieza, pintura…).";
  const fotoError = photoCountError(Number(photoCount) || 0);
  if (fotoError) errors.fotos = fotoError;
  return { values, errors, ok: Object.keys(errors).length === 0 };
}

function withNumber(row) {
  return row ? { ...row, number: formatPhysicalNumber(row.number_year, row.number_seq) } : row;
}

async function userDisplayName(queryable, userId) {
  const { rows } = await queryable.query(
    "SELECT NULLIF(TRIM(CONCAT_WS(' ', first_name, last_name)), '') AS name FROM users WHERE id = $1",
    [userId],
  );
  return (rows[0] && rows[0].name) || "Usuario de la intranet";
}

async function insertPhotos(client, damageId, kind, list, userId) {
  if (!list.length) return;
  await client.query(
    `INSERT INTO vehicle_damage_photos
       (damage_id, kind, position, storage_path, width, height, size_bytes, created_by)
     SELECT $1::bigint, $2, s.position, s.path, s.width, s.height, s.size, $3
       FROM UNNEST($4::smallint[], $5::text[], $6::int[], $7::int[], $8::int[])
            AS s(position, path, width, height, size)`,
    [
      damageId,
      kind,
      userId ?? null,
      list.map((_, i) => i + 1),
      list.map((p) => p.storage_path),
      list.map((p) => p.width ?? null),
      list.map((p) => p.height ?? null),
      list.map((p) => p.size_bytes ?? null),
    ],
  );
}

// ---------------------------------------------------------------------------
// Registro
// ---------------------------------------------------------------------------

/**
 * Registra la revisión. `values` es la salida de normalizePhysicalInput con
 * ok = true; `damagePhotos[i]` las fotos ya procesadas del daño i
 * ([{ buffer, width, height }]) y `captures` { vista: { buffer, … } }.
 * Primero sube las imágenes y después escribe todo en una transacción; si
 * la transacción falla, las borra.
 */
async function createPhysicalReview(values, { damagePhotos = [], captures = {} } = {}, userId, deps = {}) {
  const year = Number(values.review_date.slice(0, 4));
  const folder = photos.newFolder("fisicas", year);

  const lote = [];
  values.damages.forEach((d, i) => {
    (damagePhotos[i] || []).forEach((p, j) => lote.push({ ...p, name: `danio-${i + 1}-${j + 1}.jpg`, damage: i, slot: j }));
  });
  for (const v of CAPTURE_VIEWS) {
    if (captures[v.value]) lote.push({ ...captures[v.value], name: `captura-${v.value}.jpg`, capture: v.value });
  }
  const subidas = await photos.storeAll(lote, folder, deps);

  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock($1)", [NUMBERING_LOCK_KEY]);

    const { rows: vehicleRows } = await client.query(
      "SELECT id, plate, kind, brand, model, model_year, active FROM logistics_vehicles WHERE id = $1 FOR UPDATE",
      [values.vehicle_id],
    );
    const vehicle = vehicleRows[0];
    if (!vehicle || !vehicle.active) throw new PhysicalError("El vehículo ya no está activo en la flota.", "PHYSICAL_VEHICLE");
    if (vehicle.kind !== values.vehicle_kind) {
      throw new PhysicalError("Cambió el tipo del vehículo mientras revisabas. Vuelve a abrir la revisión física.", "PHYSICAL_KIND");
    }

    const { rows: seqRows } = await client.query(
      "SELECT COALESCE(MAX(number_seq), 0) + 1 AS next FROM vehicle_physical_reviews WHERE number_year = $1",
      [year],
    );
    const seq = Number(seqRows[0].next);
    if (seq > MAX_SEQ) throw new PhysicalError(`La numeración de ${year} supera ${MAX_SEQ}.`, "PHYSICAL_NUMBER");

    const capturas = {};
    subidas.filter((s) => s.capture).forEach((s) => { capturas[s.capture] = s.storage_path; });

    const signer = await userDisplayName(client, userId);
    const { rows } = await client.query(
      `INSERT INTO vehicle_physical_reviews (
         number_year, number_seq, review_date, reason, vehicle_id, vehicle_plate,
         vehicle_label, vehicle_kind, odometer_km, driver_user_id, driver_name,
         observations, captures, created_by, created_by_name
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15)
       RETURNING id`,
      [
        year,
        seq,
        values.review_date,
        values.reason,
        vehicle.id,
        vehicle.plate,
        vehicleLabel(vehicle) || null,
        vehicle.kind,
        values.odometer_km,
        values.driver_user_id,
        values.driver_name,
        values.observations || null,
        JSON.stringify(capturas),
        userId ?? null,
        signer,
      ],
    );
    const reviewId = rows[0].id;

    for (const [i, d] of values.damages.entries()) {
      const { rows: dmg } = await client.query(
        `INSERT INTO vehicle_damages
           (vehicle_id, review_id, position, zone_code, zone_label, zone_group, damage_type, description)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [vehicle.id, reviewId, d.position, d.zone_code, d.zone_label, d.zone_group, d.damage_type, d.description],
      );
      const suyas = subidas.filter((s) => s.damage === i).sort((a, b) => a.slot - b.slot);
      await insertPhotos(client, dmg[0].id, "danio", suyas, userId);
    }

    // El kilometraje de la flota sólo avanza.
    await client.query(
      `UPDATE logistics_vehicles
          SET odometer_km = GREATEST(COALESCE(odometer_km, 0), $2), updated_at = NOW()
        WHERE id = $1`,
      [vehicle.id, values.odometer_km],
    );

    await client.query("COMMIT");
    return { id: Number(reviewId), number: formatPhysicalNumber(year, seq), damages: values.damages.length };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    await photos.removeAll(subidas.map((s) => s.storage_path), deps);
    if (err.code === "23505") throw new PhysicalError("Ese número acaba de usarse. Vuelve a intentarlo.", "PHYSICAL_NUMBER");
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Consultas
// ---------------------------------------------------------------------------

const REVIEW_COLUMNS = `
  r.id, r.number_year, r.number_seq, r.review_date::text AS review_date, r.reason,
  r.vehicle_id, r.vehicle_plate, r.vehicle_label, r.vehicle_kind, r.odometer_km,
  r.driver_user_id, r.driver_name, r.observations, r.captures,
  r.status, r.void_reason, r.voided_at, r.created_by, r.created_by_name, r.created_at,
  NULLIF(TRIM(CONCAT_WS(' ', vu.first_name, vu.last_name)), '') AS voided_by_name`;

const DAMAGE_COLUMNS = `
  d.id, d.vehicle_id, d.review_id, d.position, d.zone_code, d.zone_label, d.zone_group,
  d.damage_type, d.description, d.status, d.repaired_on::text AS repaired_on,
  d.repair_note, d.repaired_by, d.repaired_by_name, d.repaired_at, d.created_at,
  r.number_year, r.number_seq, r.review_date::text AS review_date, r.status AS review_status,
  r.created_by AS review_created_by, r.created_by_name AS reported_by_name, r.vehicle_plate,
  COALESCE((
    SELECT json_agg(json_build_object('id', p.id, 'kind', p.kind, 'position', p.position,
                                      'width', p.width, 'height', p.height)
                    ORDER BY p.kind, p.position)
      FROM vehicle_damage_photos p WHERE p.damage_id = d.id
  ), '[]'::json) AS photos`;

function mapDamage(row) {
  if (!row) return row;
  const list = Array.isArray(row.photos) ? row.photos : [];
  return {
    ...row,
    review_number: formatPhysicalNumber(row.number_year, row.number_seq),
    damage_photos: list.filter((p) => p.kind === "danio"),
    repair_photos: list.filter((p) => p.kind === "reparacion"),
  };
}

function scoped(scope, params) {
  if (!scope) return "TRUE";
  const offset = params.length;
  params.push(...scope.params);
  return scope.clause.replace(/\$(\d+)/g, (_, n) => `$${Number(n) + offset}`);
}

/** Revisiones físicas de un vehículo, filtradas por `scope` (sobre r.created_by). */
async function listPhysicalReviews({ vehiculo, scope } = {}) {
  const params = [vehiculo];
  const filtro = scoped(scope, params);
  const { rows } = await db.query(
    `SELECT ${REVIEW_COLUMNS},
            (SELECT COUNT(*)::int FROM vehicle_damages d WHERE d.review_id = r.id) AS danios
       FROM vehicle_physical_reviews r
       LEFT JOIN users vu ON vu.id = r.voided_by
      WHERE r.vehicle_id = $1 AND ${filtro}
      ORDER BY r.review_date DESC, r.id DESC
      LIMIT ${LIST_LIMIT}`,
    params,
  );
  return rows.map(withNumber);
}

/**
 * Una revisión con sus daños nuevos y los que ya estaban abiertos cuando se
 * registró (abiertos en ese momento: de antes, no anulados y no reparados
 * hasta entonces).
 */
async function getPhysicalReview(id) {
  const { rows } = await db.query(
    `SELECT ${REVIEW_COLUMNS}
       FROM vehicle_physical_reviews r
       LEFT JOIN users vu ON vu.id = r.voided_by
      WHERE r.id = $1`,
    [id],
  );
  const review = rows[0];
  if (!review) return null;
  const { rows: nuevos } = await db.query(
    `SELECT ${DAMAGE_COLUMNS}
       FROM vehicle_damages d JOIN vehicle_physical_reviews r ON r.id = d.review_id
      WHERE d.review_id = $1
      ORDER BY d.position`,
    [id],
  );
  const { rows: previos } = await db.query(
    `SELECT ${DAMAGE_COLUMNS}
       FROM vehicle_damages d JOIN vehicle_physical_reviews r ON r.id = d.review_id
      WHERE d.vehicle_id = $1 AND d.review_id <> $2
        AND d.created_at < $3 AND d.status <> 'anulado'
        AND (d.repaired_at IS NULL OR d.repaired_at > $3)
      ORDER BY d.created_at, d.position`,
    [review.vehicle_id, id, review.created_at],
  );
  return { ...withNumber(review), damages: nuevos.map(mapDamage), previous: previos.map(mapDamage) };
}

/** Daños de un vehículo: los abiertos primero, luego reparados (y anulados si se piden). */
async function listDamages(vehicleId, { includeVoided = false } = {}) {
  const { rows } = await db.query(
    `SELECT ${DAMAGE_COLUMNS}
       FROM vehicle_damages d JOIN vehicle_physical_reviews r ON r.id = d.review_id
      WHERE d.vehicle_id = $1 AND ($2::boolean OR d.status <> 'anulado')
      ORDER BY CASE d.status WHEN 'abierto' THEN 0 WHEN 'reparado' THEN 1 ELSE 2 END,
               COALESCE(d.repaired_at, d.created_at) DESC, d.position
      LIMIT ${LIST_LIMIT}`,
    [vehicleId, includeVoided],
  );
  return rows.map(mapDamage);
}

async function getDamage(id) {
  const { rows } = await db.query(
    `SELECT ${DAMAGE_COLUMNS}
       FROM vehicle_damages d JOIN vehicle_physical_reviews r ON r.id = d.review_id
      WHERE d.id = $1`,
    [id],
  );
  return mapDamage(rows[0] || null);
}

/** Foto con lo necesario para decidir si se entrega. */
async function getPhoto(id) {
  const { rows } = await db.query(
    `SELECT p.id, p.kind, p.storage_path, d.id AS damage_id, d.status AS damage_status,
            d.vehicle_id, r.created_by AS review_created_by
       FROM vehicle_damage_photos p
       JOIN vehicle_damages d ON d.id = p.damage_id
       JOIN vehicle_physical_reviews r ON r.id = d.review_id
      WHERE p.id = $1`,
    [id],
  );
  return rows[0] || null;
}

/** Rutas de las fotos (en orden) de varios daños, para el PDF. */
async function photoPaths(damageIds) {
  if (!damageIds.length) return new Map();
  const { rows } = await db.query(
    `SELECT id, damage_id, kind, storage_path FROM vehicle_damage_photos
      WHERE damage_id = ANY($1::bigint[]) ORDER BY damage_id, kind, position`,
    [damageIds],
  );
  const map = new Map();
  rows.forEach((r) => {
    const key = String(r.damage_id);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(r);
  });
  return map;
}

// ---------------------------------------------------------------------------
// Reparación y anulación
// ---------------------------------------------------------------------------

/**
 * Marca reparado un daño abierto, con sus fotos ya procesadas. null si el
 * daño no existe o ya no está abierto (las fotos subidas se borran).
 */
async function repairDamage(id, values, repairPhotos, userId, deps = {}) {
  const year = Number(values.repaired_on.slice(0, 4));
  const subidas = await photos.storeAll(
    repairPhotos.map((p, j) => ({ ...p, name: `reparacion-${j + 1}.jpg` })),
    photos.newFolder("reparaciones", year),
    deps,
  );
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const signer = await userDisplayName(client, userId);
    const { rows } = await client.query(
      `UPDATE vehicle_damages
          SET status = 'reparado', repaired_on = $2, repair_note = $3,
              repaired_by = $4, repaired_by_name = $5, repaired_at = NOW()
        WHERE id = $1 AND status = 'abierto'
        RETURNING id, vehicle_id, zone_label`,
      [id, values.repaired_on, values.repair_note, userId ?? null, signer],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      await photos.removeAll(subidas.map((s) => s.storage_path), deps);
      return null;
    }
    await insertPhotos(client, id, "reparacion", subidas, userId);
    await client.query("COMMIT");
    return rows[0];
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    await photos.removeAll(subidas.map((s) => s.storage_path), deps);
    throw err;
  } finally {
    client.release();
  }
}

/** Anula una revisión registrada y sus daños. null si no existe o ya estaba anulada. */
async function voidPhysicalReview(id, reason, userId) {
  const motivo = cleanText(reason, 300);
  if (motivo.length < 5) throw new PhysicalError("Explica en pocas palabras por qué se anula.", "PHYSICAL_VOID_REASON");
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `UPDATE vehicle_physical_reviews
          SET status = 'voided', void_reason = $2, voided_at = NOW(), voided_by = $3
        WHERE id = $1 AND status = 'registered'
        RETURNING id, number_year, number_seq, vehicle_id`,
      [id, motivo, userId ?? null],
    );
    if (!rows[0]) {
      await client.query("ROLLBACK");
      return null;
    }
    await client.query("UPDATE vehicle_damages SET status = 'anulado' WHERE review_id = $1", [id]);
    await client.query("COMMIT");
    return withNumber(rows[0]);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  LIST_LIMIT,
  PhysicalError,
  damageKey,
  photoField,
  captureField,
  normalizePhysicalInput,
  normalizeRepairInput,
  createPhysicalReview,
  listPhysicalReviews,
  getPhysicalReview,
  listDamages,
  getDamage,
  getPhoto,
  photoPaths,
  repairDamage,
  voidPhysicalReview,
};
