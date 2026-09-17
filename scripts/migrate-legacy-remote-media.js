#!/usr/bin/env node
/**
 * Copia imágenes que aún viven en URLs HTTP externas (legado) al bucket de
 * la instancia y reescribe events.image y subsection_details.image_url.
 *
 * Las noticias se migran con scripts/rename-news-attachments.js (ahí el
 * nombre en el bucket es <N°>_1, <N°>_portada).
 *
 *   node scripts/migrate-legacy-remote-media.js --country=CL
 *   node scripts/migrate-legacy-remote-media.js --country=CL --dry-run
 */

const path = require("node:path");
const fs = require("node:fs");
const dotenv = require("dotenv");
const { getCountryConfig, isValidCountryCode } = require("../src/config/country");
const {
  defaultStorageBucketForCountry,
  getCountryDbBinding,
  applyCountryPoolerUser,
} = require("../src/config/supabaseProjects");
const { UPLOAD_LIMITS_BYTES } = require("../src/config/uploadLimits");
const { isRemoteMediaUrl } = require("../src/services/noticias/attachmentNames");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = { dryRun: false };
  for (const arg of argv.slice(2)) {
    if (arg === "--dry-run") {
      args.dryRun = true;
      continue;
    }
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

function objectPathFromRemoteUrl(url, fallbackFolder) {
  try {
    const pathname = decodeURIComponent(new URL(url).pathname);
    const match = pathname.match(/\/upload\/v\d+\/(.+)$/i);
    if (match?.[1]) return match[1];
    const base = path.posix.basename(pathname);
    if (base && base !== "/") return `${fallbackFolder}/${base}`;
  } catch {
    // URL ilegible: caemos al fallback.
  }
  return `${fallbackFolder}/archivo`;
}

async function downloadRemote(url, maxBytes) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "intranet-web-storage-migration" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al descargar ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("El archivo remoto está vacío.");
  if (buffer.length > maxBytes) {
    throw new Error(`El archivo supera el límite (${buffer.length} bytes).`);
  }
  return {
    buffer,
    contentType: String(response.headers.get("content-type") || "")
      .split(";", 1)[0]
      .trim(),
  };
}

async function importRemote(fileStorage, url, fallbackFolder, maxBytes, dryRun) {
  const relativePath = objectPathFromRemoteUrl(url, fallbackFolder);
  const folder = path.posix.dirname(relativePath);
  const fileName = path.posix.basename(relativePath);
  const nextUrl = fileStorage.getPublicUrl(relativePath);
  if (dryRun) {
    return { status: "planned", relativePath, nextUrl };
  }

  const downloaded = await downloadRemote(url, maxBytes);
  const contentType =
    downloaded.contentType && downloaded.contentType !== "application/octet-stream"
      ? downloaded.contentType
      : undefined;
  const saved = await fileStorage.saveFileAs(downloaded.buffer, folder, fileName, {
    contentType,
    upsert: true,
  });
  await fileStorage.statStoredObject(saved.public_id);
  return { status: "migrated", relativePath: saved.public_id, nextUrl: saved.url };
}

async function migrateEvents(db, fileStorage, dryRun) {
  const { rows } = await db.query("SELECT id, slug, name, image FROM events ORDER BY id");
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (!isRemoteMediaUrl(row.image)) {
      skipped += 1;
      continue;
    }
    const label = `events#${row.id} «${row.name}»`;
    try {
      const result = await importRemote(
        fileStorage,
        row.image,
        `eventos/${row.slug || row.id}`,
        UPLOAD_LIMITS_BYTES.EVENT_IMAGE,
        dryRun,
      );
      if (!dryRun) {
        const written = await db.query(
          "UPDATE events SET image = $1 WHERE id = $2 AND image = $3",
          [result.nextUrl, row.id, row.image],
        );
        if (!written.rowCount) {
          throw new Error("La fila cambió durante la migración; no se reescribió.");
        }
      }
      updated += 1;
      console.log(`  ${label} → ${result.relativePath}`);
    } catch (err) {
      failed += 1;
      console.error(`  ${label}: ${err.message || err}`);
    }
  }

  return { updated, skipped, failed, total: rows.length };
}

async function migrateSubsections(db, fileStorage, dryRun) {
  const { rows } = await db.query(
    "SELECT name, image_url FROM subsection_details ORDER BY name",
  );
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (!isRemoteMediaUrl(row.image_url)) {
      skipped += 1;
      continue;
    }
    const label = `subsection_details «${row.name}»`;
    try {
      const result = await importRemote(
        fileStorage,
        row.image_url,
        "subsecciones_cursos",
        UPLOAD_LIMITS_BYTES.COURSE_MATERIAL,
        dryRun,
      );
      if (!dryRun) {
        const written = await db.query(
          "UPDATE subsection_details SET image_url = $1 WHERE name = $2 AND image_url = $3",
          [result.nextUrl, row.name, row.image_url],
        );
        if (!written.rowCount) {
          throw new Error("La fila cambió durante la migración; no se reescribió.");
        }
      }
      updated += 1;
      console.log(`  ${label} → ${result.relativePath}`);
    } catch (err) {
      failed += 1;
      console.error(`  ${label}: ${err.message || err}`);
    }
  }

  return { updated, skipped, failed, total: rows.length };
}

async function main() {
  const args = parseArgs(process.argv);
  const country = String(args.country || "").trim().toUpperCase();
  if (!country || !isValidCountryCode(country)) {
    console.error(
      "Uso: node scripts/migrate-legacy-remote-media.js --country=CL|PE [--dry-run]",
    );
    process.exit(1);
  }

  loadSharedEnv();
  process.env.COUNTRY = country;
  process.env.SUPABASE_STORAGE_BUCKET = defaultStorageBucketForCountry(country);
  applyCountryPoolerUser(process.env);

  if (!fs.existsSync(path.join(ROOT, ".env")) && !fs.existsSync(path.join(ROOT, ".env.local"))) {
    console.error("No hay .env en la raíz del repo.");
    process.exit(1);
  }

  require("../src/config/env");
  const db = require("../src/db");
  const fileStorage = require("../src/services/fileStorage");

  const binding = getCountryDbBinding(country);
  const config = getCountryConfig(country);
  console.log(
    `[Media] Importando URLs remotas de ${config.name}` +
      ` (schema=${binding.schema}, bucket=${process.env.SUPABASE_STORAGE_BUCKET})` +
      (args.dryRun ? " [dry-run]" : ""),
  );

  const events = await migrateEvents(db, fileStorage, args.dryRun);
  const subsections = await migrateSubsections(db, fileStorage, args.dryRun);

  console.log(
    `[Media] Eventos: ${events.updated} actualizados, ${events.skipped} ya locales, ${events.failed} con error.`,
  );
  console.log(
    `[Media] Subsecciones: ${subsections.updated} actualizadas, ${subsections.skipped} ya locales, ${subsections.failed} con error.`,
  );

  await db.pool.end().catch(() => {});
  process.exit(events.failed || subsections.failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
