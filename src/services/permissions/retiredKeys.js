/**
 * Permisos que salieron del catálogo porque no protegían nada. Sus
 * asignaciones se borran una vez al iniciar (quedan en perm_audit con su
 * valor anterior). Si no queda ninguna, no hace nada.
 *
 *   centros_costo.centro.campo.documento_identidad  la página nunca mostró el RUT
 *   gastos.solicitud.campo.documento_identidad      el RUT lo ven quien pidió y
 *                                                   quienes pueden aprobar
 *   gastos.solicitud.exportar                       no existe una exportación
 */
const RETIRED_KEYS = Object.freeze([
  "centros_costo.centro.campo.documento_identidad",
  "gastos.solicitud.campo.documento_identidad",
  "gastos.solicitud.exportar",
]);

async function removeRetiredAssignments({ db, logger }) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      "DELETE FROM perm_assignments WHERE permission_key = ANY($1::text[]) RETURNING *",
      [RETIRED_KEYS],
    );
    if (!rows.length) {
      await client.query("ROLLBACK");
      return 0;
    }
    await client.query(
      `INSERT INTO perm_audit (actor_user_id, action, entity_type, old_value, note)
       VALUES (NULL, 'permiso.retirar', 'sistema', $1::jsonb, $2)`,
      [JSON.stringify(rows), `Permisos retirados del catálogo: ${RETIRED_KEYS.join(", ")}`],
    );
    await client.query("UPDATE perm_meta SET version = version + 1, updated_at = NOW() WHERE id = 1");
    await client.query("COMMIT");
    if (logger) logger.info("permisos", `${rows.length} asignación(es) de permisos retirados borradas.`);
    return rows.length;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { RETIRED_KEYS, removeRetiredAssignments };
