#!/usr/bin/env node
/**
 * Lanzador de desarrollo por país.
 *
 *   npm run dev:cl   → Chile en :3000
 *   npm run dev:pe   → Perú en :3001
 *
 * Un solo .env con secretos compartidos (BD, Supabase, Brevo). Este script
 * fija la identidad de la instancia (COUNTRY, puerto, URL, bucket) para
 * poder levantar las dos a la vez sin dos archivos de entorno.
 *
 * PowerShell no propaga `COUNTRY=CL npm run dev`; por eso el país va en --country.
 *
 * Precedencia (de mayor a menor):
 *   1. este lanzador (país, puerto, URL local, bucket)
 *   2. variables ya presentes en el proceso
 *   3. .env / .env.local  → secretos compartidos
 */

const path = require("path");
const fs = require("fs");
const dotenv = require("dotenv");
const logger = require("../src/utils/logger");
const { getCountryConfig, isValidCountryCode } = require("../src/config/country");
const {
  defaultStorageBucketForCountry,
  getCountryDbBinding,
  applyCountryPoolerUser,
} = require("../src/config/supabaseProjects");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    const match = arg.match(/^--([^=]+)=(.*)$/);
    if (match) args[match[1]] = match[2];
  }
  return args;
}

function loadSharedEnv() {
  const quiet = { quiet: true };
  dotenv.config({ path: path.join(ROOT, ".env"), ...quiet });
  dotenv.config({ path: path.join(ROOT, ".env.local"), ...quiet });
}

const args = parseArgs(process.argv);
const country = String(args.country || "").trim().toUpperCase();

if (!country || !isValidCountryCode(country)) {
  logger.error("dev", "Falta --country. Uso: npm run dev:cl   o   npm run dev:pe");
  process.exit(1);
}

const config = getCountryConfig(country);
const port = args.port ? Number(args.port) : config.devPort;
const baseUrl =
  args["base-url"]?.trim() || `http://localhost:${port}`;

loadSharedEnv();

// La identidad gana siempre: si .env trae APP_BASE_URL o el bucket de Chile,
// Perú en :3001 no debe heredarlos.
process.env.COUNTRY = country;
process.env.PORT = String(port);
process.env.APP_BASE_URL = baseUrl;
process.env.SUPABASE_STORAGE_BUCKET = defaultStorageBucketForCountry(country);

const dbBinding = getCountryDbBinding(country);
applyCountryPoolerUser(process.env);

if (!fs.existsSync(path.join(ROOT, ".env")) && !fs.existsSync(path.join(ROOT, ".env.local"))) {
  logger.warn("dev", "No hay .env en la raíz. Copia .env.example y completa las credenciales.");
}

logger.info(
  "dev",
  `${config.name}  ${baseUrl}  schema=${dbBinding.schema}  bucket=${process.env.SUPABASE_STORAGE_BUCKET}`,
);

require(path.join(ROOT, "src", "app.js"));
