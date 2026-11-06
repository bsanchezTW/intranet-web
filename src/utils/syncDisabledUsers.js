const db = require("../db");

/**
 * Sin correo o sin verificar → cuenta inactiva.
 * Con correo (aunque no verificado) → siguen en la intranet (is_intranet_user = TRUE).
 * Sin correo → fuera de la intranet (is_intranet_user = FALSE).
 */
async function syncUnverifiedUsersToDisabled() {
  const sql = `
    UPDATE users
    SET active = FALSE,
        is_intranet_user = (email IS NOT NULL AND BTRIM(email) <> '')
    WHERE (
      email IS NULL
      OR BTRIM(email) = ''
      OR COALESCE(email_confirmed, FALSE) = FALSE
    )
    AND (
      active IS DISTINCT FROM FALSE
      OR is_intranet_user IS DISTINCT FROM (email IS NOT NULL AND BTRIM(email) <> '')
    )
    RETURNING id
  `;

  const result = await db.query(sql);
  return result.rowCount || 0;
}

module.exports = { syncUnverifiedUsersToDisabled };
