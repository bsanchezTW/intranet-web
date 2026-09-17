const multer = require("multer");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const { MAX_ATTACHMENTS } = require("../services/noticias/attachmentNames");

/**
 * Recibe en disco los archivos de una noticia (portada + adjuntos).
 *
 * No se suben aquí: attachmentProcessor los sube recién cuando la noticia
 * existe, con el nombre <N° de noticia>_1, _2… (la portada es `_portada`).
 */

const MAX_MB = Math.round(UPLOAD_LIMITS_BYTES.NEWS_ATTACHMENT / (1024 * 1024));
const NEWS_UPLOAD_TEMP_DIR = path.join(os.tmpdir(), "transworld-intranet-news");

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(NEWS_UPLOAD_TEMP_DIR, { recursive: true })
        .then(() => cb(null, NEWS_UPLOAD_TEMP_DIR), cb);
    },
    filename: (_req, _file, cb) => {
      cb(null, `${Date.now()}-${crypto.randomUUID()}.upload`);
    },
  }),
  limits: { fileSize: UPLOAD_LIMITS_BYTES.NEWS_ATTACHMENT },
});

function collectedFiles(req) {
  const files = [];
  if (req.file) files.push(req.file);
  if (Array.isArray(req.files)) {
    files.push(...req.files);
  } else if (req.files && typeof req.files === "object") {
    for (const group of Object.values(req.files)) {
      files.push(...(Array.isArray(group) ? group : [group]));
    }
  }
  return files.filter((file) => file?.path);
}

async function cleanupNewsTemps(req) {
  await Promise.all(
    collectedFiles(req).map((file) =>
      fs.unlink(file.path).catch((err) => {
        console.warn(
          "[Noticias] No se pudo limpiar el temporal de subida:",
          err.message || err,
        );
      }),
    ),
  );
}

function receiveNewsMedia({ json = false } = {}) {
  return (req, res, next) => {
    upload.fields([
      { name: "adjuntos", maxCount: MAX_ATTACHMENTS },
      { name: "portada", maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        let error = "No se pudieron recibir los archivos.";
        if (err.code === "LIMIT_FILE_SIZE") {
          error = `Cada archivo puede pesar hasta ${MAX_MB} MB.`;
        }
        if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") {
          error = `Puedes adjuntar hasta ${MAX_ATTACHMENTS} archivos.`;
        }
        return json ? res.status(400).json({ error }) : res.status(400).send(error);
      }

      let cleaned = false;
      const cleanup = () => {
        if (cleaned) return;
        cleaned = true;
        cleanupNewsTemps(req);
      };
      // Solo al terminar la respuesta: `close` puede dispararse mientras
      // todavía se leen los temporales (videos grandes).
      res.on("finish", cleanup);
      return next();
    });
  };
}

module.exports = receiveNewsMedia;
