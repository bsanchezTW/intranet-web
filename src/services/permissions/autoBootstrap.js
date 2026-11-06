const { planBootstrap } = require("./bootstrap");

/** Personas para el plan: el rol antiguo sale de role_legacy (fase 11). */
const USERS_SQL =
  "SELECT id, first_name, last_name, active, role_legacy AS role, work_area_id, is_intranet_user FROM users";

/**
 * Arranque de Gestión de Permisos: aplicar el plan (bootstrap.js) y, desde
 * que se quitó el modo sombra, hacerlo solo al iniciar la app si el país
 * nunca lo corrió. Sin arranque nadie salvo el superadmin tendría permisos.
 *
 * El plan crea conjuntos de permisos (el formato de siempre); la conversión
 * a conjuntos de personas (setConversion.js) corre justo después y los
 * transforma igual que a los que ya existían.
 */

async function applyBootstrap(db, plan, { note = "Copia de los permisos vigentes" } = {}) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    // Una segunda corrida en paralelo espera aquí y luego ve bootstrapped_at.
    const { rows: meta } = await client.query("SELECT bootstrapped_at FROM perm_meta WHERE id = 1 FOR UPDATE");
    if (meta[0] && meta[0].bootstrapped_at) {
      await client.query("ROLLBACK");
      return { applied: false };
    }

    const idPorCodigo = new Map();
    for (const set of plan.sets) {
      const { rows } = await client.query(
        `INSERT INTO perm_sets (code, name, description)
         VALUES ($1, $2, $3)
         ON CONFLICT (code) DO UPDATE
           SET name = EXCLUDED.name, description = EXCLUDED.description, updated_at = NOW()
         RETURNING id`,
        [set.code, set.name, set.description],
      );
      const setId = rows[0].id;
      idPorCodigo.set(set.code, setId);
      await client.query("DELETE FROM perm_set_items WHERE set_id = $1", [setId]);
      for (const i of set.items) {
        await client.query(
          `INSERT INTO perm_set_items (set_id, permission_key, scope, scope_area_ids, scope_include_subareas)
           VALUES ($1, $2, $3, $4, $5)`,
          [setId, i.permission_key, i.scope, i.scope_area_ids, i.scope_include_subareas],
        );
      }
    }

    for (const a of plan.assignments) {
      await client.query(
        `INSERT INTO perm_assignments (principal_type, area_id, user_id, include_subareas, set_id, effect, note)
         VALUES ($1, $2, $3, $4, $5, 'concede', $6)`,
        [a.principal_type, a.area_id, a.user_id, a.include_subareas, idPorCodigo.get(a.set_code), `Arranque: ${a.why}`],
      );
    }

    const superIds = plan.superadmins.map((u) => Number(u.id));
    if (superIds.length) {
      await client.query("UPDATE users SET is_superadmin = TRUE WHERE id = ANY($1::int[])", [superIds]);
    }

    await client.query(
      `INSERT INTO perm_audit (actor_user_id, action, entity_type, new_value, note)
       VALUES (NULL, 'arranque', 'sistema', $1::jsonb, $2)`,
      [
        JSON.stringify({
          sets: plan.sets.map((s) => ({ code: s.code, items: s.items.length })),
          assignments: plan.assignments.map((a) => ({
            set: a.set_code,
            principal: a.principal_type,
            area_id: a.area_id,
            user_id: a.user_id,
          })),
          superadmins: superIds,
        }),
        note,
      ],
    );
    await client.query(
      "UPDATE perm_meta SET bootstrapped_at = NOW(), version = version + 1, updated_at = NOW() WHERE id = 1",
    );
    await client.query("COMMIT");
    return { applied: true };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Al iniciar: si el país no tiene arranque, lo aplica. Los problemas del
 * plan sólo tocan al superadmin (no encontrarlo por nombre): se anotan y el
 * arranque se aplica igual, porque sin él nadie tendría permisos. Un
 * superadmin se recupera con scripts/superadmin.js.
 */
async function ensureBootstrapped({ db, country, catalog, logger }) {
  const { rows } = await db.query("SELECT bootstrapped_at FROM perm_meta WHERE id = 1");
  if (rows[0] && rows[0].bootstrapped_at) return { applied: false };

  const [{ rows: users }, { rows: areas }] = await Promise.all([
    db.query(USERS_SQL),
    db.query("SELECT id, area_name, parent_area_id, manager_user_id FROM work_areas"),
  ]);
  const plan = planBootstrap({ country, catalog, users, areas });
  for (const p of plan.problems) logger.warn("permisos.arranque", p);
  for (const w of plan.warnings) logger.warn("permisos.arranque", w);
  const result = await applyBootstrap(db, plan, { note: "Copia de los permisos vigentes (automática al iniciar)" });
  if (result.applied) {
    logger.info(
      "permisos.arranque",
      `Arranque aplicado en ${country}: ${plan.sets.length} conjuntos y ${plan.assignments.length} asignaciones.`,
    );
  }
  return result;
}

module.exports = { applyBootstrap, ensureBootstrapped };
