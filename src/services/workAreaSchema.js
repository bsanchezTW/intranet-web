const db = require("../db");
const logger = require("../utils/logger");
const {
  DEFAULT_COLOR,
  WORK_AREA_COLORS,
  WORK_AREA_ID_MIN,
  WORK_AREA_ID_MAX,
} = require("../constants/workAreas");

async function installFourDigitIdFunctions(client) {
  await client.query(`
    CREATE OR REPLACE FUNCTION next_four_digit_id(p_table text)
    RETURNS integer
    LANGUAGE plpgsql
    AS $fn$
    DECLARE
      candidate integer;
      found_id integer;
      i integer;
    BEGIN
      IF p_table IS NULL OR p_table !~ '^[a-z0-9_]+$' THEN
        RAISE EXCEPTION 'tabla inválida para ID de 4 dígitos';
      END IF;
      FOR i IN 1..80 LOOP
        candidate := ${WORK_AREA_ID_MIN} + floor(random() * ${
          WORK_AREA_ID_MAX - WORK_AREA_ID_MIN + 1
        })::integer;
        found_id := NULL;
        EXECUTE format('SELECT 1 FROM %I.%I WHERE id = $1', current_schema(), p_table)
          INTO found_id
          USING candidate;
        IF found_id IS NULL THEN
          RETURN candidate;
        END IF;
      END LOOP;
      RAISE EXCEPTION 'No fue posible generar un ID de 4 dígitos para %.%', current_schema(), p_table;
    END;
    $fn$;
  `);

  await client.query(`
    CREATE OR REPLACE FUNCTION assign_four_digit_id()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $fn$
    BEGIN
      IF NEW.id IS NULL
         OR NEW.id < ${WORK_AREA_ID_MIN}
         OR NEW.id > ${WORK_AREA_ID_MAX} THEN
        NEW.id := next_four_digit_id(TG_TABLE_NAME);
      END IF;
      RETURN NEW;
    END;
    $fn$;
  `);
}

async function dropWorkAreaIdentity(client) {
  const { rows } = await client.query(`
    SELECT a.attidentity AS ident
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'work_areas'
      AND a.attname = 'id'
      AND NOT a.attisdropped
  `);
  const ident = rows[0] && rows[0].ident;
  if (ident) {
    try {
      await client.query(
        "ALTER TABLE work_areas ALTER COLUMN id DROP IDENTITY IF EXISTS",
      );
    } catch (err) {
      logger.warn("areas", err);
    }
  }
  const { rows: after } = await client.query(`
    SELECT a.attidentity AS ident, a.atthasdef AS has_default
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = current_schema()
      AND c.relname = 'work_areas'
      AND a.attname = 'id'
      AND NOT a.attisdropped
  `);
  if (after[0] && after[0].ident) return;
  if (after[0] && after[0].has_default) {
    try {
      await client.query("ALTER TABLE work_areas ALTER COLUMN id DROP DEFAULT");
    } catch (err) {
      logger.warn("areas", err);
    }
  }
}

async function installWorkAreaIdTrigger(client) {
  await client.query("DROP TRIGGER IF EXISTS trg_four_digit_id ON work_areas");
  await client.query(`
    CREATE TRIGGER trg_four_digit_id
      BEFORE INSERT ON work_areas
      FOR EACH ROW
      EXECUTE FUNCTION assign_four_digit_id()
  `);
}

async function addWorkAreaIdRangeCheck(client) {
  await client.query(`
    DO $do$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = con.connamespace
        WHERE con.conname = 'work_areas_id_range'
          AND c.relname = 'work_areas'
          AND n.nspname = current_schema()
      ) THEN
        ALTER TABLE work_areas
          ADD CONSTRAINT work_areas_id_range
          CHECK (id >= ${WORK_AREA_ID_MIN} AND id <= ${WORK_AREA_ID_MAX});
      END IF;
    END
    $do$;
  `);
}

/**
 * Asegura color, trigger de ID 4 dígitos en altas nuevas, y matices
 * históricos si el área sigue con el gris por defecto. No remapea ids
 * existentes.
 */
async function ensureWorkAreaSchema() {
  const client = await db.getClient();
  try {
    await client.query(
      `ALTER TABLE work_areas
         ADD COLUMN IF NOT EXISTS color VARCHAR(7) NOT NULL DEFAULT '${DEFAULT_COLOR}'`,
    );

    await installFourDigitIdFunctions(client);
    await dropWorkAreaIdentity(client);
    await installWorkAreaIdTrigger(client);
    await addWorkAreaIdRangeCheck(client);

    const names = Object.keys(WORK_AREA_COLORS);
    const colors = Object.values(WORK_AREA_COLORS);
    if (!names.length) return;

    await client.query(
      `UPDATE work_areas w
       SET color = v.color
       FROM UNNEST($1::varchar[], $2::varchar[]) AS v(area_name, color)
       WHERE w.area_name = v.area_name
         AND (w.color IS NULL OR lower(w.color) = lower($3))`,
      [names, colors, DEFAULT_COLOR],
    );
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { ensureWorkAreaSchema };
