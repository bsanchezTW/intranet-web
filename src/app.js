// ================================
// Zona horaria y Configuración
// ================================
// config/env valida el entorno y falla el arranque si COUNTRY (u otra variable
// obligatoria) falta o es inválida. Va primero: db.js y los servicios leen
// process.env al ser requeridos.
const { countryConfig } = require("./config/env");
const logger = require("./utils/logger");

// La zona horaria sale de la instancia, no de un literal: Chile es
// America/Santiago y Perú America/Lima.
process.env.TZ = countryConfig.timezone;

const express = require("express");
const compression = require("compression");
const path = require("path");
const { pipeline } = require("stream/promises");
const session = require("express-session");
const expressLayouts = require("express-ejs-layouts");
const db = require("./db");
// Handshake TLS+SCRAM al pooler lo antes posible, en paralelo con el setup.
db.warmPool();
// ================================
// Importación de Rutas
// ================================
const authRoutes = require("./routes/auth");
const adminDbTestRoutes = require("./routes/adminDbTest");
const indexRoutes = require("./routes/index");
const procesosRoutes = require("./routes/procesos");
const personasRoutes = require("./routes/RRHH");
const marketingRoutes = require("./routes/marketing");
const docsRoutes = require("./routes/docs");
const noticiasRoutes = require("./routes/noticias");
const { ROLES, normalizeRole, isAdministrador } = require("./constants/roles");
const { formatPageTitle } = require("./utils/pageTitle");
const { phoneClientConfig } = require("./utils/phone");
const { getMonogram, applyIdentityToSession } = require("./utils/monogram");
const requireFeature = require("./middlewares/requireFeature");
const { getFeatures, isFeatureEnabled } = require("./config/features");
const { canManageRrhh } = require("./services/access/staffAccess");
const { TICKET_CATEGORIES, ticketCategoryLabel } = require("./constants/ticketCategories");
const { migrateTicketCategories } = require("./services/tickets/ticketSchema");
const ticketsRoutes = isFeatureEnabled("supportTickets")
  ? require("./routes/tickets")
  : null;
const claudeRoutes = isFeatureEnabled("claudeAssistant")
  ? require("./routes/claude")
  : null;
const gastosRoutes = isFeatureEnabled("expenseRequests")
  ? require("./routes/gastos")
  : null;
const { syncUnverifiedUsersToDisabled } = require("./utils/syncDisabledUsers");
const storageService = require("./services/storage/storageService");
const {
  isActiveContentType,
  contentDispositionFor,
} = require("./services/storage/storageHttp");
const signedMedia = require("./services/media/signedMedia");
const { ensureVacationSchema } = require("./services/vacations/vacationSchema");
const { ensureWorkAreaSchema } = require("./services/workAreaSchema");
const { ensureExpenseSchema } = require("./services/expenses/expenseSchema");
const {
  ensureCostCenterSchema,
} = require("./services/costCenters/costCenterSchema");
const {
  APP_CATALOG_VALUES,
  DEFAULT_APP_CATALOG,
} = require("./constants/appCatalogs");
const { rememberReturnTo } = require("./utils/returnTo");
const vacationRequestService = require("./services/vacations/vacationRequestService");

// ================================
// Inicializar app
// ================================
const app = express();
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET?.trim();

process.on("unhandledRejection", (reason) => {
  logger.error("process", reason);
});

if (
  process.env.NODE_ENV === "production" ||
  process.env.TRUST_PROXY === "true"
) {
  app.set("trust proxy", 1);
}

if (!SESSION_SECRET) {
  throw new Error("SESSION_SECRET es obligatorio. Configúralo en el archivo .env.");
}

// ================================
// Motor de vistas + layouts
// ================================
app.set("views", path.join(__dirname, "views"));
app.set("view engine", "ejs");
app.use(expressLayouts);
app.set("layout", "layout");
app.locals.formatPageTitle = formatPageTitle;
// Formato de celular del país, para inyectarlo al script de cliente.
app.locals.phoneClientConfig = phoneClientConfig;
app.locals.getMonogram = getMonogram;
// Categorías de tickets para el formulario, la lista y el detalle.
app.locals.ticketCategories = TICKET_CATEGORIES;
app.locals.ticketCategoryLabel = ticketCategoryLabel;

// ================================
// Middlewares Básicos
// ================================
app.use(compression());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const staticOptions = { maxAge: "1d", etag: true };
app.use(express.static(path.join(__dirname, "public"), staticOptions));
// FIX: Servir archivos estáticos desde <root>/public (donde vive public/uploads unificado)
app.use(express.static(path.join(__dirname, "..", "public"), staticOptions));

function setStorageHeaders(res, file, fallbackContentType) {
  const contentType =
    file.contentType || fallbackContentType || "application/octet-stream";
  const activeContent = isActiveContentType(contentType);
  // El objeto sigue conservando su metadata real en Storage, pero por HTTP el
  // contenido activo se fuerza a descarga binaria para que nunca se interprete
  // en el origen de la intranet.
  res.set("Content-Type", activeContent ? "application/octet-stream" : contentType);

  const contentLength = Number(file.contentLength ?? file.size);
  if (Number.isFinite(contentLength) && contentLength >= 0) {
    res.set("Content-Length", String(contentLength));
  }
  if (file.contentRange) res.set("Content-Range", file.contentRange);
  if (file.etag) res.set("ETag", file.etag);
  if (file.lastModified) {
    const modified = new Date(file.lastModified);
    if (!Number.isNaN(modified.getTime())) {
      res.set("Last-Modified", modified.toUTCString());
    }
  }
  res.set("Accept-Ranges", "bytes");
  res.set("X-Content-Type-Options", "nosniff");
  if (activeContent) {
    res.set("Content-Disposition", contentDispositionFor(file));
    res.set("Content-Security-Policy", "sandbox; default-src 'none'");
  }
}

function storageRequestContext(req) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.once("aborted", abort);
  return {
    signal: controller.signal,
    cleanup: () => req.removeListener("aborted", abort),
  };
}

// ================================
// Medios públicos firmados (/media/<firma>/<ruta>)
// ================================
// Va ANTES de la sesión a propósito: los clientes de correo piden las imágenes
// sin cookies. La firma HMAC hace la URL inadivinable y solo se aceptan
// imágenes; documentos y videos siguen exigiendo sesión vía /content.
app.use("/media", async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();

  const raw = req.path.replace(/^\//, "");
  const separator = raw.indexOf("/");
  if (separator === -1) return res.status(404).send("No encontrado");

  const signature = raw.slice(0, separator);
  let relativePath;
  try {
    relativePath = storageService.normalizeRelativePath(
      decodeURIComponent(raw.slice(separator + 1)),
    );
  } catch {
    return res.status(400).send("Ruta inválida");
  }

  if (!relativePath || !signedMedia.isPubliclyServable(relativePath)) {
    return res.status(404).send("No encontrado");
  }
  if (!signedMedia.verify(relativePath, signature)) {
    return res.status(403).send("Firma inválida");
  }

  let requestContext;
  try {
    if (req.method === "HEAD") {
      const metadata = await storageService.statFile(relativePath);
      const tipo = metadata.contentType || signedMedia.contentTypeFor(relativePath);
      if (!signedMedia.isSafeContentType(tipo)) {
        return res.status(404).send("No encontrado");
      }
      setStorageHeaders(res, metadata, tipo);
      res.set("Cache-Control", "public, max-age=31536000, immutable, no-transform");
      return res.end();
    }

    requestContext = storageRequestContext(req);
    const file = await storageService.downloadStream(relativePath, {
      range: req.get("range") || undefined,
      signal: requestContext.signal,
    });
    const tipo = file.contentType || signedMedia.contentTypeFor(relativePath);

    // Comprobación final: por esta ruta pública solo salen imágenes. Cubre los
    // adjuntos heredados sin extensión, donde la ruta no basta para decidirlo.
    if (!signedMedia.isSafeContentType(tipo)) {
      file.stream.destroy();
      return res.status(404).send("No encontrado");
    }

    // Las rutas incluyen timestamp + aleatorio, por lo que son inmutables.
    res.status(file.statusCode || 200);
    setStorageHeaders(res, file, tipo);
    res.set("Cache-Control", "public, max-age=31536000, immutable, no-transform");
    await pipeline(file.stream, res);
    return undefined;
  } catch (err) {
    if (requestContext?.signal.aborted || err?.name === "AbortError") {
      return undefined;
    }
    if (res.headersSent) {
      res.destroy(err);
      return undefined;
    }
    if (err.statusCode === 404) return res.status(404).send("Archivo no encontrado");
    if (err.statusCode === 416) return res.status(416).send("Rango no válido");
    logger.error("media", err);
    return res.status(502).send("Error al obtener el archivo");
  } finally {
    requestContext?.cleanup();
  }
});

// ================================
// Sesiones (antes de /content para poder exigir auth)
// ================================
app.use(
  session({
    // El nombre lleva el país porque las cookies se comparten entre puertos del
    // mismo host: sin esto, Chile en :3000 y Perú en :3001 se pisan la sesión.
    name: countryConfig.sessionCookieName,
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    rolling: true, // ¡CLAVE! Renueva el tiempo de la cookie en cada petición al backend
    cookie: { maxAge: 1000 * 60 * 60 * 4 }, // Aumentamos la base a 4 horas por seguridad
  }),
);

// FIX: Unificado → <root>/public/uploads sirve /uploads/*
app.use("/uploads", express.static(path.join(__dirname, "..", "public", "uploads"), { maxAge: "7d", etag: true }));

// Archivos multimedia y documentos desde Storage (/content/...)
// Requiere sesión activa; no exponer contenido corporativo de forma pública.
app.use("/content", async (req, res, next) => {
  if (req.method !== "GET" && req.method !== "HEAD") return next();

  const hasSessionUser = Boolean(req.session && req.session.user);
  if (!hasSessionUser) {
    return res.status(401).send("No autorizado");
  }

  let relativePath;
  try {
    relativePath = storageService.normalizeRelativePath(
      decodeURIComponent(req.path.replace(/^\//, "")),
    );
  } catch {
    return res.status(400).send("Ruta inválida");
  }
  if (!relativePath) return next();

  let requestContext;
  try {
    if (req.method === "HEAD") {
      const metadata = await storageService.statFile(relativePath);
      setStorageHeaders(res, metadata);
      res.set("Cache-Control", "private, max-age=300, no-transform");
      return res.end();
    }

    requestContext = storageRequestContext(req);
    const file = await storageService.downloadStream(relativePath, {
      range: req.get("range") || undefined,
      signal: requestContext.signal,
    });
    res.status(file.statusCode || 200);
    setStorageHeaders(res, file);
    res.set("Cache-Control", "private, max-age=300, no-transform");
    await pipeline(file.stream, res);
    return undefined;
  } catch (err) {
    if (requestContext?.signal.aborted || err?.name === "AbortError") {
      return undefined;
    }
    if (res.headersSent) {
      res.destroy(err);
      return undefined;
    }
    if (err.statusCode === 400) {
      return res.status(400).send("Ruta inválida");
    }
    if (err.statusCode === 404) {
      return res.status(404).send("Archivo no encontrado");
    }
    if (err.statusCode === 416) {
      return res.status(416).send("Rango no válido");
    }
    logger.error("content", err);
    return res.status(502).send("Error al obtener el archivo");
  } finally {
    requestContext?.cleanup();
  }
});

// ================================
// Variables Globales y Permisos
// ================================
app.use(async (req, res, next) => {
  const user = req.session.user;

  // Identidad de la instancia disponible en todas las vistas.
  res.locals.country = countryConfig.code;
  res.locals.countryConfig = countryConfig;
  // Capacidades de la instancia, para filtrar navegación y bloques de UI.
  res.locals.features = getFeatures();

  res.locals.usuario = req.session.user || null;

  if (user) {
    // Sesiones anteriores al monograma no traen área: una consulta y queda
    // en la cookie. `area_color: null` (sin área) también cuenta como listo.
    if (user.id && user.area_color === undefined) {
      try {
        const { rows } = await db.query(
          `SELECT u.first_name, u.last_name, u.photo, u.work_area_id,
                  at.area_name, at.color AS area_color
             FROM users u
             LEFT JOIN work_areas at ON at.id = u.work_area_id
            WHERE u.id = $1`,
          [user.id],
        );
        if (rows[0]) applyIdentityToSession(user, rows[0]);
        else user.area_color = null;
      } catch (err) {
        logger.warn("session-identity", err);
        user.area_color = null;
      }
    }

    const role = normalizeRole(user.role);
    res.locals.userRole = role;
    res.locals.isAdministrador = isAdministrador(role);
    // Administración de RRHH y colaboradores: admins de RRHH o de Informática.
    const gestionaRrhh = await canManageRrhh(user);
    res.locals.canManageRrhh = gestionaRrhh;

    res.locals.can = {
      procedimientos_write: isAdministrador(role),
      protocolos_write: isAdministrador(role),
      reglamento_write: isAdministrador(role),
      noticias_write: isAdministrador(role),
      personas_write: gestionaRrhh,
      organigrama_write: isAdministrador(role),
      achs_write: isAdministrador(role),
      eventos_write: isAdministrador(role),
      tickets_reply: isAdministrador(role),
      apps_write: isAdministrador(role),
      cursos_write: isAdministrador(role),
      vacaciones_write: gestionaRrhh,
      vacaciones_request:
        role === ROLES.USUARIO || isAdministrador(role),
    };
    res.locals.unreadTickets = req.session.ticketNotifications?.count || 0;
  } else {
    res.locals.canManageRrhh = false;
    res.locals.can = {};
    res.locals.unreadTickets = 0;
  }
  next();
});

// ================================
// Middleware de protección
// ================================
function wantsJsonResponse(req) {
  const accept = req.headers.accept || "";
  const requestedWith = String(req.get("X-Requested-With") || "");
  const contentType = String(req.get("Content-Type") || "");
  return (
    req.xhr ||
    requestedWith.toLowerCase() === "fetch" ||
    accept.includes("application/json") ||
    contentType.includes("application/json") ||
    /\/(api|upload)\//.test(req.originalUrl) ||
    req.originalUrl.includes("/adjuntos/")
  );
}

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  rememberReturnTo(req);
  if (wantsJsonResponse(req)) {
    return res
      .status(401)
      .json({ error: "Sesión expirada. Vuelve a iniciar sesión." });
  }
  return res.redirect("/login");
}

// ================================
// Montaje de Rutas
// ================================
app.use("/", authRoutes); // Login/Registro (Públicas)
app.use("/", adminDbTestRoutes); // Diagnóstico BD (sin sesión: el login puede estar en 500)
// Rutas Protegidas
app.use("/", requireAuth, indexRoutes);
app.use("/procesos", requireAuth, procesosRoutes);
app.use("/RRHH", requireAuth, personasRoutes);
if (gastosRoutes) {
  app.use("/gastos", requireAuth, requireFeature("expenseRequests"), gastosRoutes);
}
if (ticketsRoutes) {
  app.use("/sistemas", requireAuth, requireFeature("supportTickets"), ticketsRoutes);
}
app.use("/marketing", requireAuth, marketingRoutes);
app.use("/docs", requireAuth, docsRoutes);
app.use("/noticias", requireAuth, noticiasRoutes);
if (claudeRoutes) {
  app.use("/claude", requireAuth, requireFeature("claudeAssistant"), claudeRoutes);
}

// Multer corta el body antes de entrar al handler cuando supera el límite.
// Convertimos ese error en 413 para evitar que termine como un 500 genérico.
app.use((err, req, res, next) => {
  if (err?.code === "LIMIT_FILE_SIZE") {
    const message = "El archivo excede el límite de subida permitido.";
    const acceptsJson =
      req.xhr ||
      req.get("accept")?.includes("application/json") ||
      req.originalUrl.includes("/upload") ||
      req.originalUrl.startsWith("/noticias");

    if (acceptsJson) return res.status(413).json({ error: message });
    return res.status(413).send(message);
  }

  logger.error("http", err);
  if (err?.stack) console.error(err.stack);
  if (res.headersSent) return next(err);

  const isLocal =
    process.env.NODE_ENV !== "production" ||
    /localhost|127\.0\.0\.1/i.test(String(process.env.APP_BASE_URL || ""));
  const message = isLocal && err?.message
    ? `Error interno del servidor: ${err.message}`
    : "Error interno del servidor";

  const acceptsJson =
    req.xhr ||
    req.get("accept")?.includes("application/json") ||
    req.originalUrl.includes("/api/");

  if (acceptsJson) return res.status(500).json({ error: message });
  return res.status(500).send(message);
});

// Manejo de 404
app.use((req, res) => {
  res.status(404).render("404", { titulo: "Página no encontrada" });
});

// ==========================================
// TAREA 1: CERRAR TICKETS ANTIGUOS
// ==========================================
function iniciarTareaCierreTickets() {
  const ejecutarCierre = async () => {
    try {
      const sql = `
        UPDATE support_tickets 
        SET status = 'closed', closed_at = NOW(), auto_closed = TRUE
        WHERE status = 'pending_close' 
        AND resolved_at < (NOW() - INTERVAL '1 day')
      `;

      const result = await db.query(sql);
      const afectados = result.rowCount || result.affectedRows || 0;

      if (afectados > 0) {
        logger.info("cron", `cerrados ${afectados} ticket(s) pendiente(s) de cierre`);
      }
    } catch (err) {
      logger.error("cron", err);
    }
  };

  // Ejecutar inmediatamente al iniciar el servidor para limpiar los tickets rezagados
  ejecutarCierre();

  // Y luego continuar ejecutando la revisión cada 1 hora
  setInterval(ejecutarCierre, 3600000);
}

// ==========================================
// TAREA 2: LIMPIEZA DE HISTORIAL
// ==========================================
function iniciarLimpiezaHistorial() {
  const ejecutarLimpieza = async () => {
    try {
      const sql = `
        DELETE FROM change_log 
        WHERE created_at < (NOW() - INTERVAL '5 days')
      `;

      const result = await db.query(sql);
      const borrados = result.rowCount || result.affectedRows || 0;

      if (borrados > 0) {
        logger.info("cron", `eliminados ${borrados} registro(s) de historial`);
      }
    } catch (err) {
      logger.error("cron", err);
    }
  };

  // Ejecutar inmediatamente al iniciar
  ejecutarLimpieza();

  // Y luego cada 12 horas
  setInterval(ejecutarLimpieza, 43200000);
}

// ==========================================
// TAREA 2b: BORRADORES DE GASTOS CADUCADOS
// ==========================================
// Un borrador sin cambios en DRAFT_TTL_DAYS días se elimina con sus líneas y
// sus comprobantes del bucket: nadie va a volver por él y sólo ocupa espacio.
function iniciarPurgaBorradoresGastos() {
  const expenseRequests = require("./services/expenses/expenseRequestService");
  const ejecutar = async () => {
    try {
      const { drafts, files } = await expenseRequests.purgeStaleDrafts();
      if (drafts > 0) {
        logger.info("cron", `eliminados ${drafts} borrador(es) de gastos y ${files} comprobante(s)`);
      }
      // Después de la purga, para que sus archivos no cuenten como en uso.
      const huerfanos = await expenseRequests.purgeOrphanUploads();
      if (huerfanos.deleted > 0) {
        logger.info("cron", `eliminados ${huerfanos.deleted} comprobante(s) de gastos sin solicitud`);
      }
    } catch (err) {
      logger.error("cron", err);
    }
  };

  ejecutar();
  setInterval(ejecutar, 43200000);
}

// ==========================================
// TAREA 3: TRANSICIONES DE ESTADO DE VACACIONES
// ==========================================
function iniciarTransicionesVacaciones() {
  const ejecutar = async () => {
    try {
      const { inProgress, completed } =
        await vacationRequestService.runDailyStatusTransitions();
      if (inProgress > 0 || completed > 0) {
        logger.info(
          "cron",
          `vacaciones: ${inProgress} en curso, ${completed} completadas`,
        );
      }
    } catch (err) {
      logger.error("cron", err);
    }
  };

  ejecutar();
  // Cada 12 horas
  setInterval(ejecutar, 43200000);
}

async function sincronizarUsuariosDeshabilitados() {
  try {
    const actualizados = await syncUnverifiedUsersToDisabled();
    if (actualizados > 0) {
      logger.info(
        "usuarios",
        `${actualizados} colaborador(es) a Deshabilitado (sin correo o sin verificar)`,
      );
    }
  } catch (err) {
    logger.error("usuarios", err);
  }
}

// El correo es identificador único de usuario: la BD lo garantiza con un
// índice único (ignora mayúsculas/minúsculas y espacios).
async function asegurarCorreoUnico() {
  try {
    await db.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
      ON users (LOWER(TRIM(email)))
      WHERE email IS NOT NULL AND TRIM(email) <> ''
    `);
  } catch (err) {
    logger.error("usuarios", err);
  }
}

async function asegurarColumnaNoticiasDestacada() {
  try {
    await db.query(`
      ALTER TABLE news_articles
        ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT false
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_news_articles_featured ON news_articles (featured)
        WHERE featured = true
    `);
  } catch (err) {
    logger.error("noticias", err);
  }
}

async function asegurarColumnaAppsIconUrl() {
  try {
    await db.query(`
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS icon_url TEXT
    `);
  } catch (err) {
    logger.error("apps", err);
  }
}

async function asegurarColumnaAppsUrlIos() {
  try {
    await db.query(`
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS url_ios TEXT
    `);
  } catch (err) {
    logger.error("apps", err);
  }
}

async function asegurarColumnaAppsUrlWeb() {
  try {
    await db.query(`
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS url_web TEXT
    `);
  } catch (err) {
    logger.error("apps", err);
  }
}

/**
 * Separa el catálogo comercial (vista Apps) del de autoayuda (vista Soporte).
 * Las filas existentes quedan en el catálogo corporativo por el DEFAULT, así que
 * la migración no toca lo ya publicado en /apps.
 */
async function asegurarColumnaAppsCatalog() {
  try {
    await db.query(`
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS catalog VARCHAR(20) NOT NULL
        DEFAULT '${DEFAULT_APP_CATALOG}'
    `);
    await db.query(`
      DO $do$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
          FROM pg_constraint con
          JOIN pg_class c ON c.oid = con.conrelid
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE con.conname = 'applications_catalog_check'
            AND c.relname = 'applications'
            AND n.nspname = current_schema()
        ) THEN
          ALTER TABLE applications
            ADD CONSTRAINT applications_catalog_check
            CHECK (catalog IN (${APP_CATALOG_VALUES.map((v) => `'${v}'`).join(", ")}));
        END IF;
      END
      $do$;
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_applications_catalog
        ON applications (catalog)
    `);
  } catch (err) {
    logger.error("apps", err);
  }
}

/**
 * Orden manual de las tarjetas dentro de cada catálogo.
 *
 * Nace en NULL a propósito: mientras nadie reordene, el listado conserva el
 * orden por fecha que tenía, y las apps nuevas caen al final hasta que se las
 * coloque a mano.
 */
async function asegurarColumnaAppsOrden() {
  try {
    await db.query(`
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS sort_order INTEGER
    `);
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_applications_catalog_orden
        ON applications (catalog, sort_order)
    `);
  } catch (err) {
    logger.error("apps", err);
  }
}

// ================================
// INICIAR SERVIDOR
// ================================
async function asegurarSchemaVacaciones() {
  try {
    await ensureVacationSchema();
  } catch (err) {
    logger.error("vacaciones", err);
  }
}

// Va después de asegurarSchemaGastos: añade columnas a expense_requests, que
// esa función es la que crea.
async function asegurarSchemaCentrosCosto() {
  try {
    await ensureCostCenterSchema();
  } catch (err) {
    logger.error("centros-costo", err);
  }
}

async function asegurarSchemaGastos() {
  try {
    await ensureExpenseSchema();
  } catch (err) {
    logger.error("gastos", err);
  }
}

async function asegurarSchemaAreas() {
  try {
    await ensureWorkAreaSchema();
  } catch (err) {
    logger.error("areas", err);
  }
}

async function asegurarCategoriasTickets() {
  try {
    const migradas = await migrateTicketCategories();
    if (migradas > 0) logger.info("tickets", `${migradas} ticket(s) con la categoría actualizada`);
  } catch (err) {
    logger.error("tickets", err);
  }
}

function startBackgroundJobs() {
  if (isFeatureEnabled("supportTickets")) {
    iniciarTareaCierreTickets();
  }
  iniciarLimpiezaHistorial();

  // Migraciones y sincronización en background (no bloquean el arranque).
  Promise.allSettled([
    asegurarCorreoUnico(),
    asegurarColumnaNoticiasDestacada(),
    asegurarColumnaAppsIconUrl(),
    asegurarColumnaAppsUrlIos(),
    asegurarColumnaAppsUrlWeb(),
    asegurarColumnaAppsCatalog(),
    asegurarColumnaAppsOrden(),
    sincronizarUsuariosDeshabilitados(),
    asegurarSchemaVacaciones(),
    asegurarSchemaAreas(),
    isFeatureEnabled("supportTickets") ? asegurarCategoriasTickets() : null,
    asegurarSchemaGastos().then(asegurarSchemaCentrosCosto),
  ]).finally(() => {
    if (isFeatureEnabled("vacations")) iniciarTransicionesVacaciones();
    // Después del schema: la purga usa el estado 'draft' y su índice.
    iniciarPurgaBorradoresGastos();
  });
}

function onHttpListening(bindLabel) {
  logger.info(
    "http",
    `${bindLabel}  ${countryConfig.code}  TZ=${countryConfig.timezone}`,
  );
  startBackgroundJobs();
}

function listenAndLog(args, bindLabel) {
  const server = app.listen(...args, () => onHttpListening(bindLabel));
  server.on("error", (err) => {
    logger.error("http", err);
    // Si el puerto está ocupado el proceso igual abre el pool de Postgres.
    // Varias instancias `npm run dev:cl` agotan el pooler (máx. 15) y /gastos
    // responde "Error cargando tus solicitudes".
    if (err && err.code === "EADDRINUSE") {
      process.exit(1);
    }
  });
  return server;
}

function startHttpServer() {
  const rawPort = process.env.PORT;
  const passengerGlobal =
    typeof PhusionPassenger !== "undefined" ? PhusionPassenger : null;
  const isPassenger =
    Boolean(passengerGlobal) || String(rawPort || "").trim() === "passenger";

  if (passengerGlobal) {
    passengerGlobal.configure({ autoInstall: false });
  }

  // cPanel/Passenger: hay que marcar el socket como listo YA. Los crons de
  // Chile (tickets, LinkedIn, mindicador) no pueden retrasar el listen.
  if (isPassenger) {
    listenAndLog(["passenger"], "passenger");
    return;
  }

  const trimmed = String(rawPort || "").trim();
  if (trimmed.includes("/") || trimmed.endsWith(".sock")) {
    listenAndLog([trimmed], trimmed);
    return;
  }

  const parsed = Number(trimmed);
  const listenPort = Number.isFinite(parsed) && parsed > 0 ? parsed : Number(PORT) || 3000;
  // IPv4 explícito: listen(PORT) puede quedar solo en :: y Apache (127.0.0.1)
  // responde 503 para siempre.
  const host = process.env.HOST || "0.0.0.0";
  listenAndLog([listenPort, host], `${host}:${listenPort}`);
}

startHttpServer();
module.exports = app;
