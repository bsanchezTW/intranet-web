#!/usr/bin/env node
/**
 * Arranque de Gestión de Permisos en un país: crea los conjuntos iniciales y
 * las asignaciones que reproducen lo que cada persona puede hacer hoy, y
 * marca al superadmin. La lógica está en src/services/permissions/bootstrap.js.
 *
 *   node scripts/permisos-arranque.js --pais CL                      → muestra el plan
 *   node scripts/permisos-arranque.js --pais PE --aplicar            → lo aplica en una transacción
 *   node scripts/permisos-arranque.js --pais CL --superadmin "Nombre Apellido"
 *
 * Se aplica una sola vez por país (perm_meta.bootstrapped_at): después los
 * permisos se administran en la intranet. Si ya se aplicó, se detiene sin
 * tocar nada. Todo queda en perm_audit.
 *
 * Mientras perm_meta.mode sea 'sombra' las rutas siguen decidiendo con las
 * reglas antiguas: aplicar esto no cambia lo que nadie puede hacer.
 */

const path = require("path");
const dotenv = require("dotenv");

const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });

function leerArg(nombre) {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? String(process.argv[i + 1] || "") : "";
}

const PAIS = leerArg("--pais").toUpperCase();
if (!["CL", "PE"].includes(PAIS)) {
  console.error('Indica el país: node scripts/permisos-arranque.js --pais CL|PE [--aplicar] [--superadmin "Nombre Apellido"]');
  process.exit(1);
}
process.env.COUNTRY = PAIS;
require("../src/config/supabaseProjects").applyCountryPoolerUser(process.env);

const APLICAR = process.argv.includes("--aplicar");
const SUPERADMIN = leerArg("--superadmin") || "Bastián Sánchez";

const db = require("../src/db");
const logger = require("../src/utils/logger");
const { getCatalog } = require("../src/services/permissions/catalog");
const { planBootstrap } = require("../src/services/permissions/bootstrap");
const { ensurePermissionSchema } = require("../src/services/permissions/permissionSchema");
const { SCOPE_LABELS } = require("../src/services/permissions/scopes");

const LINEA = "─".repeat(72);

async function yaAplicado() {
  try {
    const { rows } = await db.query("SELECT bootstrapped_at FROM perm_meta WHERE id = 1");
    return rows[0] && rows[0].bootstrapped_at ? rows[0].bootstrapped_at : null;
  } catch (err) {
    if (err.code === "42P01") return null; // el schema aún no se crea
    throw err;
  }
}

async function cargarDatos() {
  const [{ rows: users }, { rows: areas }] = await Promise.all([
    db.query("SELECT id, first_name, last_name, role, work_area_id, is_intranet_user FROM users"),
    db.query("SELECT id, area_name, parent_area_id, manager_user_id FROM work_areas"),
  ]);
  return { users, areas };
}

function imprimir(plan, catalog) {
  const etiqueta = (key) => catalog.byKey.get(key)?.label || key;

  console.log("");
  console.log(`Conjuntos (${plan.sets.length})`);
  console.log(LINEA);
  for (const set of plan.sets) {
    console.log(`  ${set.name}  [${set.code}]`);
    for (const i of set.items) {
      console.log(`      · ${etiqueta(i.permission_key)}${i.scope ? ` — ${SCOPE_LABELS[i.scope]}` : ""}`);
    }
  }

  console.log("");
  console.log(`Asignaciones (${plan.assignments.length})`);
  console.log(LINEA);
  const porConjunto = new Map();
  for (const a of plan.assignments) {
    if (!porConjunto.has(a.set_code)) porConjunto.set(a.set_code, []);
    porConjunto.get(a.set_code).push(a);
  }
  for (const set of plan.sets) {
    const lista = porConjunto.get(set.code) || [];
    console.log(`  ${set.name}: ${lista.length ? "" : "(nadie)"}`);
    for (const a of lista) console.log(`      → ${a.name.padEnd(36)} ${a.why}`);
  }

  console.log("");
  console.log("Superadmin");
  console.log(LINEA);
  for (const u of plan.superadmins) console.log(`  ${[u.first_name, u.last_name].join(" ")} #${u.id}`);
  if (!plan.superadmins.length) console.log("  (nadie)");

  console.log("");
  console.log("Cambios respecto de hoy");
  console.log(LINEA);
  for (const c of plan.changes) console.log(`  · ${c}`);

  if (plan.warnings.length) {
    console.log("");
    console.log("Para revisar");
    console.log(LINEA);
    for (const w of plan.warnings) console.log(`  ! ${w}`);
  }
}

async function aplicar(plan) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    // Una segunda corrida en paralelo espera aquí y luego ve bootstrapped_at.
    const { rows: meta } = await client.query("SELECT bootstrapped_at FROM perm_meta WHERE id = 1 FOR UPDATE");
    if (meta[0] && meta[0].bootstrapped_at) throw new Error("El arranque ya se aplicó en este país.");

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
    await client.query("UPDATE users SET is_superadmin = TRUE WHERE id = ANY($1::int[])", [superIds]);

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
        "Copia de los permisos vigentes (scripts/permisos-arranque.js)",
      ],
    );
    await client.query(
      "UPDATE perm_meta SET bootstrapped_at = NOW(), version = version + 1, updated_at = NOW() WHERE id = 1",
    );

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function main() {
  const aplicado = await yaAplicado();
  if (aplicado) {
    logger.info("permisos", `El arranque ya se aplicó en ${PAIS} (${new Date(aplicado).toISOString()}). Los permisos se administran en la intranet.`);
    return;
  }

  const catalog = getCatalog(PAIS);
  const { users, areas } = await cargarDatos();
  const plan = planBootstrap({ country: PAIS, catalog, users, areas, superadminName: SUPERADMIN });
  imprimir(plan, catalog);

  console.log("");
  if (plan.problems.length) {
    for (const p of plan.problems) logger.error("permisos", p);
    logger.error("permisos", "Corrige lo anterior antes de aplicar (o usa --superadmin).");
    process.exitCode = 1;
    return;
  }
  if (!APLICAR) {
    logger.info("permisos", "Vista previa: no se escribió nada. Corre con --aplicar para guardar.");
    return;
  }

  await ensurePermissionSchema();
  await aplicar(plan);
  logger.info("permisos", `Arranque aplicado en ${PAIS}: ${plan.sets.length} conjuntos y ${plan.assignments.length} asignaciones.`);
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    logger.error("permisos", err);
    process.exit(1);
  });
