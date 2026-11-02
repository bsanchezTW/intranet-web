/**
 * Migraciones versionadas por país.
 *
 * Antes cada cambio de esquema era una función asegurar*() en app.js que se
 * corría en cada arranque, sin registro de qué se aplicó ni orden garantizado
 * entre procesos. Ahora cada cambio es un archivo en src/migrations/ con un id
 * ordenable ("001_…") y queda anotado en <schema>.schema_migrations.
 *
 * Cada migración corre en su propia transacción:
 *   BEGIN
 *   SET LOCAL search_path TO <schema>      ← el pooler en modo transacción
 *                                            ignora un SET de sesión
 *   LOCK TABLE <schema>.schema_migrations  ← dos procesos que arrancan a la
 *                                            vez no aplican lo mismo
 *   ¿ya está aplicada? → si no: up() + INSERT
 *   COMMIT
 * Si una falla se revierte entera y no se sigue con las siguientes.
 *
 * Las tablas de infraestructura que crea su propio módulo (sesiones, cupo
 * del asistente, tareas, correo) y las ensure*Schema de cada dominio quedan
 * fuera por ahora; los cambios nuevos al esquema van aquí.
 */

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const MIGRATION_ID = /^\d{3}_[a-z0-9_]+$/;

function validateMigrations(migrations) {
  const ids = new Set();
  let previous = "";
  for (const m of migrations) {
    if (!m || !MIGRATION_ID.test(String(m.id)) || typeof m.up !== "function") {
      throw new Error(`Migración inválida: ${m && m.id}`);
    }
    if (ids.has(m.id)) throw new Error(`Migración repetida: ${m.id}`);
    if (m.id <= previous) throw new Error(`Migraciones fuera de orden: ${m.id} va después de ${previous}`);
    ids.add(m.id);
    previous = m.id;
  }
}

/**
 * Aplica las pendientes. `connect` entrega un cliente de pg (pool.connect).
 * Devuelve { applied: [ids], skipped: [ids] }.
 */
async function runMigrations({ connect, schema, migrations, logger = console }) {
  if (!SCHEMA_NAME.test(String(schema || ""))) throw new Error(`migrator: schema inválido "${schema}"`);
  validateMigrations(migrations);
  const table = `${schema}.schema_migrations`;
  const applied = [];
  const skipped = [];

  const client = await connect();
  try {
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} (
         id         varchar(100) PRIMARY KEY,
         applied_at timestamptz  NOT NULL DEFAULT NOW()
       )`,
    );

    for (const migration of migrations) {
      await client.query("BEGIN");
      try {
        await client.query(`SET LOCAL search_path TO ${schema}`);
        await client.query(`LOCK TABLE ${table} IN EXCLUSIVE MODE`);
        const { rows } = await client.query(`SELECT 1 FROM ${table} WHERE id = $1`, [migration.id]);
        if (rows.length) {
          await client.query("COMMIT");
          skipped.push(migration.id);
          continue;
        }
        await migration.up(client, { schema });
        await client.query(`INSERT INTO ${table} (id) VALUES ($1)`, [migration.id]);
        await client.query("COMMIT");
        applied.push(migration.id);
        logger.info("migraciones", `${schema}: aplicada ${migration.id}`);
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        const wrapped = new Error(`La migración ${migration.id} falló: ${err.message}`);
        wrapped.cause = err;
        wrapped.migrationId = migration.id;
        throw wrapped;
      }
    }
  } finally {
    client.release();
  }
  return { applied, skipped };
}

module.exports = { runMigrations, validateMigrations };
