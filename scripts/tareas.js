#!/usr/bin/env node
/**
 * Tareas programadas desde el cron del servidor (cPanel → Cron Jobs).
 *
 *   node scripts/tareas.js --pais CL                 → corre las que tocan
 *   node scripts/tareas.js --pais CL tickets-cierre  → sólo esa, si toca
 *   node scripts/tareas.js --pais PE gastos-purga --forzar
 *
 * Programarlo cada 15 minutos por país basta: cada tarea corre sólo cuando
 * venció su periodo (lo decide <schema>.job_runs), así que no se duplica con
 * la app ni con otro cron. Con el cron funcionando, define IN_PROCESS_JOBS=false
 * en la app para que deje de revisar por su cuenta.
 *
 * Sale con código 1 si alguna tarea falló.
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

const USO = "Uso: node scripts/tareas.js --pais CL|PE [nombre-de-tarea] [--forzar]";
const PAIS = leerArg("--pais").toUpperCase();
if (!["CL", "PE"].includes(PAIS)) {
  console.error(USO);
  process.exit(1);
}
process.env.COUNTRY = PAIS;
require("../src/config/supabaseProjects").applyCountryPoolerUser(process.env);

const FORZAR = process.argv.includes("--forzar");
const TAREA = process.argv.slice(2).find((arg, i, all) => !arg.startsWith("--") && all[i - 1] !== "--pais");

const db = require("../src/db");
const { isFeatureEnabled } = require("../src/config/features");
const { getCountryDbBinding } = require("../src/config/supabaseProjects");
const { createJobRunner, defaultJobs } = require("../src/services/jobs/jobRunner");

(async () => {
  const runner = createJobRunner({
    db,
    schema: getCountryDbBinding(PAIS).schema,
    jobs: defaultJobs({ db, isFeatureEnabled }),
  });
  let fallo = false;
  try {
    const resultados = TAREA
      ? [await runner.runJob(TAREA, { force: FORZAR })]
      : await runner.runDue({ force: FORZAR });
    for (const r of resultados) {
      console.log(`${PAIS} ${r.name}: ${r.status}${r.message ? ` — ${r.message}` : ""}`);
      if (r.status === "error") fallo = true;
    }
  } catch (err) {
    console.error(err.message || err);
    fallo = true;
  } finally {
    await db.pool.end().catch(() => {});
  }
  process.exitCode = fallo ? 1 : 0;
})();
