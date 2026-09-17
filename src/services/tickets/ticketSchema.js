const db = require("../../db");
const { getCountryDbBinding } = require("../../config/supabaseProjects");
const { LEGACY_TICKET_CATEGORIES } = require("../../constants/ticketCategories");

/**
 * Lleva las categorías del formulario anterior ('SAP', 'Hardware', ...) a las
 * claves actuales. Idempotente: una vez migradas, no vuelve a tocar filas.
 * @returns {Promise<number>} filas actualizadas
 */
async function migrateTicketCategories() {
  const legacy = Object.keys(LEGACY_TICKET_CATEGORIES);
  const { rowCount } = await db.query(
    `UPDATE support_tickets t
        SET category = m.new_key
       FROM UNNEST($1::text[], $2::text[]) AS m(old_value, new_key)
      WHERE t.category = m.old_value`,
    [legacy, legacy.map((value) => LEGACY_TICKET_CATEGORIES[value])],
  );
  return rowCount;
}

async function installReplyIdFunction(client, role) {
  await client.query(`
    CREATE OR REPLACE FUNCTION assign_ticket_reply_id()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path FROM CURRENT
    AS $fn$
    BEGIN
      IF NEW.ticket_id IS NULL THEN
        RAISE EXCEPTION 'ticket_id es obligatorio';
      END IF;
      PERFORM 1 FROM support_tickets WHERE id = NEW.ticket_id FOR UPDATE;
      IF NEW.id IS NULL OR NEW.id <= 0 THEN
        SELECT COALESCE(MAX(id), 0) + 1
          INTO NEW.id
          FROM ticket_replies
         WHERE ticket_id = NEW.ticket_id;
      END IF;
      RETURN NEW;
    END;
    $fn$;
  `);
  await client.query("REVOKE ALL ON FUNCTION assign_ticket_reply_id() FROM PUBLIC");
  await client.query(`GRANT EXECUTE ON FUNCTION assign_ticket_reply_id() TO ${role}`);
}

/**
 * El id de una respuesta es 1, 2, 3… dentro de su ticket, no un identity
 * global. Remapea filas viejas, deja la PK (ticket_id, id) y el trigger.
 */
async function ensureTicketReplyCorrelatives() {
  const { role } = getCountryDbBinding(process.env.COUNTRY);
  const client = await db.getClient();
  try {
    await installReplyIdFunction(client, role);

    const { rows: pkRows } = await client.query(`
      SELECT c.conname, pg_get_constraintdef(c.oid) AS def
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema()
         AND t.relname = 'ticket_replies'
         AND c.contype = 'p'
    `);
    const { rows: identRows } = await client.query(`
      SELECT a.attidentity
        FROM pg_attribute a
        JOIN pg_class t ON t.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = t.relnamespace
       WHERE n.nspname = current_schema()
         AND t.relname = 'ticket_replies'
         AND a.attname = 'id'
         AND NOT a.attisdropped
    `);

    const pk = pkRows[0];
    const hasCompositePk = Boolean(pk?.def && /ticket_id/i.test(pk.def));
    const hasIdentity = Boolean(identRows[0]?.attidentity);

    const { rows: outOfOrder } = hasCompositePk && !hasIdentity
      ? { rows: [] }
      : await client.query(`
          SELECT 1
            FROM (
              SELECT id,
                     row_number() OVER (
                       PARTITION BY ticket_id ORDER BY created_at, id
                     ) AS n
                FROM ticket_replies
               WHERE ticket_id IS NOT NULL
            ) s
           WHERE s.id <> s.n
           LIMIT 1
        `);

    if (!hasCompositePk || hasIdentity || outOfOrder.length) {
      await client.query("BEGIN");
      try {
        await client.query("LOCK TABLE ticket_replies IN ACCESS EXCLUSIVE MODE");
        await client.query(
          "ALTER TABLE ticket_replies ALTER COLUMN id DROP IDENTITY IF EXISTS",
        );
        if (pk?.conname) {
          if (!/^[a-z_][a-z0-9_]*$/i.test(pk.conname)) {
            throw new Error(`Nombre de PK inesperado en ticket_replies: ${pk.conname}`);
          }
          await client.query(
            `ALTER TABLE ticket_replies DROP CONSTRAINT ${pk.conname}`,
          );
        }
        await client.query(
          "UPDATE ticket_replies SET id = id + 2000000000 WHERE id < 2000000000",
        );
        await client.query(`
          UPDATE ticket_replies r
             SET id = n.n
            FROM (
              SELECT ctid,
                     row_number() OVER (
                       PARTITION BY ticket_id ORDER BY created_at, id
                     ) AS n
                FROM ticket_replies
            ) n
           WHERE r.ctid = n.ctid
        `);
        await client.query(
          "ALTER TABLE ticket_replies ALTER COLUMN ticket_id SET NOT NULL",
        );
        await client.query(`
          ALTER TABLE ticket_replies
            ADD CONSTRAINT ticket_replies_pkey PRIMARY KEY (ticket_id, id)
        `);
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }

    await client.query("DROP TRIGGER IF EXISTS trg_ticket_reply_id ON ticket_replies");
    await client.query(`
      CREATE TRIGGER trg_ticket_reply_id
        BEFORE INSERT ON ticket_replies
        FOR EACH ROW EXECUTE FUNCTION assign_ticket_reply_id()
    `);
  } finally {
    client.release();
  }
}

module.exports = { migrateTicketCategories, ensureTicketReplyCorrelatives };
