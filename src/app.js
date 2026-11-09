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
const { httpCompression } = require("./utils/httpCompression");
const path = require("path");
const { createReadStream } = require("fs");
const session = require("express-session");
const { PgSessionStore } = require("./services/session/pgSessionStore");
const { getCountryDbBinding } = require("./config/supabaseProjects");
const expressLayouts = require("express-ejs-layouts");
const db = require("./db");
const { eventSlugFromContentPath } = require("./utils/eventAccess");
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
const permisosRoutes = require("./routes/permisos");
const impersonation = require("./services/permissions/impersonation");
const { withQueryParam } = require("./utils/returnTo");
const noticiasRoutes = require("./routes/noticias");
const { formatPageTitle } = require("./utils/pageTitle");
const { publicErrorMessage, isUserFacingError } = require("./utils/publicError");
const { pageSkeletonFor } = require("./utils/pageSkeleton");
const { phoneClientConfig } = require("./utils/phone");
const { getMonogram, applyIdentityToSession } = require("./utils/monogram");
const requireFeature = require("./middlewares/requireFeature");
const requirePermission = require("./middlewares/requirePermission");
const { crossOriginProtection } = require("./middlewares/crossOriginProtection");
const { securityHeaders, cspReportRouter } = require("./middlewares/securityHeaders");
const { saveSessionBeforeRedirect } = require("./middlewares/saveSessionBeforeRedirect");
const { getFeatures, isFeatureEnabled } = require("./config/features");
const { checkSessionAccount } = require("./services/access/accountStatus");
const { canAccessContent, classifyContentPath } = require("./services/access/contentAccess");
const { veListadoDeCarpetas } = require("./services/documents/processAccess");
const vacationPolicy = require("./services/vacations/vacationPolicy");
const { TICKET_CATEGORIES, ticketCategoryLabel } = require("./constants/ticketCategories");
const { migrateTicketCategories, ensureTicketReplyCorrelatives } = require("./services/tickets/ticketSchema");
const { UPLOAD_LIMITS_MB } = require("./config/uploadLimits");
const ticketsRoutes = isFeatureEnabled("supportTickets")
  ? require("./routes/tickets")
  : null;
const claudeRoutes = isFeatureEnabled("claudeAssistant")
  ? require("./routes/claude")
  : null;
const gastosRoutes = isFeatureEnabled("expenseRequests")
  ? require("./routes/gastos")
  : null;
const letrasRoutes = isFeatureEnabled("billsOfExchange")
  ? require("./routes/letras")
  : null;
const logisticaRoutes = isFeatureEnabled("logistics")
  ? require("./routes/logistica")
  : null;
const { ensureLogisticsSchema } = require("./services/logistics/logisticsSchema");
const {
  ensureBillOfExchangeSchema,
} = require("./services/billsOfExchange/billOfExchangeSchema");
const { syncUnverifiedUsersToDisabled } = require("./utils/syncDisabledUsers");
const storageService = require("./services/storage/storageService");
const fileStorage = require("./services/fileStorage");
const {
  isActiveContentType,
  contentDispositionFor,
  parseByteRange,
  discardStoredStream,
  pipeStoredStream,
} = require("./services/storage/storageHttp");
const contentCache = require("./services/storage/contentCache");
const eventThumbnails = require("./services/media/eventThumbnails");
const signedMedia = require("./services/media/signedMedia");
const { ensureVacationSchema } = require("./services/vacations/vacationSchema");
const { ensureWorkAreaSchema } = require("./services/workAreaSchema");
const { ensurePermissionSchema } = require("./services/permissions/permissionSchema");
const { ensureBootstrapped } = require("./services/permissions/autoBootstrap");
const { convertSetsIfNeeded } = require("./services/permissions/setConversion");
const { removeRetiredAssignments } = require("./services/permissions/retiredKeys");
const permissions = require("./services/permissions/permissionService");
const { emptyPermissions } = require("./services/permissions/resolver");
const { getCatalog } = require("./services/permissions/catalog");
const { buildViewCan } = require("./services/permissions/viewCan");
const { ensureExpenseSchema } = require("./services/expenses/expenseSchema");
const {
  ensureCostCenterSchema,
} = require("./services/costCenters/costCenterSchema");
const { runMigrations } = require("./services/schema/migrator");
const { createStartupGate } = require("./middlewares/startupGate");
const migrations = require("./migrations");
const { wantsJson, denyUnauthenticated } = require("./utils/httpResponses");
const {
  createJobRunner,
  defaultJobs,
  inProcessJobsEnabled,
} = require("./services/jobs/jobRunner");

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
app.locals.maxTicketAttachmentMb = UPLOAD_LIMITS_MB.TICKET_ATTACHMENT;
app.locals.eventPreviewUrl = (url) => eventThumbnails.previewUrl(url) || url;

// ================================
// Middlewares Básicos
// ================================
app.disable("x-powered-by");
// Cabeceras de seguridad y CSP (aplicada mínima + sólo reporte) en todas las
// respuestas, estáticos incluidos.
app.use(securityHeaders());
app.use(httpCompression());
// Reportes CSP del navegador: antes de la protección CSRF, que no los manda
// el usuario sino el navegador por su cuenta.
app.use(cspReportRouter());
// CSRF: antes de leer el cuerpo. Rechaza POST/PUT/PATCH/DELETE que el
// navegador marca como de otro sitio (ver crossOriginProtection).
app.use(crossOriginProtection());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const staticOptions = { maxAge: "1d", etag: true };
app.use(express.static(path.join(__dirname, "public"), staticOptions));
// FIX: Servir archivos estáticos desde <root>/public (donde vive public/uploads unificado)
app.use(express.static(path.join(__dirname, "..", "public"), staticOptions));

// Hasta que terminan las migraciones y las ensure*Schema del arranque, 503
// «La intranet se está actualizando» (los estáticos de arriba se sirven
// igual). Se abre en runStartupDbTasks; ver middlewares/startupGate.js.
const startupGate = createStartupGate({ logger });
app.use(startupGate.middleware);

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

function storageRequestContext(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (!controller.signal.aborted) controller.abort();
  };
  const onResponseClose = () => {
    if (!res.writableFinished) abort();
  };
  req.once("aborted", abort);
  res.once("close", onResponseClose);
  return {
    signal: controller.signal,
    cleanup: () => {
      req.removeListener("aborted", abort);
      res.removeListener("close", onResponseClose);
    },
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
      const metadata = await fileStorage.statStoredObject(relativePath);
      const tipo = metadata.contentType || signedMedia.contentTypeFor(relativePath);
      if (!signedMedia.isSafeContentType(tipo)) {
        return res.status(404).send("No encontrado");
      }
      setStorageHeaders(res, metadata, tipo);
      res.set("Cache-Control", "public, max-age=31536000, immutable, no-transform");
      return res.end();
    }

    requestContext = storageRequestContext(req, res);
    if (res.destroyed || res.closed) return undefined;
    const file = await fileStorage.streamStoredObject(relativePath, {
      range: req.get("range") || undefined,
      signal: requestContext.signal,
    });
    const tipo = file.contentType || signedMedia.contentTypeFor(relativePath);

    // Comprobación final: por esta ruta pública solo salen imágenes. Cubre los
    // adjuntos heredados sin extensión, donde la ruta no basta para decidirlo.
    if (!signedMedia.isSafeContentType(tipo)) {
      discardStoredStream(file.stream);
      return res.status(404).send("No encontrado");
    }

    // Las rutas incluyen timestamp + aleatorio, por lo que son inmutables.
    res.status(file.statusCode || 200);
    setStorageHeaders(res, file, tipo);
    res.set("Cache-Control", "public, max-age=31536000, immutable, no-transform");
    await pipeStoredStream(file.stream, res, requestContext.signal);
    return undefined;
  } catch (err) {
    if (requestContext?.signal.aborted || err?.name === "AbortError") {
      return undefined;
    }
    if (res.headersSent) {
      if (!res.destroyed) res.destroy();
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
// Vence tras 4 horas sin actividad: `rolling` la renueva en cada petición.
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 4;
// En Postgres y no en memoria: sobrevive a reinicios y la comparten los
// procesos de Passenger. Tabla del schema del país (ver PgSessionStore).
const sessionStore = new PgSessionStore({
  db,
  schema: getCountryDbBinding(countryConfig.code).schema,
  ttlMs: SESSION_MAX_AGE_MS,
});
sessionStore.startPruning();

app.use(
  session({
    // El nombre lleva el país porque las cookies se comparten entre puertos del
    // mismo host: sin esto, Chile en :3000 y Perú en :3001 se pisan la sesión.
    name: countryConfig.sessionCookieName,
    secret: SESSION_SECRET,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      maxAge: SESSION_MAX_AGE_MS,
      httpOnly: true,
      // Lax: un formulario de otro sitio no lleva la cookie. Los enlaces de
      // correo y el regreso de LinkedIn son GET de primer nivel y sí la llevan.
      sameSite: "lax",
      // "auto": Secure cuando la petición llega por HTTPS (con `trust proxy`
      // detrás del proxy). Un `true` fijo sin `trust proxy` dejaría a todos
      // sin poder iniciar sesión.
      secure: "auto",
    },
  }),
);
app.use(saveSessionBeforeRedirect);

// La sesión se renueva sola en cada petición: se contrasta con la base para
// que desactivar o eliminar a alguien valga en segundos y no cuando se le
// venza la sesión.
app.use(async (req, res, next) => {
  const user = req.session && req.session.user;
  if (!user) return next();
  let estado;
  try {
    estado = await checkSessionAccount(user);
  } catch (err) {
    logger.error("cuentas", err);
    return next();
  }
  if (estado.action !== "end") return next();

  // Deshabilitaron a la persona suplantada: el superadmin vuelve a su cuenta.
  if (impersonation.activeImpersonation(req.session)) {
    try {
      const targetId = await impersonation.endImpersonation(req, { reason: "la cuenta quedó sin acceso" });
      if (wantsJson(req)) return res.status(409).json({ error: "La cuenta suplantada ya no tiene acceso." });
      return res.redirect(targetId ? `/permisos/usuarios/${targetId}` : "/permisos/usuarios");
    } catch (err) {
      return next(err);
    }
  }

  return req.session.destroy(() => {
    res.clearCookie(countryConfig.sessionCookieName);
    if (wantsJson(req)) {
      return res.status(401).json({ error: "Tu cuenta ya no tiene acceso a la intranet." });
    }
    return res.redirect("/login");
  });
});

// «Iniciar sesión como»: el superadmin navega con la identidad de otra
// persona; aquí se vigila y se registra (ver services/permissions/impersonation).
app.use(impersonation.impersonationGuard({ cookieName: countryConfig.sessionCookieName }));

// FIX: Unificado → <root>/public/uploads sirve /uploads/*
app.use("/uploads", express.static(path.join(__dirname, "..", "public", "uploads"), { maxAge: "7d", etag: true }));

async function sendCachedEventImage(req, res, entry, relativePath) {
  if (res.destroyed || res.closed || res.writableEnded) return undefined;
  const size = entry.size;
  const range = parseByteRange(req.get("range"), size);
  if (range?.unsatisfiable) {
    res.status(416);
    res.set("Content-Range", `bytes */${size}`);
    res.set("Accept-Ranges", "bytes");
    return res.end();
  }

  const start = range ? range.start : 0;
  const end = range ? range.end : Math.max(0, size - 1);
  const length = size === 0 ? 0 : end - start + 1;
  res.status(range ? 206 : 200);
  setStorageHeaders(res, {
    contentType: entry.contentType,
    contentLength: length,
    contentRange: range ? `bytes ${start}-${end}/${size}` : null,
    etag: entry.etag,
    lastModified: entry.lastModified,
    relativePath,
  });
  res.set("Cache-Control", eventThumbnails.cacheControlFor(relativePath));
  if (req.method === "HEAD" || length === 0) return res.end();
  if (!entry.filePath) {
    return res.end(range ? entry.buffer.subarray(start, end + 1) : entry.buffer);
  }

  const requestContext = storageRequestContext(req, res);
  try {
    const stream = createReadStream(
      entry.filePath,
      range ? { start, end } : undefined,
    );
    await pipeStoredStream(stream, res, requestContext.signal);
  } finally {
    requestContext.cleanup();
  }
  return undefined;
}

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
    // La sesión no basta: documentos de otras áreas, comprobantes de gastos y
    // adjuntos de tickets sólo los descarga quien puede verlos en su página.
    // /content corre antes del middleware de sesión, así que los permisos se
    // resuelven aquí y sólo si el archivo no es de acceso abierto.
    let permitido = true;
    if (classifyContentPath(relativePath).kind !== "open") {
      const sessionUser = req.session.user;
      let perms;
      try {
        perms = await permissions.resolve(sessionUser);
      } catch (err) {
        logger.error("permisos", err);
        perms = emptyPermissions(getCatalog(), sessionUser.id);
      }
      permitido = await canAccessContent(sessionUser, relativePath, { perms });
    }
    if (!permitido) {
      return res.status(403).send("No tienes permiso para ver este archivo");
    }


    // La vista `events` esconde el privado del otro país. Si no hay fila,
    // no se sirve la foto aunque alguien adivine la ruta.
    const eventSlug = eventSlugFromContentPath(relativePath);
    if (eventSlug) {
      const { rows } = await db.query("SELECT 1 FROM events WHERE slug = $1", [
        eventSlug,
      ]);
      if (!rows.length) return res.status(404).send("Archivo no encontrado");
    }

    if (req.method === "HEAD") {
      if (eventThumbnails.isDiskCacheable(relativePath)) {
        const cached = await contentCache.peek(relativePath);
        if (cached) {
          await sendCachedEventImage(req, res, cached, relativePath);
          return undefined;
        }
      }
      const metadata = await fileStorage.statStoredObject(relativePath);
      setStorageHeaders(res, metadata);
      res.set("Cache-Control", eventThumbnails.cacheControlFor(relativePath));
      return res.end();
    }

    if (eventThumbnails.isDiskCacheable(relativePath)) {
      const cached = await contentCache.load(relativePath, async () => {
        const file = await fileStorage.streamStoredObject(relativePath);
        try {
          const buffer = await contentCache.readStreamToBuffer(file.stream);
          return {
            buffer,
            contentType: file.contentType,
            etag: file.etag,
            lastModified: file.lastModified,
          };
        } catch (err) {
          discardStoredStream(file.stream);
          throw err;
        }
      });
      if (cached) {
        await sendCachedEventImage(req, res, cached, relativePath);
        return undefined;
      }
    }

    requestContext = storageRequestContext(req, res);
    if (res.destroyed || res.closed) return undefined;
    const file = await fileStorage.streamStoredObject(relativePath, {
      range: req.get("range") || undefined,
      signal: requestContext.signal,
    });
    res.status(file.statusCode || 200);
    setStorageHeaders(res, file);
    res.set("Cache-Control", eventThumbnails.cacheControlFor(relativePath));
    await pipeStoredStream(file.stream, res, requestContext.signal);
    return undefined;
  } catch (err) {
    if (requestContext?.signal.aborted || err?.name === "AbortError") {
      return undefined;
    }
    if (res.headersSent) {
      if (!res.destroyed) res.destroy();
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
  res.locals.esqueletoPagina = pageSkeletonFor(req.path);

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

    // Vacaciones (Gestión de Permisos): la bandeja de aprobación y la gestión
    // de RRHH se calculan más abajo, con req.perms.

    // Gestión de Permisos: req.perms para rutas y políticas, can('clave') en
    // las vistas; los dos pasan por decide().
    try {
      req.perms = await permissions.resolve(user);
    } catch (err) {
      logger.error("permisos", err);
      req.perms = emptyPermissions(getCatalog(), user.id);
    }
    res.locals.perms = req.perms;
    res.locals.veListadoCarpetas = veListadoDeCarpetas(req.perms);
    res.locals.isAreaManager = isFeatureEnabled("vacations") && vacationPolicy.aprueba(req.perms);
    res.locals.veGestionVacaciones = isFeatureEnabled("vacations") && vacationPolicy.veGestion(req.perms);
    // Letras de cambio en el menú y en Procesos: con «Entrar a Letras».
    res.locals.canIssueBills = isFeatureEnabled("billsOfExchange") && Boolean(req.perms && req.perms.can("letras.acceso"));
    res.locals.can = buildViewCan(req.perms);
    res.locals.unreadTickets = req.session.ticketNotifications?.count || 0;
  } else {
    res.locals.isAreaManager = false;
    res.locals.veGestionVacaciones = false;
    res.locals.canIssueBills = false;
    res.locals.veListadoCarpetas = false;
    req.perms = emptyPermissions(getCatalog());
    res.locals.perms = req.perms;
    res.locals.can = buildViewCan(req.perms);
    res.locals.unreadTickets = 0;
  }
  next();
});

// ================================
// Middleware de protección
// ================================

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return denyUnauthenticated(req, res);
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
if (letrasRoutes) {
  app.use(
    "/letras",
    requireAuth,
    requireFeature("billsOfExchange"),
    requirePermission("letras.acceso"),
    letrasRoutes,
  );
}
if (logisticaRoutes) {
  app.use("/logistica", requireAuth, requireFeature("logistics"), logisticaRoutes);
}
if (ticketsRoutes) {
  app.use("/soporte", requireAuth, requireFeature("supportTickets"), ticketsRoutes);
  // La página se llamó /sistemas. Los enlaces y correos viejos conservan el camino.
  app.use("/sistemas", requireAuth, requireFeature("supportTickets"), (req, res) => {
    const suffix = req.url && req.url !== "/" ? req.url : "";
    const target = suffix.startsWith("/?") ? `/soporte${suffix.slice(1)}` : `/soporte${suffix}`;
    res.redirect(308, target);
  });
}
app.use("/marketing", requireAuth, marketingRoutes);
app.use("/docs", requireAuth, docsRoutes);
// Gestión de Permisos: sólo el superadmin (el router responde 404 al resto).
app.use("/permisos", requireAuth, permisosRoutes);
// Volver a la cuenta propia tras «iniciar sesión como»: fuera de /permisos
// porque la persona suplantada no es superadmin.
app.post(impersonation.END_PATH, requireAuth, async (req, res, next) => {
  try {
    const targetId = await impersonation.endImpersonation(req);
    if (!targetId) return res.redirect("/");
    return res.redirect(withQueryParam(`/permisos/usuarios/${targetId}`, "ok", "Volviste a tu cuenta"));
  } catch (err) {
    return next(err);
  }
});
app.use("/noticias", requireAuth, noticiasRoutes);
if (claudeRoutes) {
  // Sin «Usar el asistente de la intranet» no se ve el botón ni responde la API.
  app.use("/claude", requireAuth, requireFeature("claudeAssistant"), requirePermission("asistente.acceso"), claudeRoutes);
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

  // Un 4xx (JSON mal formado, cuerpo muy grande…) es del cliente y su
  // mensaje se muestra; el resto es un 500 sin detalles internos, salvo con
  // NODE_ENV=development (ver utils/publicError).
  const status = isUserFacingError(err) ? Number(err.statusCode || err.status) : 500;
  const message = publicErrorMessage(err, "Error interno del servidor");

  const acceptsJson =
    req.xhr ||
    req.get("accept")?.includes("application/json") ||
    req.originalUrl.includes("/api/");

  if (acceptsJson) return res.status(status).json({ error: message });
  return res.status(status).type("text/plain").send(message);
});

// Manejo de 404
app.use((req, res) => {
  res.status(404).render("404", { titulo: "Página no encontrada" });
});

// ==========================================
// TAREAS PROGRAMADAS
// ==========================================
// Cierre de tickets, limpieza de historial, purga de gastos y transiciones
// de vacaciones. Quién las corre lo decide la base (services/jobs): sin
// duplicados entre procesos ni repeticiones en cada reinicio. Con un cron
// del servidor (scripts/tareas.js) se apaga el intervalo con
// IN_PROCESS_JOBS=false.
const jobRunner = createJobRunner({
  db,
  schema: getCountryDbBinding(countryConfig.code).schema,
  jobs: defaultJobs({ db, isFeatureEnabled }),
});

async function sincronizarUsuariosDeshabilitados() {
  try {
    const actualizados = await syncUnverifiedUsersToDisabled();
    if (actualizados > 0) {
      logger.info(
        "usuarios",
        `${actualizados} colaborador(es) deshabilitado(s) (sin correo o sin verificar)`,
      );
    }
  } catch (err) {
    logger.error("usuarios", err);
  }
}

/**
 * Cambios de esquema versionados (src/migrations, services/schema/migrator).
 * Un fallo se registra y la app sigue: igual que antes con los asegurar*.
 */
async function aplicarMigraciones() {
  try {
    const { applied } = await runMigrations({
      connect: () => db.pool.connect(),
      schema: getCountryDbBinding(countryConfig.code).schema,
      migrations,
      logger,
    });
    if (applied.length) logger.info("migraciones", `aplicadas: ${applied.join(", ")}`);
  } catch (err) {
    logger.error("migraciones", err);
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

async function asegurarSchemaLetras() {
  try {
    await ensureBillOfExchangeSchema();
  } catch (err) {
    logger.error("letras", err);
  }
}

async function asegurarSchemaLogistica() {
  try {
    await ensureLogisticsSchema();
  } catch (err) {
    logger.error("logistica", err);
  }
}

async function asegurarSchemaAreas() {
  try {
    await ensureWorkAreaSchema();
  } catch (err) {
    logger.error("areas", err);
  }
}

// Va después de asegurarSchemaAreas: las asignaciones apuntan a work_areas.
// Sin modo sombra, un país sin arranque dejaría a todos sin permisos: se
// aplica aquí si falta (ver services/permissions/autoBootstrap).
async function asegurarSchemaPermisos() {
  try {
    await ensurePermissionSchema();
  } catch (err) {
    logger.error("permisos", err);
    return;
  }
  try {
    await ensureBootstrapped({ db, country: countryConfig.code, catalog: getCatalog(), logger });
  } catch (err) {
    logger.error("permisos.arranque", err);
  }
  // Los conjuntos de permisos (también los del arranque) pasan a permisos de
  // a uno y conjuntos de personas. Una sola vez; después no hace nada.
  try {
    await convertSetsIfNeeded({ db, catalog: getCatalog(), logger });
  } catch (err) {
    logger.error("permisos.conversion", err);
  }
  // Permisos que salieron del catálogo: sus asignaciones se borran una vez.
  try {
    await removeRetiredAssignments({ db, logger });
  } catch (err) {
    logger.error("permisos", err);
  }
}

async function asegurarSchemaTickets() {
  try {
    await ensureTicketReplyCorrelatives();
    const migradas = await migrateTicketCategories();
    if (migradas > 0) logger.info("tickets", `${migradas} ticket(s) con la categoría actualizada`);
  } catch (err) {
    logger.error("tickets", err);
  }
}

async function runStartupDbTasks() {
  // Una conexión: el pooler de Supabase cobra cada login (TLS+SCRAM a
  // us-west-2) y el tope de la sesión es bajo. En paralelo, el primer
  // timeout tiraba el pool y reabría todo en el otro puerto.
  await db.warmPool();

  const steps = [
    aplicarMigraciones,
    sincronizarUsuariosDeshabilitados,
    asegurarSchemaVacaciones,
    async () => {
      await asegurarSchemaAreas();
      await asegurarSchemaPermisos();
    },
  ];
  if (isFeatureEnabled("supportTickets")) steps.push(asegurarSchemaTickets);
  if (isFeatureEnabled("billsOfExchange")) steps.push(asegurarSchemaLetras);
  if (isFeatureEnabled("logistics")) steps.push(asegurarSchemaLogistica);
  steps.push(async () => {
    await asegurarSchemaGastos();
    await asegurarSchemaCentrosCosto();
  });

  for (const step of steps) {
    await step();
  }
  startupGate.open();

  if (inProcessJobsEnabled()) jobRunner.startInterval();
}

function startBackgroundJobs() {
  startupGate.arm();
  runStartupDbTasks().catch((err) => {
    logger.error("db", err);
    // Sin base (warmPool falló) igual se atiende: cada página muestra su error.
    startupGate.open("el arranque de la base falló");
  });
  // Datos de la portada (indicadores, clima, LinkedIn, eventos).
  indexRoutes.startHomeBackgroundJobs();
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
