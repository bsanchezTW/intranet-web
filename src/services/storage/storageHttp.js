const path = require("node:path");
const { pipeline } = require("node:stream/promises");

/**
 * Tipos que se pueden servir inline desde el origen de la intranet.
 *
 * Es una lista blanca a propósito. La lista negra anterior (HTML, SVG, XML…)
 * dejaba pasar cualquier `application/*+xml` (MathML, RDF…), que el navegador
 * abre como documento XML y en el que ejecuta un <script> XHTML. Como el
 * Content-Type de un comprobante o un adjunto lo declara quien lo sube, lo
 * que no está aquí se entrega como descarga, en un sandbox y sin su tipo.
 *
 * Ninguno de estos tipos ejecuta código en el documento: imágenes rasterizadas,
 * audio, video, texto plano (con nosniff no se reinterpreta como HTML) y PDF
 * (el visor del navegador corre aislado del origen).
 */
const INLINE_SAFE_CONTENT_TYPES = new Set([
  "image/jpeg",
  "image/pjpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/bmp",
  "image/avif",
  "image/x-icon",
  "image/vnd.microsoft.icon",
  "video/mp4",
  "video/webm",
  "video/ogg",
  "video/quicktime",
  "video/x-m4v",
  "audio/mpeg",
  "audio/mp4",
  "audio/aac",
  "audio/ogg",
  "audio/wav",
  "audio/x-wav",
  "audio/webm",
  "application/pdf",
  "text/plain",
]);

function baseContentType(contentType) {
  return String(contentType || "")
    .split(";", 1)[0]
    .trim()
    .toLowerCase();
}

function isInlineSafeContentType(contentType) {
  return INLINE_SAFE_CONTENT_TYPES.has(baseContentType(contentType));
}

/**
 * ¿Hay que neutralizar este tipo (descarga + sandbox)? Todo lo que no está en
 * la lista blanca, incluido un tipo vacío o desconocido.
 */
function isActiveContentType(contentType) {
  return !isInlineSafeContentType(contentType);
}

function contentDispositionFor(file = {}) {
  const rawName = path.posix.basename(
    String(file.name || file.relativePath || "archivo"),
  );
  const fallback = rawName
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\\r\n]/g, "_")
    .slice(0, 180) || "archivo";
  const encoded = encodeURIComponent(rawName).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function responseAlreadyClosed(res) {
  return Boolean(res && (res.destroyed || res.closed || res.writableEnded));
}

function isClientDisconnectError(err, signal) {
  if (signal?.aborted || err?.name === "AbortError") return true;
  return (
    err?.code === "ERR_STREAM_PREMATURE_CLOSE" ||
    err?.code === "ERR_STREAM_UNABLE_TO_PIPE"
  );
}

// undici emite `error` en el body (TypeError: terminated / HTTP2) después de
// que pipeline ya retiró sus listeners. Sin un receptor, Node cierra el proceso.
function keepStreamErrorFromCrashing(stream) {
  if (!stream || typeof stream.on !== "function") return;
  stream.on("error", () => {});
}

function parseByteRange(header, size) {
  if (!header || !Number.isInteger(size) || size < 0) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  if (!match) return { unsatisfiable: true };

  const startRaw = match[1];
  const endRaw = match[2];
  if (startRaw === "" && endRaw === "") return { unsatisfiable: true };

  let start;
  let end;
  if (startRaw === "") {
    const suffix = Number(endRaw);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return { unsatisfiable: true };
    if (size === 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Number(endRaw);
  }

  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  ) {
    return { unsatisfiable: true };
  }
  if (end >= size) end = size - 1;
  return { start, end };
}

function discardStoredStream(stream) {
  keepStreamErrorFromCrashing(stream);
  if (stream && typeof stream.destroy === "function" && !stream.destroyed) {
    stream.destroy();
  }
}

async function pipeStoredStream(stream, res, signal) {
  keepStreamErrorFromCrashing(stream);
  if (signal?.aborted || responseAlreadyClosed(res)) {
    discardStoredStream(stream);
    return;
  }

  try {
    await pipeline(stream, res);
  } catch (err) {
    if (isClientDisconnectError(err, signal)) {
      discardStoredStream(stream);
      return;
    }
    throw err;
  }
}

module.exports = {
  INLINE_SAFE_CONTENT_TYPES,
  baseContentType,
  isInlineSafeContentType,
  isActiveContentType,
  contentDispositionFor,
  parseByteRange,
  discardStoredStream,
  pipeStoredStream,
};
