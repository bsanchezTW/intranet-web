const multer = require("multer");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const { MAX_ATTACHMENTS } = require("../services/tickets/ticketRules");

/**
 * Recibe en memoria los adjuntos de un ticket nuevo (campo "adjuntos").
 *
 * No se suben aquí: services/tickets/ticketService los sube recién cuando el
 * ticket existe, con el nombre <N° de ticket>_1, _2…
 */

const MAX_MB = Math.round(UPLOAD_LIMITS_BYTES.TICKET_ATTACHMENT / (1024 * 1024));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMITS_BYTES.TICKET_ATTACHMENT },
});

function receiveTicketAttachments({ maxFiles = MAX_ATTACHMENTS, json = false } = {}) {
  return (req, res, next) => {
    upload.array("adjuntos", maxFiles)(req, res, (err) => {
      if (!err) return next();

      let error = "No se pudieron recibir los archivos.";
      if (err.code === "LIMIT_FILE_SIZE") error = `Cada archivo puede pesar hasta ${MAX_MB} MB.`;
      if (err.code === "LIMIT_UNEXPECTED_FILE" || err.code === "LIMIT_FILE_COUNT") {
        error = `Puedes adjuntar hasta ${maxFiles} archivos.`;
      }
      return json ? res.status(400).json({ error }) : res.status(400).send(error);
    });
  };
}

module.exports = receiveTicketAttachments;
