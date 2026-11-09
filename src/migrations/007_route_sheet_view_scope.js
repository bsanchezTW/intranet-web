/**
 * Hojas de ruta: `logistica.hoja_ruta.ver` pasa a tener alcance (lo propio o
 * todo), como las revisiones de la flota.
 *
 * Una concesión sin alcance de un permiso que ahora lo pide deja de contar
 * (resolver.js), así que las que había se pasan a «todo»: antes de esto el
 * permiso no distinguía y daba lo mismo que hoy da «todo». Igual en los
 * conjuntos (perm_set_items), donde se quita antes la fila sin alcance si el
 * conjunto ya tenía la de «todo». Las denegaciones no cambian.
 *
 * En una base desde cero las tablas de permisos aún no existen (las crea
 * permissionSchema.js después de las migraciones) y no hay nada que pasar.
 */
const KEY = "logistica.hoja_ruta.ver";

module.exports = {
  id: "007_route_sheet_view_scope",
  async up(client) {
    const { rows } = await client.query(
      "SELECT to_regclass('perm_assignments') IS NOT NULL AS a, to_regclass('perm_set_items') IS NOT NULL AS s",
    );
    const hay = { assignments: Boolean(rows[0] && rows[0].a), sets: Boolean(rows[0] && rows[0].s) };
    let changed = 0;

    if (hay.assignments) {
      const res = await client.query(
        `UPDATE perm_assignments SET scope = 'todo'
          WHERE permission_key = $1 AND scope IS NULL AND effect = 'concede'`,
        [KEY],
      );
      changed += res.rowCount;
    }

    if (hay.sets) {
      await client.query(
        `DELETE FROM perm_set_items n
          WHERE n.permission_key = $1 AND n.scope IS NULL
            AND EXISTS (SELECT 1 FROM perm_set_items t
                         WHERE t.set_id = n.set_id AND t.permission_key = $1 AND t.scope = 'todo')`,
        [KEY],
      );
      const res = await client.query(
        "UPDATE perm_set_items SET scope = 'todo' WHERE permission_key = $1 AND scope IS NULL",
        [KEY],
      );
      changed += res.rowCount;
    }

    if (changed && hay.assignments) {
      await client.query(
        `INSERT INTO perm_audit (actor_user_id, action, entity_type, note)
         VALUES (NULL, 'permiso.alcance', 'sistema', $1)`,
        [`${KEY} ahora tiene alcance: ${changed} concesión(es) sin alcance pasan a «todo».`],
      );
      await client.query("UPDATE perm_meta SET version = version + 1, updated_at = NOW() WHERE id = 1");
    }
  },
};
