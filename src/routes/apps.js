/** Aplicaciones: catálogo, QR, orden, alta, edición, baja y aviso por correo. */
const express = require("express");
const QRCode = require("qrcode");
const db = require("../db");
const multer = require("multer");
const fileStorage = require("../services/fileStorage");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const {
  APP_CATALOGS,
  normalizeAppCatalog,
  appCatalogPath,
} = require("../constants/appCatalogs");
const { listAppsByCatalog, reorderAppsInCatalog } = require("../services/appCatalogService");
const requirePermission = require("../middlewares/requirePermission");
const { withQueryParam } = require("../utils/returnTo");
const { optionalLinkUrl } = require("../utils/safeUrl");
const { sendMail, resolveMailFrom } = require("../services/mailer");
const { MAIL_SENDERS } = require("../constants/mailSenders");
const { escapeHtml } = require("../services/emailLayout");

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_LIMITS_BYTES.COURSE_MATERIAL },
});

// ==========================================
// APLICACIONES
// ==========================================
function esUrlDescargaValida(url) {
  try {
    const parsed = new URL(String(url || "").trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Entrar a Apps.
router.use("/apps", requirePermission("apps.acceso"));

router.get("/apps/qr", requirePermission("apps.app.ver"), async (req, res) => {
  const targetUrl = String(req.query.url || "").trim();

  if (!esUrlDescargaValida(targetUrl)) {
    return res.status(400).send("URL de descarga inválida.");
  }

  try {
    const pngBuffer = await QRCode.toBuffer(targetUrl, {
      type: "png",
      width: 400,
      margin: 2,
      errorCorrectionLevel: "M",
    });

    res.set("Content-Type", "image/png");
    res.set("Cache-Control", "private, max-age=3600");
    res.send(pngBuffer);
  } catch (err) {
    console.error("Error al generar QR de app:", err);
    res.status(500).send("No se pudo generar el código QR.");
  }
});

router.get("/apps", requirePermission("apps.app.ver"), async (req, res) => {
    try {
      res.render("ver-apps", {
        titulo: "Aplicaciones | Transworld",
        apps: await listAppsByCatalog(APP_CATALOGS.CORPORATE),
        appCatalog: APP_CATALOGS.CORPORATE,
        user: req.session.user,
        ok: req.query.ok,
      });
    } catch (err) {
      console.error("Error al cargar aplicaciones:", err);
      res.status(500).send("Error interno del servidor.");
    }
  },
);

/** Guarda el orden manual de las tarjetas de un catálogo. */
router.post("/apps/orden", requirePermission("apps.app.ordenar"), async (req, res) => {
  const catalog = normalizeAppCatalog(req.body.catalog);
  const ids = Array.isArray(req.body.ids) ? req.body.ids : [];

  if (ids.length === 0) {
    return res.status(400).json({ ok: false, error: "No se recibió el orden." });
  }

  try {
    const actualizadas = await reorderAppsInCatalog(catalog, ids);
    res.json({ ok: true, actualizadas });
  } catch (err) {
    console.error("Error al guardar el orden de aplicaciones:", err);
    res.status(500).json({ ok: false, error: "No se pudo guardar el orden." });
  }
});

const uploadAppFile = async (buffer, folder, fileName) => {
  return fileStorage.saveFileInAllCountryBuckets(buffer, folder, fileName);
};

function esArchivoPdf(file) {
  if (!file) return false;
  const name = String(file.originalname || "").toLowerCase();
  const mime = String(file.mimetype || "").toLowerCase();
  return mime === "application/pdf" || name.endsWith(".pdf");
}

async function subirInstructivoIos(file) {
  if (!esArchivoPdf(file)) {
    const err = new Error("El instructivo de iOS/iPad debe ser un archivo PDF.");
    err.statusCode = 400;
    throw err;
  }
  if (!fileStorage.validateFileSize(file.buffer, 20)) {
    const err = new Error("El instructivo PDF supera el tamaño máximo de 20 MB.");
    err.statusCode = 400;
    throw err;
  }
  return uploadAppFile(
    file.buffer,
    "apps_instructivos",
    file.originalname || "instructivo-ios.pdf",
  );
}

/**
 * Enlaces de descarga de una app: http(s) o ruta interna. Van en un href
 * para toda la intranet; `javascript:` o `data:` se rechazan (400).
 */
function appLinks(body = {}) {
  return {
    url_pc: optionalLinkUrl(body.url_pc, "El enlace de Windows"),
    url_apk: optionalLinkUrl(body.url_apk, "El enlace de Android"),
    url_web: optionalLinkUrl(body.url_web, "El enlace web"),
  };
}

const appUploads = upload.fields([
  { name: "icon", maxCount: 1 },
  { name: "instructivo_ios", maxCount: 1 },
]);

router.post(
  "/apps/nueva",
  requirePermission("apps.app.crear"),
  appUploads,
  async (req, res) => {
    // Form fields match DB columns (name/description); accept Spanish aliases as fallback
    const name = req.body.name ?? req.body.nombre;
    const description = req.body.description ?? req.body.descripcion;
    const catalog = normalizeAppCatalog(req.body.catalog);
    let icon_url = null;
    let url_ios = null;

    try {
      const { url_pc, url_apk, url_web } = appLinks(req.body);
      if (req.files && req.files["icon"]) {
        const result = await uploadAppFile(
          req.files["icon"][0].buffer,
          "apps_icons",
          req.files["icon"][0].originalname || "icono-app.jpg",
        );
        icon_url = result.secure_url;
      }

      if (req.files && req.files["instructivo_ios"]) {
        const result = await subirInstructivoIos(req.files["instructivo_ios"][0]);
        url_ios = result.secure_url;
      }

      await db.queryRetryIdCollision(
        `INSERT INTO applications (name, description, url_pc, url_apk, url_ios, url_web, icon_url, catalog, notified)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, false)`,
        [
          name,
          description,
          url_pc,
          url_apk,
          url_ios,
          url_web,
          icon_url,
          catalog,
        ],
      );

      res.redirect(withQueryParam(appCatalogPath(catalog), "ok", "Aplicación registrada"));
    } catch (err) {
      console.error("Error al guardar aplicación:", err);
      const mensaje = err.statusCode === 400 ? err.message : "No se pudo registrar la aplicación";
      res.redirect(withQueryParam(appCatalogPath(catalog), "error", mensaje));
    }
  },
);

router.post(
  "/apps/editar/:id",
  requirePermission("apps.app.editar"),
  appUploads,
  async (req, res) => {
    const { id } = req.params;
    // Form fields match DB columns (name/description); accept Spanish aliases as fallback
    const name = req.body.name ?? req.body.nombre;
    const description = req.body.description ?? req.body.descripcion;

    try {
      const { url_pc, url_apk, url_web } = appLinks(req.body);
      const { rows: existingRows } = await db.query(
        "SELECT icon_url, url_ios, catalog FROM applications WHERE id = $1",
        [id],
      );
      const existing = existingRows[0] || {};
      // El catálogo no se edita desde el formulario: la app vuelve a la vista
      // desde la que se abrió el modal.
      const catalog = normalizeAppCatalog(existing.catalog);

      let updateQuery = `UPDATE applications SET name = $1, description = $2, url_pc = $3, url_apk = $4, url_web = $5, updated_at = NOW(), notified = false`;
      let queryParams = [
        name,
        description,
        url_pc,
        url_apk,
        url_web,
      ];
      let paramIndex = 6;
      const obsoleteFiles = [];

      if (req.files && req.files["instructivo_ios"]) {
        const result = await subirInstructivoIos(req.files["instructivo_ios"][0]);
        updateQuery += `, url_ios = $${paramIndex}`;
        queryParams.push(result.secure_url);
        paramIndex++;
        if (existing.url_ios) obsoleteFiles.push(existing.url_ios);
      }

      if (req.files && req.files["icon"]) {
        const result = await uploadAppFile(
          req.files["icon"][0].buffer,
          "apps_icons",
          req.files["icon"][0].originalname || "icono-app.jpg",
        );
        updateQuery += `, icon_url = $${paramIndex}`;
        queryParams.push(result.secure_url);
        paramIndex++;
        if (existing.icon_url) obsoleteFiles.push(existing.icon_url);
      }

      updateQuery += ` WHERE id = $${paramIndex}`;
      queryParams.push(id);

      await db.query(updateQuery, queryParams);

      if (obsoleteFiles.length) {
        fileStorage.deleteFilesInAllCountryBuckets(obsoleteFiles).catch((err) => {
          console.warn("[Apps] Limpieza de archivos antiguos incompleta:", err.message || err);
        });
      }

      res.redirect(withQueryParam(appCatalogPath(catalog), "ok", "Aplicación actualizada"));
    } catch (err) {
      console.error("Error al editar aplicación:", err);
      const mensaje = err.statusCode === 400 ? err.message : "No se pudo actualizar la aplicación";
      res.redirect(withQueryParam(appCatalogPath(req.body.catalog), "error", mensaje));
    }
  },
);

router.post(
  "/apps/eliminar/:id",
  requirePermission("apps.app.eliminar"),
  async (req, res) => {
    const { id } = req.params;
    try {
      const { rows } = await db.query(
        "SELECT icon_url, url_ios, catalog FROM applications WHERE id = $1",
        [id],
      );
      const app = rows[0];
      const catalog = normalizeAppCatalog(app && app.catalog);

      await db.query("DELETE FROM applications WHERE id = $1", [id]);

      if (app) {
        fileStorage
          .deleteFilesInAllCountryBuckets([app.icon_url, app.url_ios])
          .catch((err) => {
            console.warn("[Apps] Limpieza de archivos incompleta:", err.message || err);
          });
      }

      res.redirect(withQueryParam(appCatalogPath(catalog), "ok", "Aplicación eliminada"));
    } catch (err) {
      console.error("Error al eliminar aplicación:", err);
      res.redirect(withQueryParam(appCatalogPath(req.body.catalog), "error", "No se pudo eliminar la aplicación"));
    }
  },
);

// ==========================================
// NOTIFICACIÓN DE APP
// ==========================================
router.post("/apps/notificar/:id", requirePermission("apps.app.notificar"), async (req, res) => {
  const { id } = req.params;
  const { cambios_texto } = req.body;

  try {
    const { rows: appRows } = await db.query(
      "UPDATE applications SET changelog = $1, notified = true WHERE id = $2 RETURNING name AS nombre, catalog",
      [cambios_texto, id],
    );

    if (appRows.length === 0) return res.status(404).send("App no encontrada");
    const nombreApp = appRows[0].nombre;
    const catalog = normalizeAppCatalog(appRows[0].catalog);
    const esSoporte = catalog === APP_CATALOGS.SUPPORT;
    const rutaCatalogo = appCatalogPath(catalog);

    const { rows: usuarios } = await db.query(
      `SELECT email FROM users
       WHERE active AND email IS NOT NULL AND TRIM(email) <> ''`,
    );
    const listaCorreos = usuarios.map((u) => u.email);

    if (listaCorreos.length > 0) {
      const htmlCorreo = `
        <p style="margin:0 0 8px 0; color:#0b3a63; font-size:18px; font-weight:700;">${escapeHtml(nombreApp)}</p>
        <p style="margin:0 0 16px 0; color:#51637a;">Se han realizado cambios importantes en esta herramienta:</p>
        <div style="background-color:#f5f7fa; padding:16px; border-left:4px solid #0f4c81; color:#334155; font-size:15px; line-height:1.6; border-radius:0 8px 8px 0;">
          ${escapeHtml(cambios_texto).replace(/\r?\n/g, "<br>")}
        </div>
      `;

      await sendMail({
        to: resolveMailFrom(),
        bcc: listaCorreos,
        subject: esSoporte
          ? `Actualización de ${nombreApp}`
          : `Actualización de ${nombreApp}`,
        heading: esSoporte
          ? "Actualización de herramienta de soporte"
          : "Actualización de aplicación",
        cta: {
          href: rutaCatalogo,
          label: esSoporte ? "Ir a Autoayuda" : "Ir a Descargas",
        },
        html: htmlCorreo,
        senderName: esSoporte ? MAIL_SENDERS.support : MAIL_SENDERS.intranet,
      });
    }

    res.redirect(withQueryParam(rutaCatalogo, "ok", "Notificación enviada"));
  } catch (err) {
    console.error("Error al notificar app:", err);
    res.redirect(withQueryParam(appCatalogPath(req.body.catalog), "error", "No se pudo enviar la notificación"));
  }
});

module.exports = router;
