const db = require("../../db");
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

module.exports = { migrateTicketCategories };
