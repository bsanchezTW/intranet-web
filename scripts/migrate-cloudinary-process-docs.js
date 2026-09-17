#!/usr/bin/env node
/**
 * Copia documentos de procesos que aún viven en Cloudinary al bucket de la
 * instancia y reescribe url/public_id a /content/...
 *
 *   node scripts/migrate-cloudinary-process-docs.js --country=CL
 *   node scripts/migrate-cloudinary-process-docs.js --country=CL --dry-run
 *
 * No borra el original en Cloudinary: si algo falla, la fila sigue apuntando
 * al proveedor viejo.
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
const {
  isCloudinaryUrl,
  isStoredContentUrl,
  folderForRow,
  fileNameForLegacyObject,
  destinationPath,
} = require("../src/services/documents/processDocumentStorage");

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

async function downloadRemote(url) {
  const response = await fetch(url, {
    redirect: "follow",
    headers: { "User-Agent": "intranet-web-storage-migration" },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} al descargar ${url}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("El archivo remoto está vacío.");
  if (buffer.length > UPLOAD_LIMITS_BYTES.PROCESS_DOCUMENT) {
    throw new Error(`El archivo supera el límite de procesos (${buffer.length} bytes).`);
  }
  return {
    buffer,
    contentType: String(response.headers.get("content-type") || "").split(";", 1)[0].trim(),
  };
}

function labelFor(table, row) {
  return `${table}#${row.id} «${row.name}»`;
}

async function loadRows(db) {
  const documents = await db.query(
    `SELECT id, name, type, url, public_id, work_area_id, doc_kind
       FROM documents
      ORDER BY id`,
  );
  const others = await db.query(
    `SELECT id, name, url, public_id
       FROM other_documents
      ORDER BY id`,
  );
  return [
    ...documents.rows.map((row) => ({ table: "documents", row })),
    ...others.rows.map((row) => ({ table: "other_documents", row })),
  ];
}

async function migrateOne(db, fileStorage, { table, row }, dryRun) {
  if (isStoredContentUrl(row.url)) {
    return { status: "skipped", reason: "ya en Storage" };
  }
  if (!isCloudinaryUrl(row.url)) {
    return { status: "skipped", reason: "no es Cloudinary" };
  }

  const downloaded = await downloadRemote(row.url);
  const fileName = fileNameForLegacyObject({
    url: row.url,
    publicId: row.public_id,
    contentType: downloaded.contentType,
    buffer: downloaded.buffer,
  });
  const relativePath = destinationPath(table, row, fileName);
  const nextUrl = fileStorage.getPublicUrl(relativePath);

  if (dryRun) {
    return { status: "planned", relativePath, nextUrl };
  }

  const tableName = table === "other_documents" ? "other_documents" : "documents";
  const contentType =
    downloaded.contentType && downloaded.contentType !== "application/octet-stream"
      ? downloaded.contentType
      : undefined;
  const saved = await fileStorage.saveFileAs(
    downloaded.buffer,
    folderForRow(table, row),
    fileName,
    { contentType, upsert: true },
  );

  const updated = await db.query(
    `UPDATE ${tableName}
        SET url = $1, public_id = $2
      WHERE id = $3 AND url = $4`,
    [saved.url, saved.public_id, row.id, row.url],
  );
  if (!updated.rowCount) {
    throw new Error("La fila cambió durante la migración; no se reescribió.");
  }

  await fileStorage.statStoredObject(saved.public_id);
  return { status: "migrated", relativePath: saved.public_id, nextUrl: saved.url };
}

async function main() {
  const args = parseArgs(process.argv);
  const country = String(args.country || "").trim().toUpperCase();
  if (!country || !isValidCountryCode(country)) {
    console.error("Uso: node scripts/migrate-cloudinary-process-docs.js --country=CL|PE [--dry-run]");
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
    `[Procesos] Migrando Cloudinary → Storage de ${config.name}` +
      ` (schema=${binding.schema}, bucket=${process.env.SUPABASE_STORAGE_BUCKET}` +
      `${args.dryRun ? ", dry-run" : ""})`,
  );

  const entries = await loadRows(db);
  let migrated = 0;
  let skipped = 0;
  let failed = 0;

  for (const entry of entries) {
    const tag = labelFor(entry.table, entry.row);
    try {
      const result = await migrateOne(db, fileStorage, entry, args.dryRun);
      if (result.status === "skipped") {
        skipped += 1;
        console.log(`  ${tag}: omitido (${result.reason})`);
        continue;
      }
      migrated += 1;
      console.log(`  ${tag}: ${result.relativePath}`);
    } catch (err) {
      failed += 1;
      console.error(`  ${tag}: ${err.message || err}`);
    }
  }

  console.log(
    `[Procesos] Listo. ${migrated} migrados, ${skipped} omitidos, ${failed} con error, ${entries.length} en total.`,
  );
  await db.pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
