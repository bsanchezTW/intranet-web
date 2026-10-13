#!/usr/bin/env node
/**
 * Genera la miniatura de las fotos de evento que ya están en Storage.
 *
 *   node scripts/backfill-event-thumbnails.js --country=CL
 *   node scripts/backfill-event-thumbnails.js --country=CL --dry-run
 *
 * Recorre los buckets de Chile y Perú. Si la miniatura ya existe, no la repite.
 */

const path = require("node:path");
const dotenv = require("dotenv");
const { isValidCountryCode } = require("../src/config/country");
const {
  countryStorageBuckets,
  defaultStorageBucketForCountry,
} = require("../src/config/supabaseProjects");

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

async function backfillBucket(bucket, { dryRun, renderThumbnail, thumbnailRelativePath, isEventImagePath, isEventThumbnailPath, createSupabaseStorageService, getStorageConfig }) {
  const storage = createSupabaseStorageService({
    config: { ...getStorageConfig(), bucket },
  });
  const files = await storage.listFilesRecursive("eventos");
  const existingThumbs = new Set(
    files
      .filter((file) => isEventThumbnailPath(file.relativePath))
      .map((file) => file.relativePath),
  );
  const images = files.filter((file) => isEventImagePath(file.relativePath));
  let created = 0;
  let skipped = 0;
  let failed = 0;
  let bytes = 0;

  for (const file of images) {
    const thumbPath = thumbnailRelativePath(file.relativePath);
    const label = `${bucket} ${file.relativePath}`;
    try {
      if (existingThumbs.has(thumbPath)) {
        skipped += 1;
        continue;
      }
      if (dryRun) {
        created += 1;
        console.log(`  crearía ${label}`);
        continue;
      }
      const downloaded = await storage.downloadFile(file.relativePath);
      const jpeg = await renderThumbnail(downloaded.buffer);
      await storage.uploadFile(jpeg, thumbPath, {
        contentType: "image/jpeg",
        upsert: true,
        cacheControl: "86400",
      });
      created += 1;
      bytes += jpeg.length;
      console.log(`  ${label} → ${Math.round(jpeg.length / 1024)} KB`);
    } catch (err) {
      failed += 1;
      console.error(`  ${label}: ${err.message || err}`);
    }
  }

  return { bucket, images: images.length, created, skipped, failed, bytes };
}

async function main() {
  const args = parseArgs(process.argv);
  const country = String(args.country || "").trim().toUpperCase();
  if (!country || !isValidCountryCode(country)) {
    console.error("Falta --country=CL o --country=PE");
    process.exit(1);
  }

  loadSharedEnv();
  process.env.COUNTRY = country;
  process.env.SUPABASE_STORAGE_BUCKET = defaultStorageBucketForCountry(country);

  const { getStorageConfig } = require("../src/config/storage");
  const { createSupabaseStorageService } = require("../src/services/supabaseStorageService");
  const {
    isEventImagePath,
    isEventThumbnailPath,
    thumbnailRelativePath,
    renderThumbnail,
  } = require("../src/services/media/eventThumbnails");

  const totals = [];
  for (const bucket of countryStorageBuckets()) {
    console.log(`Bucket ${bucket}`);
    totals.push(
      await backfillBucket(bucket, {
        dryRun: args.dryRun,
        renderThumbnail,
        thumbnailRelativePath,
        isEventImagePath,
        isEventThumbnailPath,
        createSupabaseStorageService,
        getStorageConfig,
      }),
    );
  }

  const created = totals.reduce((sum, item) => sum + item.created, 0);
  const skipped = totals.reduce((sum, item) => sum + item.skipped, 0);
  const failed = totals.reduce((sum, item) => sum + item.failed, 0);
  const bytes = totals.reduce((sum, item) => sum + item.bytes, 0);
  const verb = args.dryRun ? "por crear" : "creadas";
  console.log(
    `Listo. ${created} miniaturas ${verb}, ${skipped} ya existían, ${failed} fallaron` +
      (args.dryRun ? "." : `, ${Math.round(bytes / 1024)} KB subidos.`),
  );
  if (failed) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
