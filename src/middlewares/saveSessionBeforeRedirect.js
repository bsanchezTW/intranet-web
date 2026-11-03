const logger = require("../utils/logger");

/**
 * express-session manda las cabeceras antes de terminar de guardar y retiene
 * sólo el último byte del cuerpo. El navegador sigue un 302 apenas ve las
 * cabeceras, así que con la sesión en Postgres la petición siguiente puede
 * llegar antes que la fila: quien acaba de iniciar sesión vuelve a /login, y lo
 * mismo pasa con el código de verificación tras registrarse. En memoria no se
 * notaba porque el guardado era instantáneo.
 *
 * Por eso una redirección que cambió la sesión espera a que quede guardada.
 * Sin cambios no escribe: una visita anónima que va a /login no debe crear
 * filas, y `saveUninitialized: false` ya no la cubriría con un save explícito.
 */

function sessionData(session) {
  const { cookie, ...data } = session;
  return JSON.stringify(data);
}

function saveSessionBeforeRedirect(req, res, next) {
  const initialId = req.sessionID;
  const initialData = req.session ? sessionData(req.session) : null;
  const redirect = res.redirect;

  res.redirect = function redirectAfterSaving(...args) {
    const send = () => redirect.apply(res, args);
    const { session } = req;
    // Sin sesión: se destruyó (cierre de sesión) y no hay nada que guardar.
    if (!session) return send();
    if (req.sessionID === initialId && sessionData(session) === initialData) return send();
    return session.save((err) => {
      // Igual se redirige: dejarla colgada sería peor que pedir entrar de nuevo.
      if (err) logger.error("sesiones", err);
      send();
    });
  };

  next();
}

module.exports = { saveSessionBeforeRedirect };
