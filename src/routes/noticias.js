// Módulo de noticias — controladores.
//
// Este archivo solo valida la petición, delega en los servicios y renderiza.
// El SQL vive en noticiaRepository, el procesamiento de archivos en
// attachmentProcessor y el correo en noticiaEmailService.

const express = require("express");
const multer = require("multer");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");

const router = express.Router();

const requireRole = require("../middlewares/requireRole");
const { isAdministrador } = require("../constants/roles");
const { sanitizeArticleHtml } = require("../utils/sanitizeContent");

const repository = require("../services/noticias/noticiaRepository");
const attachmentModel = require("../services/noticias/attachmentModel");
const attachmentProcessor = require("../services/noticias/attachmentProcessor");
const documentCache = require("../services/noticias/documentCache");
const emailService = require("../services/noticias/noticiaEmailService");
const presenter = require("../services/noticias/noticiaPresenter");
const fileStorage = require("../services/fileStorage");

const ROLES_ESCRITURA = ["admin"];

// Súbela SIEMPRE que cambie noticias.css o los scripts del módulo: los
// estáticos se sirven con `maxAge: 1d`, así que sin bump el navegador se queda
// con la hoja anterior y la vista se ve rota.
const CSS_VERSION = "20260910w";

const ASSETS = {
  extraCss: [`/css/noticias.css?v=${CSS_VERSION}`],
  extraJs: [`/js/noticias-media.js?v=${CSS_VERSION}`],
};

// Cada vista añade solo el script que necesita.
const ASSETS_LISTADO = {
  ...ASSETS,
  extraJs: [...ASSETS.extraJs, `/js/noticias-lista.js?v=${CSS_VERSION}`],
};

const ASSETS_DETALLE = {
  ...ASSETS,
  extraJs: [...ASSETS.extraJs, `/js/noticias-articulo.js?v=${CSS_VERSION}`],
};

const RELACIONADAS_EN_DETALLE = 4;

const NEWS_UPLOAD_TEMP_DIR = path.join(os.tmpdir(), "transworld-intranet-news");
const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      fs.mkdir(NEWS_UPLOAD_TEMP_DIR, { recursive: true })
        .then(() => cb(null, NEWS_UPLOAD_TEMP_DIR), cb);
    },
    filename: (_req, _file, cb) => {
      cb(null, `${Date.now()}-${crypto.randomUUID()}.upload`);
    },
  }),
  limits: { fileSize: UPLOAD_LIMITS_BYTES.NEWS_ATTACHMENT },
});

const MAX_TITULO = 200;
const MAX_SUBTITULO = 300;

/**
 * Valida y normaliza el cuerpo del formulario de creación/edición.
 * @returns {{ok: true, data: object}|{ok: false, error: string}}
 */
function parseNoticiaBody(body) {
  const titulo = String(body.titulo || "").trim();
  const subtitulo = String(body.subtitulo || "").trim();
  const contenido = sanitizeArticleHtml(body.contenido || "");

  if (!titulo) return { ok: false, error: "El título es obligatorio." };
  if (titulo.length > MAX_TITULO) {
    return { ok: false, error: `El título no puede superar los ${MAX_TITULO} caracteres.` };
  }
  if (subtitulo.length > MAX_SUBTITULO) {
    return { ok: false, error: `La bajada no puede superar los ${MAX_SUBTITULO} caracteres.` };
  }
  if (!contenido.trim()) return { ok: false, error: "El contenido es obligatorio." };

  return {
    ok: true,
    data: {
      title: titulo,
      subtitle: subtitulo,
      content: contenido,
      image: String(body.imagen_portada || "").trim() || null,
      // normalize + serialize descartan cualquier campo inesperado del cliente.
      attachments: attachmentModel.serialize(attachmentModel.normalize(body.adjuntos_data)),
    },
  };
}

/**
 * Adjuntos listos para la vista: normalizados y, para los Word, con el HTML
 * ya resuelto para que la plantilla no tenga que hacer entrada/salida.
 */
async function loadAdjuntosParaVista(noticia) {
  const items = attachmentModel.normalize(noticia.attachments);

  await Promise.all(
    items
      .filter((item) => item.kind === attachmentModel.KIND.WORD && item.html_path)
      .map(async (item) => {
        item.html = await documentCache.getHtml(item.html_path);
      }),
  );

  return items;
}

/**
 * Nombres reales de los autores de un conjunto de noticias, listos para pasar
 * al presentador.
 * @param {object[]} noticias
 * @returns {Promise<Record<string, string>>}
 */
function loadNombresAutor(noticias) {
  return repository.findAuthorNames(noticias.map((n) => presenter.claveAutor(n.author)));
}

// ==========================================
// LISTADO
// ==========================================
router.get("/", async (req, res) => {
  try {
    const noticias = await repository.listAll();
    const nombresAutor = await loadNombresAutor(noticias);
    const items = presenter.toViewModelList(noticias, { nombresAutor });

    res.render("noticias/index", {
      titulo: "Noticias",
      noticias: items,
      destacada: items.find((noticia) => noticia.featured) || null,
      user: req.session.user,
      ok: req.query.ok || null,
      ...ASSETS_LISTADO,
    });
  } catch (err) {
    console.error("[Noticias] Error listando:", err);
    res.status(500).send("Error cargando noticias");
  }
});

// El formulario de creación es un modal dentro del listado.
router.get("/crear", requireRole(...ROLES_ESCRITURA), (req, res) => res.redirect("/noticias"));

router.get("/editar/:id", requireRole(...ROLES_ESCRITURA), (req, res) =>
  res.redirect(`/noticias/${req.params.id}?editar=1`),
);

// ==========================================
// SUBIDA DE ARCHIVOS
// ==========================================
// Devuelve el adjunto ya procesado (portada del PDF, HTML del Word,
// dimensiones de la imagen), listo para guardarse tal cual con la noticia.
router.post(
  "/upload",
  requireRole(...ROLES_ESCRITURA),
  upload.single("archivo"),
  async (req, res) => {
    if (!req.file) {
      return res.status(400).json({ error: "No se recibió ningún archivo." });
    }

    try {
      const adjunto = await attachmentProcessor.processUploadedFile(req.file);
      res.json({ ok: true, adjunto });
    } catch (err) {
      if (err instanceof attachmentProcessor.AttachmentError) {
        return res.status(err.statusCode).json({ error: err.message });
      }
      console.error("[Noticias] Error subiendo archivo:", err);
      res.status(500).json({ error: "No se pudo subir el archivo. Inténtalo nuevamente." });
    } finally {
      await fs.unlink(req.file.path).catch((cleanupError) => {
        console.warn(
          "[Noticias] No se pudo limpiar el temporal de subida:",
          cleanupError.message || cleanupError,
        );
      });
    }
  },
);

// ==========================================
// CREAR
// ==========================================
router.post("/crear", requireRole(...ROLES_ESCRITURA), async (req, res) => {
  const parsed = parseNoticiaBody(req.body);
  if (!parsed.ok) return res.status(400).send(parsed.error);

  try {
    const slug = await repository.generateUniqueSlug(parsed.data.title);
    const autor = req.session.user?.username || req.session.user?.email || "Anónimo";

    const id = await repository.create({ ...parsed.data, slug, author: autor });
    await repository.logChange(req.session.user?.id, "publicó una nueva noticia", `/noticias/${id}`);

    res.redirect(`/noticias/${id}?publicada=1`);
  } catch (err) {
    console.error("[Noticias] Error creando:", err);
    res.status(500).send("Error guardando la noticia");
  }
});

// ==========================================
// EDITAR
// ==========================================
router.post("/editar/:id", requireRole(...ROLES_ESCRITURA), async (req, res) => {
  const { id } = req.params;
  const parsed = parseNoticiaBody(req.body);
  if (!parsed.ok) return res.status(400).send(parsed.error);

  try {
    const actual = await repository.findById(id);
    if (!actual) return res.status(404).send("Noticia no encontrada");

    // El slug solo se regenera si cambió el título; así no se rompen los
    // enlaces ya compartidos de noticias cuyo título no se tocó.
    const slug =
      actual.title === parsed.data.title && actual.slug
        ? actual.slug
        : await repository.generateUniqueSlug(parsed.data.title, { excludeId: id });

    const removedAttachments = attachmentProcessor.findRemovedAttachments(
      actual.attachments,
      parsed.data.attachments,
    );
    const previousCover = actual.image || null;
    const nextCover = parsed.data.image || null;

    await repository.update(id, { ...parsed.data, slug });
    await repository.logChange(req.session.user?.id, "editó una noticia", `/noticias/${id}`);

    // Limpia del bucket los adjuntos/portada que ya no referencia la noticia.
    const cleanup = [];
    if (removedAttachments.length) {
      cleanup.push(attachmentProcessor.deleteAttachmentFiles(removedAttachments));
    }
    if (previousCover && previousCover !== nextCover) {
      cleanup.push(fileStorage.deleteFile(previousCover));
    }
    if (cleanup.length) {
      Promise.allSettled(cleanup).then((results) => {
        results.forEach((result) => {
          if (result.status === "rejected") {
            console.warn(
              "[Noticias] Limpieza de archivos incompleta:",
              result.reason?.message || result.reason,
            );
          }
        });
      });
    }

    res.redirect(`/noticias/${id}?ok=noticia_actualizada`);
  } catch (err) {
    console.error("[Noticias] Error editando:", err);
    res.status(500).send("Error actualizando la noticia");
  }
});

// ==========================================
// ELIMINAR
// ==========================================
router.post("/eliminar/:id", requireRole(...ROLES_ESCRITURA), async (req, res) => {
  const { id } = req.params;

  try {
    const noticia = await repository.findById(id);
    if (!noticia) return res.redirect("/noticias");

    await repository.remove(id);
    await repository.logChange(req.session.user?.id, "eliminó una noticia", "/noticias");

    // Elimina originales, portada y derivados del storage al borrar la noticia.
    // No se espera al resultado: el borrado de la noticia ya está confirmado.
    const cleanupTasks = [
      attachmentProcessor.deleteAttachmentFiles(noticia.attachments),
    ];
    if (noticia.image) cleanupTasks.push(fileStorage.deleteFile(noticia.image));

    Promise.allSettled(cleanupTasks).then((results) => {
      results.forEach((result) => {
        if (result.status === "rejected") {
          console.warn(
            "[Noticias] Limpieza de archivos incompleta:",
            result.reason?.message || result.reason,
          );
        }
      });
    });

    res.redirect("/noticias?ok=Noticia eliminada");
  } catch (err) {
    console.error("[Noticias] Error eliminando:", err);
    res.status(500).send("Error eliminando la noticia");
  }
});

// ==========================================
// DESTACAR
// ==========================================
router.post("/destacar/:id", requireRole(...ROLES_ESCRITURA), async (req, res) => {
  const { id } = req.params;
  const quitar = req.body.quitar === "1";

  try {
    const noticia = await repository.findById(id);
    if (!noticia) return res.status(404).send("Noticia no encontrada");

    await repository.setFeatured(id, !quitar);
    await repository.logChange(
      req.session.user?.id,
      quitar ? "quitó noticia destacada del inicio" : "marcó una noticia como destacada",
      `/noticias/${id}`,
    );

    res.redirect(`/noticias/${id}?ok=${quitar ? "destacada_quitada" : "destacada_marcada"}`);
  } catch (err) {
    console.error("[Noticias] Error al destacar:", err);
    res.redirect(`/noticias/${id}?error=destacada_fallida`);
  }
});

// ==========================================
// ENVIAR POR CORREO (acción manual del administrador)
// ==========================================
router.post("/enviar-correo/:id", requireRole(...ROLES_ESCRITURA), async (req, res) => {
  const { id } = req.params;
  const enviarTodos = ["1", "true", "on"].includes(String(req.body.enviar_todos));
  const userIds = req.body.usuarios;

  try {
    const noticia = await repository.findById(id);
    if (!noticia) return res.status(404).send("Noticia no encontrada");

    if (!enviarTodos && (!userIds || (Array.isArray(userIds) && userIds.length === 0))) {
      return res.redirect(`/noticias/${id}?error=sin_seleccion`);
    }

    const { enviados } = await emailService.enviarNoticia(noticia, { enviarTodos, userIds });
    if (enviados === 0) return res.redirect(`/noticias/${id}?error=sin_destinatarios`);

    await repository.logChange(
      req.session.user?.id,
      "envió aviso por correo de una noticia",
      `/noticias/${id}`,
    );

    res.redirect(`/noticias/${id}?ok=correo_enviado&destinatarios=${enviados}`);
  } catch (err) {
    console.error("[Noticias] Error enviando correo:", err);
    res.redirect(`/noticias/${id}?error=correo_fallido`);
  }
});

// ==========================================
// DETALLE (debe ir al final: captura cualquier ruta restante)
// ==========================================
router.get("/:id_or_slug", async (req, res) => {
  try {
    const noticia = await repository.findByIdOrSlug(req.params.id_or_slug);

    if (!noticia) {
      return res
        .status(404)
        .render("404", { titulo: "Noticia no encontrada", user: req.session.user });
    }

    const esAdmin = isAdministrador(req.session.user?.role);
    const adjuntos = await loadAdjuntosParaVista(noticia);
    const nombresAutor = await loadNombresAutor([noticia]);
    const vista = presenter.toViewModel(noticia, { adjuntos, nombresAutor });

    res.render("noticias/detalle", {
      titulo: noticia.title,
      noticia: vista,
      adjuntos,
      resumen: vista.resumen,
      relacionadas: presenter.toViewModelList(
        await repository.listRelated(noticia.id, RELACIONADAS_EN_DETALLE),
      ),
      user: req.session.user,
      usuariosCorreo: esAdmin ? await repository.listUsersWithEmail() : [],
      publicada: req.query.publicada === "1",
      editar: req.query.editar === "1",
      ok: req.query.ok || null,
      error: req.query.error || null,
      destinatarios: req.query.destinatarios || null,
      ...ASSETS_DETALLE,
    });
  } catch (err) {
    console.error("[Noticias] Error cargando detalle:", err);
    res.status(500).send("Error cargando la noticia");
  }
});

module.exports = router;
