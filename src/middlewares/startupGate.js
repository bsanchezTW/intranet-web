const { wantsJson } = require("../utils/httpResponses");

/**
 * Compuerta del arranque: hasta que terminan las tareas de base de datos
 * (migraciones y las ensure*Schema), las páginas responden 503 «La intranet
 * se está actualizando» con Retry-After.
 *
 * Passenger necesita que el proceso escuche de inmediato, así que el listen
 * no espera a la base; sin esto, una petición de esos primeros segundos
 * llegaba a un esquema viejo (al desplegar la migración de users.active, el
 * login respondía "column u.active does not exist").
 *
 * Va después de los estáticos: CSS, imágenes y scripts se sirven igual. Si
 * el arranque no termina en `timeoutMs` (base caída, pooler lento), se abre
 * igual y queda en el log: mejor errores puntuales que la intranet entera
 * en 503.
 */

const RETRY_SECONDS = 5;

const PAGE = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="${RETRY_SECONDS}">
<title>Actualizando la intranet</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f4f6fa; color: #1b2433; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 32rem; padding: 2rem; text-align: center; }
  h1 { margin: 0 0 .5rem; color: #26388f; font-size: 1.35rem; }
  p { margin: 0; color: #667085; }
</style>
</head>
<body>
<main>
  <h1>La intranet se está actualizando</h1>
  <p>Tarda unos segundos. Esta página se recarga sola.</p>
</main>
</body>
</html>`;

function createStartupGate({ timeoutMs = 60000, logger = null } = {}) {
  let ready = false;
  let timer = null;

  function open(reason = "listo") {
    if (ready) return;
    ready = true;
    if (timer) clearTimeout(timer);
    if (logger && reason !== "listo") logger.warn("arranque", `se atiende sin terminar el arranque: ${reason}`);
  }

  /** Empieza a contar el tope; se llama al escuchar. */
  function arm() {
    if (ready || timer || !timeoutMs) return;
    timer = setTimeout(() => open(`pasaron ${Math.round(timeoutMs / 1000)} s`), timeoutMs);
    if (typeof timer.unref === "function") timer.unref();
  }

  function middleware(req, res, next) {
    if (ready) return next();
    res.status(503);
    res.set("Retry-After", String(RETRY_SECONDS));
    res.set("Cache-Control", "no-store");
    if (wantsJson(req)) return res.json({ error: "La intranet se está actualizando. Intenta en unos segundos." });
    return res.type("html").send(PAGE);
  }

  return { middleware, open, arm, isReady: () => ready };
}

module.exports = { createStartupGate, RETRY_SECONDS };
