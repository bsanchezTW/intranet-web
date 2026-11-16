#!/usr/bin/env node
/**
 * Vacía las galerías de eventos en Supabase Storage para liberar cuota.
 *
 * Las fotos y videos de cada evento viven en eventos/<slug>/ dentro de los
 * buckets de Chile (intranet-content) y Perú (intranet-content-pe). No hay
 * filas por foto en la base: borrar los archivos vacía la galería. Los eventos
 * (nombre, fecha, descripción) no se tocan.
 *
 * Sin --confirmar solo muestra lo que borraría y cuánto espacio libera:
 *
 *   node scripts/vaciar-galerias.js
 *   node scripts/vaciar-galerias.js --solo-videos
 *   node scripts/vaciar-galerias.js --evento=aniversario-2025,fiestas-patrias
 *   node scripts/vaciar-galerias.js --pais=PE
 *
 * Para borrar de verdad, agrega --confirmar:
 *
 *   node scripts/vaciar-galerias.js --confirmar
 *   node scripts/vaciar-galerias.js --solo-videos --confirmar
 *
 * Opciones:
 *   --pais=CL|PE     solo el bucket de ese país (por defecto, los dos)
 *   --evento=a,b     solo esas galerías (slug del evento, separados por coma)
 *   --solo-videos    borra los videos y deja las fotos
 *   --confirmar      borra; sin esto es una simulación
 */

const path = require("node:path");
const dotenv = require("dotenv");

const ROOT = path.join(__dirname, "..");
const BATCH_SIZE = 500;
const VIDEO_EXT = new Set([".mp4", ".webm", ".avi", ".mov", ".mkv", ".m4v"]);

function parseArgs(argv) {
  const args = { confirmar: false, soloVideos: false, eventos: [], pais: "" };
  for (const arg of argv.slice(2)) {
    if (arg === "--confirmar") args.confirmar = true;
    else if (arg === "--solo-videos") args.soloVideos = true;
    else if (arg === "--dry-run") args.confirmar = false;
    else if (arg.startsWith("--evento=")) {
      args.eventos.push(
        ...arg
          .slice("--evento=".length)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      );
    } else if (arg.startsWith("--pais=")) {
      args.pais = arg.slice("--pais=".length).trim().toUpperCase();
    } else if (arg === "--help" || arg === "-h") {
      args.help = true;
    } else {
      throw new Error(`Opción desconocida: ${arg} (usa --help)`);
    }
  }
  return args;
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}

function isVideo(file) {
  const type = String(file.contentType || "");
  if (type.startsWith("video/")) return true;
  return VIDEO_EXT.has(path.extname(file.relativePath).toLowerCase());
}

function slugOf(relativePath) {
  return relativePath.split("/")[1] || "";
}

function isQuotaError(err) {
  const status = Number(err?.statusCode || err?.status || err?.cause?.statusCode);
  const text = `${err?.message || ""} ${JSON.stringify(err?.details || "")}`;
  return status === 402 || /restrict|quota|exceed|payment/i.test(text);
}

function explainQuotaError(err) {
  console.error(`\nSupabase rechazó la operación: ${err.message || err}`);
  console.error(
    "El proyecto parece estar restringido por exceder la cuota. Con la\n" +
      "restricción activa, Supabase bloquea también las llamadas a la API de\n" +
      "Storage (incluido borrar). Opciones:\n" +
      "  1. Subir temporalmente el plan (Pro) en el dashboard, correr este\n" +
      "     script con --confirmar y volver a bajar el plan.\n" +
      "  2. Pedir a soporte de Supabase que levante la restricción unas horas\n" +
      "     para poder liberar espacio.",
  );
}

async function collect(bucket, deps, args) {
  const storage = deps.createSupabaseStorageService({
    config: { ...deps.getStorageConfig(), bucket },
  });
  const all = await storage.listFilesRecursive("eventos");
  const wanted = new Set(args.eventos);
  return all.filter((file) => {
    if (wanted.size && !wanted.has(slugOf(file.relativePath))) return false;
    if (args.soloVideos && !isVideo(file)) return false;
    return true;
  });
}

function printSummary(bucket, files) {
  const albums = new Map();
  for (const file of files) {
    const slug = slugOf(file.relativePath);
    const entry = albums.get(slug) || { files: 0, bytes: 0, videos: 0 };
    entry.files += 1;
    entry.bytes += file.size || 0;
    if (isVideo(file)) entry.videos += 1;
    albums.set(slug, entry);
  }
  const rows = [...albums.entries()].sort((a, b) => b[1].bytes - a[1].bytes);
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);

  console.log(`\nBucket ${bucket}: ${files.length} archivos, ${formatBytes(total)}`);
  for (const [slug, info] of rows) {
    console.log(
      `  ${formatBytes(info.bytes).padStart(10)}  ${String(info.files).padStart(5)} arch.` +
        `  ${String(info.videos).padStart(3)} videos  ${slug}`,
    );
  }
  return total;
}

async function removeAll(bucket, files, deps) {
  const config = deps.getStorageConfig();
  const client = deps.createClient(config.url, config.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const paths = files.map((f) => f.relativePath);
  let deleted = 0;
  for (let i = 0; i < paths.length; i += BATCH_SIZE) {
    const batch = paths.slice(i, i + BATCH_SIZE);
    const { data, error } = await client.storage.from(bucket).remove(batch);
    if (error) {
      error.statusCode = error.statusCode || error.status;
      error.pendientes = paths.length - deleted;
      throw error;
    }
    deleted += Array.isArray(data) ? data.length : batch.length;
    console.log(`  ${bucket}: ${deleted}/${paths.length} borrados`);
  }
  return deleted;
}

async function main() {
  const args = parseArgs(process.argv);
  if (args.help) {
    console.log(require("node:fs").readFileSync(__filename, "utf8").split("*/")[0]);
    return;
  }
  if (args.pais && !["CL", "PE"].includes(args.pais)) {
    throw new Error("--pais tiene que ser CL o PE");
  }

  dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
  dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });

  const {
    countryStorageBuckets,
    defaultStorageBucketForCountry,
  } = require("../src/config/supabaseProjects");

  // getStorageConfig valida que COUNTRY y el bucket calcen; el script usa la
  // misma credencial para los dos buckets (mismo proyecto Supabase).
  process.env.COUNTRY = args.pais || process.env.COUNTRY || "CL";
  process.env.SUPABASE_STORAGE_BUCKET = defaultStorageBucketForCountry(process.env.COUNTRY);

  const deps = {
    getStorageConfig: require("../src/config/storage").getStorageConfig,
    createSupabaseStorageService:
      require("../src/services/supabaseStorageService").createSupabaseStorageService,
    createClient: require("@supabase/supabase-js").createClient,
  };

  const buckets = args.pais
    ? [defaultStorageBucketForCountry(args.pais)]
    : countryStorageBuckets();

  const plan = [];
  let grandTotal = 0;
  for (const bucket of buckets) {
    const files = await collect(bucket, deps, args);
    grandTotal += printSummary(bucket, files);
    plan.push({ bucket, files });
  }

  const count = plan.reduce((sum, p) => sum + p.files.length, 0);
  const what = args.soloVideos ? "videos" : "archivos";
  console.log(`\nTotal: ${count} ${what}, ${formatBytes(grandTotal)}.`);

  if (!count) {
    console.log("No hay nada que borrar.");
    return;
  }
  if (!args.confirmar) {
    console.log("Simulación: no se borró nada. Agrega --confirmar para borrar.");
    return;
  }

  console.log("\nBorrando…");
  let deleted = 0;
  for (const { bucket, files } of plan) {
    if (files.length) deleted += await removeAll(bucket, files, deps);
  }
  console.log(`\nListo. ${deleted} ${what} borrados, ~${formatBytes(grandTotal)} liberados.`);
  console.log(
    "Las portadas de los eventos vaciados quedan sin imagen; se puede elegir otra al subir fotos nuevas.",
  );
}

main().catch((err) => {
  if (isQuotaError(err)) explainQuotaError(err);
  else console.error(err.message || err);
  process.exit(1);
});
