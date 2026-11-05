/**
 * Conversión única de los antiguos conjuntos de PERMISOS a lo de ahora:
 * permisos que se dan de a uno y conjuntos de PERSONAS.
 *
 * Nadie gana ni pierde nada (lo prueba test/permissions-set-conversion):
 *
 *   - Un conjunto dado a Todos, a un área o a los jefes se reparte en una
 *     asignación por cada permiso, al mismo destinatario, con el mismo
 *     efecto, vigencia, motivo y el alcance de cada ítem.
 *   - Un conjunto dado a personas que lo CONCEDEN SIN VIGENCIA pasa a ser un
 *     conjunto de personas con el mismo nombre: esas personas son sus
 *     miembros y cada permiso se le asigna al conjunto. Lo de un conjunto
 *     vale como lo individual (nivel Usuario en resolver.js), así que la
 *     precedencia no cambia.
 *   - A personas con vigencia o que lo DENIEGAN: asignaciones individuales
 *     por permiso, para no perder la fecha ni la denegación.
 *   - Conjuntos desactivados (no concedían nada) y claves que el país no
 *     tiene no se copian; quedan anotados.
 *
 * Al final se borran las asignaciones con set_id. Las tablas perm_sets y
 * perm_set_items quedan como respaldo. Si no hay nada que convertir, no hace
 * nada.
 */

function toId(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * Plan puro.
 *   sets: Map(id → { id, code, name, description, active, items: [...] })
 *   assignments: filas de perm_assignments (sólo se miran las con set_id)
 * Devuelve { groups, assignments, deleteIds, skipped }:
 *   groups: [{ setId, name, description, memberIds, items }]
 *   assignments: filas nuevas por permiso (sin group_id: las del grupo van en groups)
 */
function planSetConversion({ sets, assignments, catalog }) {
  const out = [];
  const deleteIds = [];
  const skipped = [];
  const groupsBySet = new Map();
  const seen = new Set();

  const push = (row) => {
    const k = JSON.stringify([
      row.principal_type, row.area_id, row.user_id, row.include_subareas, row.permission_key,
      row.scope, row.scope_area_ids, row.scope_include_subareas, row.effect,
      row.valid_from ? new Date(row.valid_from).getTime() : null,
      row.valid_until ? new Date(row.valid_until).getTime() : null,
    ]);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(row);
  };

  for (const a of assignments || []) {
    if (a.set_id == null) continue;
    deleteIds.push(toId(a.id));
    const set = sets.get(toId(a.set_id));
    if (!set) {
      skipped.push({ assignmentId: toId(a.id), reason: "el conjunto ya no existe" });
      continue;
    }
    if (set.active === false) {
      skipped.push({ assignmentId: toId(a.id), set: set.name, reason: "conjunto desactivado: no concedía nada" });
      continue;
    }
    const items = (set.items || []).filter((i) => {
      if (catalog.byKey.has(i.permission_key)) return true;
      skipped.push({ assignmentId: toId(a.id), set: set.name, key: i.permission_key, reason: "permiso que no existe en este país" });
      return false;
    });
    const deny = a.effect === "deniega";

    if (a.principal_type === "user" && !deny && a.valid_from == null && a.valid_until == null) {
      if (!groupsBySet.has(set.id)) {
        groupsBySet.set(set.id, {
          setId: set.id,
          name: set.name,
          description: set.description || null,
          memberIds: new Set(),
          items,
        });
      }
      groupsBySet.get(set.id).memberIds.add(toId(a.user_id));
      continue;
    }

    for (const i of items) {
      push({
        principal_type: a.principal_type,
        area_id: toId(a.area_id),
        user_id: toId(a.user_id),
        include_subareas: Boolean(a.include_subareas),
        permission_key: i.permission_key,
        // Una denegación quita el permiso entero: sin alcance.
        scope: deny ? null : i.scope || null,
        scope_area_ids: deny ? [] : (i.scope_area_ids || []).map(Number),
        scope_include_subareas: deny ? false : Boolean(i.scope_include_subareas),
        effect: deny ? "deniega" : "concede",
        valid_from: a.valid_from || null,
        valid_until: a.valid_until || null,
        note: a.note || `Del conjunto «${set.name}»`,
        granted_by: toId(a.granted_by),
      });
    }
  }

  const groups = [...groupsBySet.values()].map((g) => ({ ...g, memberIds: [...g.memberIds] }));
  return { groups, assignments: out, deleteIds, skipped };
}

/**
 * Convierte en una transacción, si queda algo con set_id. Devuelve el
 * resumen o null si no había nada.
 */
async function convertSetsIfNeeded({ db, catalog, logger }) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    // Dos procesos que arrancan a la vez: el segundo espera y no ve nada.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('perm_set_conversion'))");
    const { rows: setAssignments } = await client.query(
      "SELECT * FROM perm_assignments WHERE set_id IS NOT NULL ORDER BY id",
    );
    if (!setAssignments.length) {
      await client.query("ROLLBACK");
      return null;
    }
    const { rows: setRows } = await client.query("SELECT id, code, name, description, active FROM perm_sets");
    const { rows: itemRows } = await client.query(
      "SELECT set_id, permission_key, scope, scope_area_ids, scope_include_subareas FROM perm_set_items",
    );
    const sets = new Map(setRows.map((s) => [Number(s.id), { ...s, id: Number(s.id), items: [] }]));
    for (const i of itemRows) {
      const set = sets.get(Number(i.set_id));
      if (set) set.items.push(i);
    }

    const plan = planSetConversion({ sets, assignments: setAssignments, catalog });

    const createdGroups = [];
    for (const g of plan.groups) {
      // Si ya hay un conjunto de personas con ese nombre, se usa ése.
      const { rows: existing } = await client.query("SELECT id FROM perm_groups WHERE LOWER(name) = LOWER($1)", [g.name]);
      let groupId;
      if (existing.length) {
        groupId = Number(existing[0].id);
      } else {
        const { rows } = await client.query(
          "INSERT INTO perm_groups (name, description) VALUES ($1, $2) RETURNING id",
          [g.name.slice(0, 120), g.description],
        );
        groupId = Number(rows[0].id);
      }
      for (const userId of g.memberIds) {
        await client.query(
          "INSERT INTO perm_group_members (group_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
          [groupId, userId],
        );
      }
      for (const i of g.items) {
        await client.query(
          `INSERT INTO perm_assignments
             (principal_type, group_id, permission_key, scope, scope_area_ids, scope_include_subareas, effect, note)
           VALUES ('grupo', $1, $2, $3, $4, $5, 'concede', $6)`,
          [groupId, i.permission_key, i.scope || null, (i.scope_area_ids || []).map(Number), Boolean(i.scope_include_subareas), `Del conjunto «${g.name}»`],
        );
      }
      createdGroups.push({ id: groupId, name: g.name, members: g.memberIds.length, permisos: g.items.length });
    }

    for (const a of plan.assignments) {
      await client.query(
        `INSERT INTO perm_assignments
           (principal_type, area_id, user_id, include_subareas, permission_key, scope, scope_area_ids,
            scope_include_subareas, effect, valid_from, valid_until, note, granted_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
        [
          a.principal_type, a.area_id, a.user_id, a.include_subareas, a.permission_key, a.scope,
          a.scope_area_ids, a.scope_include_subareas, a.effect, a.valid_from, a.valid_until, a.note, a.granted_by,
        ],
      );
    }

    await client.query("DELETE FROM perm_assignments WHERE id = ANY($1::int[])", [plan.deleteIds]);
    const summary = {
      convertidas: plan.deleteIds.length,
      conjuntosDePersonas: createdGroups,
      asignacionesNuevas: plan.assignments.length,
      omitidas: plan.skipped,
    };
    await client.query(
      `INSERT INTO perm_audit (actor_user_id, action, entity_type, old_value, new_value, note)
       VALUES (NULL, 'conjunto.convertir', 'sistema', $1::jsonb, $2::jsonb, $3)`,
      [
        JSON.stringify(setAssignments),
        JSON.stringify(summary),
        "Los conjuntos de permisos pasan a permisos de a uno y conjuntos de personas",
      ],
    );
    await client.query("UPDATE perm_meta SET version = version + 1, updated_at = NOW() WHERE id = 1");
    await client.query("COMMIT");
    if (logger) {
      logger.info(
        "permisos.conversion",
        `${plan.deleteIds.length} asignación(es) de conjuntos convertidas: ${createdGroups.length} conjunto(s) de personas y ${plan.assignments.length} asignación(es) por permiso.`,
      );
    }
    return summary;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { planSetConversion, convertSetsIfNeeded };
