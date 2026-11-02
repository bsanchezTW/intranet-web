const compression = require("compression");

/**
 * Qué respuestas se comprimen.
 *
 * Todo lo que compression comprime por defecto, menos el streaming SSE del
 * asistente: gzip guarda la salida hasta juntar un bloque, así que la
 * respuesta llegaba entera al final en vez de palabra por palabra (los
 * eventos de texto son chicos y nunca llenaban el bloque).
 */
function shouldCompress(req, res) {
  const type = String(res.getHeader("Content-Type") || "");
  if (/^text\/event-stream/i.test(type)) return false;
  return compression.filter(req, res);
}

function httpCompression() {
  return compression({ filter: shouldCompress });
}

module.exports = { httpCompression, shouldCompress };
