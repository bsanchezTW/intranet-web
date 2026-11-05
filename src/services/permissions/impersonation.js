const db = require("../../db");
const logger = require("../../utils/logger");
const { canLogin, normalizeRole } = require("../../constants/roles");
const { buildSessionUser } = require("../session/sessionUser");
const { wantsJson } = require("../../utils/httpResponses");

/**
 * «Iniciar sesión como» (al estilo de Salesforce): el superadmin entra a la
 * intranet con la identidad de otra persona para ver qué le aparece y qué no,
 * y puede actuar como ella.
 *
 * Mientras dura, `req.session.user` ES la persona suplantada: el menú, las
 * páginas, los permisos y lo que se guarda salen a su nombre, sin que cada
 * módulo tenga que enterarse. Quién está detrás queda en
 * `req.session.suplantacion.original` y en perm_audit:
 *
 *   suplantacion.iniciar   al entrar
 *   suplantacion.accion    cada POST/PUT/PATCH/DELETE (método y ruta, sin datos)
 *   suplantacion.terminar  al volver a la cuenta propia
 *
 * Reglas:
 *   - Sólo un superadmin, y no puede suplantar a otro superadmin ni a una
 *     cuenta deshabilitada, ni a sí mismo, ni encadenar suplantaciones.
 *   - Si al superadmin le quitan la marca (o lo deshabilitan) a mitad de
 *     camino, la sesión se cierra entera.
 *   - Nunca se cambia la contraseña de la persona suplantada.
 *   - Si no se puede registrar una acción en la auditoría, la acción no se hace.
 *   - «Cerrar sesión» vuelve a la cuenta propia en lugar de salir.
 */

const SESSION_KEY = "suplantacion";
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const END_PATH = "/suplantacion/terminar";

/** Rutas que nunca se usan como otra persona (credenciales). */
const BLOCKED_PATHS = [/^\/change-password\/?$/i, /^\/reset-password\/?$/i, /^\/forgot-password\/?$/i];

class ImpersonationError extends Error {}

function activeImpersonation(session) {
  const s = session && session[SESSION_KEY];
  return s && s.original && s.original.id ? s : null;
}

function displayName(user) {
  if (!user) return "";
  return user.nombre || [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email || `#${user.id}`;
}

async function audit({ actorId, action, targetId, note = null, newValue = null }) {
  await db.query(
    `INSERT INTO perm_audit (actor_user_id, action, entity_type, entity_id, new_value, note)
     VALUES ($1, $2, 'usuario', $3, $4::jsonb, $5)`,
    [actorId, action, targetId, newValue == null ? null : JSON.stringify(newValue), note],
  );
}

async function loadTarget(targetId) {
  const { rows } = await db.query(
    `SELECT u.id, u.first_name, u.last_name, u.email, u.role, u.photo, u.must_change_password,
            u.home_tutorial_seen, u.last_login_at, u.work_area_id, u.is_superadmin,
            at.area_name, at.color AS area_color
       FROM users u
       LEFT JOIN work_areas at ON at.id = u.work_area_id
      WHERE u.id = $1`,
    [targetId],
  );
  return rows[0] || null;
}

/**
 * Valida y decide sin tocar la base: devuelve el mensaje de por qué no se
 * puede, o null si se puede. Pura (se prueba sin base).
 */
function impersonationRefusal({ actor, actorIsSuperadmin, alreadyImpersonating, target }) {
  if (!actor || !actorIsSuperadmin) return "Sólo un superadmin puede iniciar sesión como otra persona.";
  if (alreadyImpersonating) return "Ya estás navegando como otra persona: vuelve a tu cuenta primero.";
  if (!target) return "La persona ya no existe.";
  if (Number(target.id) === Number(actor.id)) return "Ya estás en tu propia cuenta.";
  if (target.is_superadmin) return "No se puede iniciar sesión como otro superadmin.";
  if (!canLogin(normalizeRole(target.role))) return "La cuenta está deshabilitada: no puede iniciar sesión.";
  return null;
}

/** Empieza la suplantación. Lanza ImpersonationError con el motivo si no se puede. */
async function startImpersonation(req, targetId) {
  const id = Number.parseInt(targetId, 10);
  const target = Number.isInteger(id) && id > 0 ? await loadTarget(id) : null;
  const actor = req.session.user;
  const refusal = impersonationRefusal({
    actor,
    actorIsSuperadmin: Boolean(req.perms && req.perms.superadmin),
    alreadyImpersonating: Boolean(activeImpersonation(req.session)),
    target,
  });
  if (refusal) throw new ImpersonationError(refusal);

  const targetUser = buildSessionUser(target);
  // El tutorial y el cambio obligatorio de contraseña son de la persona: que
  // el superadmin no los dispare ni los marque como vistos por ella.
  targetUser.show_home_tutorial = false;
  targetUser.must_change_password = false;

  await audit({
    actorId: actor.id,
    action: "suplantacion.iniciar",
    targetId: target.id,
    note: `Entró como ${displayName(targetUser)}`,
  });

  req.session[SESSION_KEY] = { original: actor, startedAt: new Date().toISOString() };
  req.session.user = targetUser;
  delete req.session.ticketNotifications;
  return targetUser;
}

/** Vuelve a la cuenta propia. Devuelve el id de la persona que se suplantaba. */
async function endImpersonation(req, { reason = null } = {}) {
  const s = activeImpersonation(req.session);
  if (!s) return null;
  const target = req.session.user;
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(s.startedAt)) / 60000));
  req.session.user = s.original;
  delete req.session[SESSION_KEY];
  delete req.session.ticketNotifications;
  try {
    await audit({
      actorId: s.original.id,
      action: "suplantacion.terminar",
      targetId: target ? target.id : null,
      note: `Volvió a su cuenta tras ${minutes} min como ${displayName(target)}${reason ? ` (${reason})` : ""}`,
    });
  } catch (err) {
    logger.error("suplantacion", err);
  }
  return target ? target.id : null;
}

function isBlockedPath(path) {
  return BLOCKED_PATHS.some((re) => re.test(path));
}

function destroySession(req, res, cookieName) {
  return req.session.destroy(() => {
    res.clearCookie(cookieName);
    if (wantsJson(req)) return res.status(401).json({ error: "Tu sesión terminó." });
    return res.redirect("/login");
  });
}

/**
 * Middleware, justo después de la sesión. Con una suplantación activa:
 * confirma que quien está detrás sigue siendo superadmin, corta las rutas de
 * credenciales, convierte «Cerrar sesión» en «volver a mi cuenta», registra
 * cada escritura y deja `res.locals.suplantacion` para el aviso de la barra.
 */
function impersonationGuard({ cookieName }) {
  return async (req, res, next) => {
    res.locals.suplantacion = null;
    const s = activeImpersonation(req.session);
    if (!s) return next();

    let original;
    try {
      const { rows } = await db.query("SELECT is_superadmin, role FROM users WHERE id = $1", [s.original.id]);
      original = rows[0];
    } catch (err) {
      logger.error("suplantacion", err);
      return next(err);
    }
    if (!original || !original.is_superadmin || !canLogin(normalizeRole(original.role))) {
      return destroySession(req, res, cookieName);
    }

    const path = req.path;
    if (path === END_PATH) return next();

    if (req.method === "GET" && /^\/logout\/?$/i.test(path)) {
      try {
        const targetId = await endImpersonation(req, { reason: "cerró sesión" });
        return res.redirect(targetId ? `/permisos/usuarios/${targetId}` : "/permisos/usuarios");
      } catch (err) {
        return next(err);
      }
    }

    const targetName = displayName(req.session.user);
    if (isBlockedPath(path)) {
      const msg = `Estás navegando como ${targetName}: su contraseña no se puede cambiar desde aquí.`;
      if (wantsJson(req)) return res.status(403).json({ error: msg });
      return res.status(403).type("text/plain").send(msg);
    }

    if (!SAFE_METHODS.has(req.method)) {
      try {
        await audit({
          actorId: s.original.id,
          action: "suplantacion.accion",
          targetId: req.session.user.id,
          note: `Como ${targetName}: ${req.method} ${path}`,
          newValue: { metodo: req.method, ruta: path },
        });
      } catch (err) {
        logger.error("suplantacion", err);
        const msg = "No se pudo registrar la acción en la auditoría, así que no se hizo. Inténtalo de nuevo.";
        if (wantsJson(req)) return res.status(503).json({ error: msg });
        return res.status(503).type("text/plain").send(msg);
      }
    }

    res.locals.suplantacion = {
      original: { id: s.original.id, nombre: displayName(s.original) },
      persona: { id: req.session.user.id, nombre: targetName },
      desde: s.startedAt,
    };
    return next();
  };
}

module.exports = {
  ImpersonationError,
  activeImpersonation,
  impersonationRefusal,
  startImpersonation,
  endImpersonation,
  impersonationGuard,
  isBlockedPath,
  END_PATH,
};
