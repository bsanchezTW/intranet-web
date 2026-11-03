#!/usr/bin/env node
/**
 * Aplica las migraciones pendientes de un país (src/migrations).
 *
 *   node scripts/migrar.js --pais CL
 *
 * La app también las aplica al arrancar; esto sirve para correrlas antes de
 * un despliegue y ver el resultado. Sale con código 1 si una falla.
 */

const path = require("path");
const dotenv = require("dotenv");

const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });

const i = process.argv.indexOf("--pais");
const PAIS = String(i >= 0 ? process.argv[i + 1] || "" : "").toUpperCase();
if (!["CL", "PE"].includes(PAIS)) {
  console.error("Uso: node scripts/migrar.js --pais CL|PE");
  process.exit(1);
}
process.env.COUNTRY = PAIS;
require("../src/config/supabaseProjects").applyCountryPoolerUser(process.env);

const db = require("../src/db");
const { getCountryDbBinding } = require("../src/config/supabaseProjects");
const { runMigrations } = require("../src/services/schema/migrator");
const migrations = require("../src/migrations");

(async () => {
  try {
    const { applied, skipped } = await runMigrations({
      connect: () => db.pool.connect(),
      schema: getCountryDbBinding(PAIS).schema,
      migrations,
      logger: { info: () => {} },
    });
    console.log(`${PAIS}: aplicadas ${applied.length ? applied.join(", ") : "ninguna"}; ya estaban ${skipped.length}.`);
    process.exitCode = 0;
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
})();
