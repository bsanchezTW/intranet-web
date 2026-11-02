/**
 * Inicio: la portada (/), los accesos rápidos, el tutorial de bienvenida, el
 * menú del casino y el atajo viejo de LinkedIn. Mantiene en memoria los datos
 * de la portada (indicadores, clima, LinkedIn, eventos, noticias).
 */
const express = require("express");
const db = require("../db");
const logger = require("../utils/logger");
const fileStorage = require("../services/fileStorage");
const { previewUrl } = require("../services/media/eventThumbnails");
const { getIndicadores } = require("../services/usdService");
const { getWeather } = require("../services/weatherService");
const linkedinService = require("../services/linkedinService");
const { getLocale } = require("../config/country");
const { isFeatureEnabled } = require("../config/features");
const { resolveHomeQuickAccess, sanitizeHomeQuickAccess } = require("../services/homeQuickAccess");
const requirePermission = require("../middlewares/requirePermission");
const requireFeature = require("../middlewares/requireFeature");
const { getMonogram } = require("../utils/monogram");
const attachmentModel = require("../services/noticias/attachmentModel");

const router = express.Router();

let cachedIndicadores = {
  dolar: { valor: null, tendencia: "igual" },
  euro: { valor: null, tendencia: "igual" },
  uf: { valor: null, tendencia: "igual" },
};
let cachedClima = { temp: "--", icon: "⏳", desc: "Cargando...", sunset: null, manana: null };
let cachedLinkedin = isFeatureEnabled("linkedinFeed")
  ? linkedinService.getPlaceholderPosts()
  : [];
let cachedEventosPool = [];
let cachedEventosCarouselAt = 0;
let eventosCarouselRefreshPromise = null;
const EVENTOS_CAROUSEL_CACHE_MS = 15 * 60 * 1000;
const EVENTOS_CAROUSEL_DISPLAY_LIMIT = 8;
const EVENTOS_CAROUSEL_LIST_LIMIT = 12;
const NOTICIAS_HOME_LIST_LIMIT = 6;

function shuffleArray(items) {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

async function updateDataBackground() {
  try {
    const nuevosIndicadores = await getIndicadores({
      includeUf: isFeatureEnabled("chileUfIndicator"),
    });
    if (nuevosIndicadores) {
      const calcularTendencia = (ind) => {
        if (!ind || !ind.valor || !ind.valorAyer) return "igual";
        if (ind.valor > ind.valorAyer) return "alcista";
        if (ind.valor < ind.valorAyer) return "bajista";
        return "igual";
      };
      cachedIndicadores = {
        dolar: {
          ...nuevosIndicadores.dolar,
          tendencia: calcularTendencia(nuevosIndicadores.dolar),
        },
        euro: {
          ...nuevosIndicadores.euro,
          tendencia: calcularTendencia(nuevosIndicadores.euro),
        },
        uf: {
          ...nuevosIndicadores.uf,
          tendencia: calcularTendencia(nuevosIndicadores.uf),
        },
      };
    }
  } catch (err) {
    logger.error("finanzas", err);
  }

  try {
    const climaData = await getWeather();
    if (climaData) cachedClima = climaData;
  } catch (err) {
    logger.warn("clima", err);
  }

  if (!isFeatureEnabled("linkedinFeed")) {
    cachedLinkedin = [];
    return;
  }

  try {
    // Después del primer login al pooler: si no, LinkedIn abre otra conexión
    // mientras el arranque todavía está haciendo el handshake.
    await db.warmPool();
    const posts = await linkedinService.getCompanyPosts();
    if (posts && posts.length > 0) {
      cachedLinkedin = posts;
    }
  } catch (err) {
    logger.warn("linkedin", err);
  }
}

/**
 * Indicadores, clima, LinkedIn y carrusel de eventos se refrescan en segundo
 * plano. Lo llama app.js después del listen: si corriera al cargar el
 * módulo, Chile pegaría a mindicador + LinkedIn + Storage antes de que
 * Passenger marque la app lista (y un test que carga las rutas saldría a la
 * red).
 */
let homeJobsStarted = false;
function startHomeBackgroundJobs() {
  if (homeJobsStarted) return;
  homeJobsStarted = true;
  updateDataBackground();
  setInterval(updateDataBackground, 15 * 60 * 1000);
  loadEventosCarouselPool().catch((err) => {
    logger.warn("home", err);
  });
}

function mapNoticiaHomeRow(n) {
  // El mismo resumen de contenido que muestra el módulo de noticias, para que
  // el inicio hable el mismo lenguaje ("3 imágenes · 1 PDF").
  const adjuntos = attachmentModel.normalize(n.attachments);

  return {
    id: n.id,
    type: "noticia",
    title: n.title ?? n.titulo,
    subtitle: n.subtitle ?? n.subtitulo,
    image: n.image ?? n.imagen,
    link: `/noticias/${n.id}`,
    fecha: (n.created_at ?? n.fecha_creacion)
      ? new Date(n.created_at ?? n.fecha_creacion)
      : new Date(),
    featured: Boolean(n.featured ?? n.destacada),
    resumen: attachmentModel.summarize(adjuntos),
  };
}

async function fetchNoticiasHome() {
  let noticiaDestacada = null;

  try {
    const { rows } = await db.query(
      `SELECT id, title, image, subtitle, created_at, featured, attachments
       FROM news_articles
       WHERE featured = true
       ORDER BY created_at DESC
       LIMIT 1`,
    );
    if (rows[0]) {
      noticiaDestacada = mapNoticiaHomeRow(rows[0]);
    }
  } catch (err) {
    logger.warn("home", err);
  }

  let noticiasLista = [];
  try {
    const sql = noticiaDestacada
      ? `SELECT id, title, image, subtitle, created_at, attachments
         FROM news_articles
         WHERE id != $1
         ORDER BY created_at DESC
         LIMIT ${NOTICIAS_HOME_LIST_LIMIT}`
      : `SELECT id, title, image, subtitle, created_at, attachments
         FROM news_articles
         ORDER BY created_at DESC
         LIMIT ${NOTICIAS_HOME_LIST_LIMIT}`;
    const params = noticiaDestacada ? [noticiaDestacada.id] : [];
    const { rows } = await db.query(sql, params);
    noticiasLista = rows.map((n) => mapNoticiaHomeRow(n));
  } catch (err) {
    logger.error("home", err);
  }

  const mixedFeed = noticiaDestacada
    ? [noticiaDestacada, ...noticiasLista]
    : noticiasLista;

  return { noticiaDestacada, noticiasLista, mixedFeed };
}

function getEventosCarouselFromCache() {
  return shuffleArray(cachedEventosPool).slice(0, EVENTOS_CAROUSEL_DISPLAY_LIMIT);
}

async function loadEventosCarouselPool() {
  if (eventosCarouselRefreshPromise) {
    return eventosCarouselRefreshPromise;
  }

  eventosCarouselRefreshPromise = (async () => {
    try {
      const { rows: eventos } = await db.query(
        `SELECT name, slug
         FROM events
         ORDER BY created_at DESC
         LIMIT 10`,
      );

      const galerias = await Promise.all(
        eventos.map(async (evento) => {
          try {
            const archivos = await fileStorage.listFiles(`eventos/${evento.slug}`, {
              limit: EVENTOS_CAROUSEL_LIST_LIMIT,
            });
            return archivos
              .filter((item) => item.resource_type === "image")
              .map((item) => ({
                image: previewUrl(item.url),
                imageFull: item.url,
                name: evento.name,
                slug: evento.slug,
                created_at: item.created_at,
              }));
          } catch (err) {
            logger.warn("home", err);
            return [];
          }
        }),
      );

      cachedEventosPool = galerias
        .flat()
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      cachedEventosCarouselAt = Date.now();
    } catch (err) {
      logger.error("home", err);
    } finally {
      eventosCarouselRefreshPromise = null;
    }
  })();

  return eventosCarouselRefreshPromise;
}

async function fetchEventosCarousel() {
  const cacheFresh =
    Date.now() - cachedEventosCarouselAt < EVENTOS_CAROUSEL_CACHE_MS;

  if (cacheFresh && cachedEventosPool.length > 0) {
    return getEventosCarouselFromCache();
  }

  if (cachedEventosPool.length > 0) {
    loadEventosCarouselPool().catch((err) => {
      logger.error("home", err);
    });
    return getEventosCarouselFromCache();
  }

  await loadEventosCarouselPool();
  return getEventosCarouselFromCache();
}

// ==========================================
// RUTA: HOME
// ==========================================
router.get("/", requirePermission("inicio.acceso"), async (req, res) => {

  try {
    const dataFinanciera = cachedIndicadores;
    const dataClima = cachedClima;
    const dataLinkedin = cachedLinkedin;

    const hoy = new Date();
    const mes = hoy.getMonth() + 1;
    const diaHoy = hoy.getDate();
    const mesNombreRaw = new Intl.DateTimeFormat(getLocale(), {
      month: "long",
    }).format(hoy);
    const mesNombre =
      mesNombreRaw.charAt(0).toUpperCase() + mesNombreRaw.slice(1);

    // Saludo dinámico y fecha larga para el encabezado del home
    const horaActual = hoy.getHours();
    const saludo =
      horaActual < 12
        ? "Buenos días"
        : horaActual < 19
          ? "Buenas tardes"
          : "Buenas noches";
    const fechaLargaRaw = new Intl.DateTimeFormat(getLocale(), {
      weekday: "long",
      day: "numeric",
      month: "long",
    }).format(hoy);
    const fechaLarga =
      fechaLargaRaw.charAt(0).toUpperCase() + fechaLargaRaw.slice(1);
    const nombrePila = (() => {
      const u = req.session.user || {};
      const base = u.nombre || u.first_name || u.name || u.username || "";
      const primer = String(base).trim().split(/\s+/)[0] || "";
      return primer.charAt(0).toUpperCase() + primer.slice(1).toLowerCase();
    })();

    // FIX: LEFT JOIN en vez de INNER JOIN para no romper si area_trabajo_id es NULL
    const sqlMes = `
      SELECT
        u.first_name,
        u.last_name,
        TRIM(CONCAT(u.first_name, ' ', COALESCE(u.last_name, ''))) AS nombre,
        COALESCE(at.area_name, 'Sin área') AS area,
        at.color AS area_color,
        u.photo,
        EXTRACT(DAY FROM u.birth_date) AS dia
      FROM users u
      LEFT JOIN work_areas at ON at.id = u.work_area_id
      WHERE u.birth_date IS NOT NULL
        AND EXTRACT(MONTH FROM u.birth_date) = $1
      ORDER BY dia ASC, nombre ASC
    `;
    const sqlEventosPortada = `SELECT name, slug, image FROM events WHERE image IS NOT NULL AND image != '' ORDER BY created_at DESC LIMIT 8`;

    const emptyNoticiasHome = {
      noticiaDestacada: null,
      noticiasLista: [],
      mixedFeed: [],
    };

    // FIX: .catch(() => []) en cada query para que un fallo aislado no rompa todo el home
    const [resultsMes, eventosRows, noticiasHome, eventosPortadas] =
      await Promise.all([
        db
          .query(sqlMes, [mes])
          .then((r) => r.rows)
          .catch(() => []),
        fetchEventosCarousel().catch(() => []),
        fetchNoticiasHome().catch(() => emptyNoticiasHome),
        db
          .query(sqlEventosPortada)
          .then((r) => r.rows)
          .catch(() => []),
      ]);

    const { noticiaDestacada, noticiasLista, mixedFeed } = noticiasHome;

    // ==========================================
    // LÓGICA DEL PLATO DEL DÍA
    // ==========================================
    let platoDelDia = "No definido";
    let platoManana = null;
    let platosRows = [];

    if (isFeatureEnabled("lunchMenu")) {
      const d = new Date();
      let diaActual = d.getDay();
      if (diaActual === 0 || diaActual === 6) diaActual = 1;

      // FIX: .catch para que si la tabla platos no existe no rompa el home
      const menuResult = await db
        .query(
          "SELECT day_number, dish_name FROM lunch_menu ORDER BY day_number ASC",
        )
        .catch(() => ({ rows: [] }));
      platosRows = menuResult.rows;

      const platoHoy = platosRows.find((p) => p.day_number === diaActual);
      platoDelDia = platoHoy ? platoHoy.dish_name : "No definido";

      const diaManana = diaActual < 5 ? diaActual + 1 : null;
      const platoMananaRow = diaManana
        ? platosRows.find((p) => p.day_number === diaManana)
        : null;
      platoManana = diaManana
        ? (platoMananaRow ? platoMananaRow.dish_name : "No definido")
        : null;
    }

    let quickPreference = null;
    const userId = req.session.user && req.session.user.id;
    if (isFeatureEnabled("homeQuickAccess") && userId > 0) {
      try {
        const { rows } = await db.query(
          "SELECT home_quick_access FROM users WHERE id = $1",
          [userId],
        );
        quickPreference = rows[0] ? rows[0].home_quick_access : null;
      } catch (err) {
        if (err.code !== "42703") logger.warn("home", err);
      }
    }
    const quickAccess = isFeatureEnabled("homeQuickAccess")
      ? resolveHomeQuickAccess({
          countryCode: res.locals.country,
          features: res.locals.features,
          preference: quickPreference,
          corporateSite: res.locals.countryConfig.corporateSite,
        })
      : null;

    await res.render("home", {
      // El sufijo por país lo añade formatPageTitle en la vista.
      titulo: "Inicio",
      finanzas: dataFinanciera,
      clima: dataClima,
      saludo,
      fechaLarga,
      nombrePila,
      mesNombre,
      diaHoy,
      cumpleaniosMes: resultsMes.map((p) => ({
        ...p,
        monogram: getMonogram(p),
      })),
      eventosCarousel: eventosRows,
      eventosPortadas,
      mixedCarousel: mixedFeed,
      noticiaDestacada,
      noticiasLista,
      linkedinFeed: isFeatureEnabled("linkedinFeed") ? dataLinkedin : [],
      platoDelDia,
      platoManana,
      menuSemanal: platosRows,
      user: req.session.user,
      showHomeTutorial:
        req.session.user &&
        req.session.user.id > 0 &&
        req.session.user.show_home_tutorial === true,
      quickAccess,
    });
  } catch (err) {
    logger.error("home", err);
    res.status(500).send("Error cargando el inicio");
  }
});

// ==========================================
// ACCESOS RÁPIDOS DEL HOME
// ==========================================
router.post(
  "/home/accesos",
  requireFeature("homeQuickAccess"),
  requirePermission("inicio.accesos.personalizar"),
  async (req, res) => {
    if (!req.session.user || !req.session.user.id) {
      return res.status(401).json({ ok: false });
    }

    const userId = req.session.user.id;
    const resolved = resolveHomeQuickAccess({
      countryCode: res.locals.country,
      features: res.locals.features,
      preference: null,
      corporateSite: res.locals.countryConfig.corporateSite,
    });
    const sanitized = sanitizeHomeQuickAccess(req.body, resolved.defaults);

    // La cuenta de desarrollo no tiene fila: se queda con el orden del país.
    if (userId <= 0) {
      return res.json({ ok: true, persisted: false });
    }

    try {
      await db.query(
        "UPDATE users SET home_quick_access = $1::jsonb WHERE id = $2",
        [sanitized ? JSON.stringify(sanitized) : null, userId],
      );
      return res.json({ ok: true, persisted: true });
    } catch (err) {
      if (err.code === "42703") {
        return res.status(503).json({
          ok: false,
          error: "La preferencia todavía no está disponible.",
        });
      }
      logger.error("home", err);
      return res.status(500).json({ ok: false, error: "No se pudo guardar." });
    }
  },
);

// ==========================================
// TUTORIAL DE BIENVENIDA (PRIMER INICIO)
// ==========================================
router.post("/home/tutorial-visto", async (req, res) => {
  if (!req.session.user || !req.session.user.id) {
    return res.status(401).json({ ok: false });
  }

  const userId = req.session.user.id;
  if (userId <= 0) {
    req.session.user.show_home_tutorial = false;
    req.session.user.home_tutorial_seen = true;
    return res.json({ ok: true });
  }

  try {
    await db.query(
      `UPDATE users
       SET home_tutorial_seen = TRUE,
           last_login_at = COALESCE(last_login_at, NOW())
       WHERE id = $1`,
      [userId],
    );
    req.session.user.show_home_tutorial = false;
    req.session.user.home_tutorial_seen = true;
    return res.json({ ok: true });
  } catch (err) {
    if (err.code === "42703") {
      try {
        await db.query(
          "UPDATE users SET home_tutorial_seen = TRUE WHERE id = $1",
          [userId],
        );
      } catch (_) {
        /* columna aún no migrada */
      }
      req.session.user.show_home_tutorial = false;
      req.session.user.home_tutorial_seen = true;
      return res.json({ ok: true });
    }
    console.error("[HOME] Error marcando tutorial visto:", err.message);
    return res.status(500).json({ ok: false });
  }
});

// ==========================================
// GUARDAR MENÚ SEMANAL
// ==========================================
router.post("/platos/editar", requireFeature("lunchMenu"), requirePermission("casino.menu.editar"), async (req, res) => {

  const { plato_1, plato_2, plato_3, plato_4, plato_5 } = req.body;
  try {
    await db.query("UPDATE lunch_menu SET dish_name = $1 WHERE day_number = 1", [
      plato_1,
    ]);
    await db.query("UPDATE lunch_menu SET dish_name = $1 WHERE day_number = 2", [
      plato_2,
    ]);
    await db.query("UPDATE lunch_menu SET dish_name = $1 WHERE day_number = 3", [
      plato_3,
    ]);
    await db.query("UPDATE lunch_menu SET dish_name = $1 WHERE day_number = 4", [
      plato_4,
    ]);
    await db.query("UPDATE lunch_menu SET dish_name = $1 WHERE day_number = 5", [
      plato_5,
    ]);

    res.redirect("/?ok=MenuActualizado");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error actualizando el menú");
  }
});

// ==========================================
// LINKEDIN
// ==========================================
router.get(
  "/auth/linkedin/renovar",
  requireFeature("linkedinFeed"),
  // El enlace viejo sigue sirviendo, pero pasa por el login de LinkedIn de
  // auth.js, que exige «Conectar la cuenta de LinkedIn» y valida el `state`.
  (req, res) => res.redirect("/auth/linkedin/login"),
);

module.exports = router;
module.exports.startHomeBackgroundJobs = startHomeBackgroundJobs;
