#!/usr/bin/env node
/**
 * Renombra adjuntos y portadas de noticias al esquema <N°>_1, _2…
 * (la portada queda como <N°>_portada).
 *
 *   node scripts/rename-news-attachments.js --country=CL
 *   node scripts/rename-news-attachments.js --country=PE
 *
 * También descarga archivos que aún viven en URLs remotas (Cloudinary) y los
 * copia al bucket de la instancia con el mismo esquema de nombres.
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

async function main() {
  const args = parseArgs(process.argv);
  const country = String(args.country || "").trim().toUpperCase();
  if (!country || !isValidCountryCode(country)) {
    console.error("Uso: node scripts/rename-news-attachments.js --country=CL|PE");
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
  const repository = require("../src/services/noticias/noticiaRepository");
  const attachmentProcessor = require("../src/services/noticias/attachmentProcessor");
  const attachmentModel = require("../src/services/noticias/attachmentModel");

  const binding = getCountryDbBinding(country);
  const config = getCountryConfig(country);
  console.log(
    `[Noticias] Renombrando adjuntos de ${config.name} (schema=${binding.schema}, bucket=${process.env.SUPABASE_STORAGE_BUCKET})`,
  );

  const noticias = await repository.listAll();
  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const noticia of noticias) {
    try {
      const media = await attachmentProcessor.canonicalizeNewsRecord({
        id: noticia.id,
        image: noticia.image,
        attachments: noticia.attachments,
      });

      const sameImage = (media.image || null) === (noticia.image || null);
      const previousIds = JSON.stringify(
        attachmentModel.normalize(noticia.attachments).map((item) => item.public_id),
      );
      const nextIds = JSON.stringify(media.items.map((item) => item.public_id));
      if (sameImage && previousIds === nextIds) {
        skipped += 1;
        continue;
      }

      await repository.update(noticia.id, {
        title: noticia.title,
        subtitle: noticia.subtitle,
        slug: noticia.slug,
        content: noticia.content,
        image: media.image,
        attachments: media.attachments,
      });
      updated += 1;
      console.log(`  #${noticia.id} «${noticia.title}» → actualizada`);
    } catch (err) {
      failed += 1;
      console.error(`  #${noticia.id} «${noticia.title}»: ${err.message || err}`);
    }
  }

  console.log(
    `[Noticias] Listo. ${updated} actualizadas, ${skipped} ya canónicas, ${failed} con error, ${noticias.length} en total.`,
  );
  await db.pool.end().catch(() => {});
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
