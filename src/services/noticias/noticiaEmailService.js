// Construcción y envío del correo de una noticia.
//
// Regla del módulo: el destinatario ve el contenido AL ABRIR el correo, sin
// descargar nada. Las imágenes (y las páginas rasterizadas del PDF) viajan
// embebidas como data-URI para que el mensaje no dependa de cookies, bloqueos
// de contenido remoto ni disponibilidad posterior del proxy /media. El Word va
// convertido a HTML dentro del propio mensaje.

const path = require("path");
const ejs = require("ejs");

const { sendMail, resolveMailFrom } = require("../mailer");
const { MAIL_SENDERS } = require("../../constants/mailSenders");
const { renderEmailLayout } = require("../emailLayout");
const storage = require("../storage/storageService");
const fileStorage = require("../fileStorage");
const signedMedia = require("../media/signedMedia");
const attachmentModel = require("./attachmentModel");
const documentCache = require("./documentCache");
const emailStyles = require("./emailStyles");
const pdfRenderer = require("./pdfRenderer");
const repository = require("./noticiaRepository");
const { getLocale } = require("../../config/country");
const { sanitizeArticleHtml, htmlToText, excerptFrom } = require("../../utils/sanitizeContent");

// Sólo el cuerpo (texto + adjuntos); el marco es el común de todos los correos.
const TEMPLATE_PATH = path.join(__dirname, "..", "..", "views", "emails", "noticia.ejs");
// Banner bajo para el correo (10:3). 16:9 a 600px serían 338px de alto; esto baja a 180.
const COVER_EMAIL_WIDTH = 600;
const COVER_EMAIL_HEIGHT = 180;

const MAX_WORD_HTML_CHARS = 12000;
const MAX_EMAIL_PDF_PAGES = 20;
const PREVIEW_FOLDER = "noticias_adjuntos/previews";
// Tope práctico: Gmail recorta mensajes muy grandes; una imagen ~1.5 MB en base64.
const MAX_EMBED_BYTES = 1.5 * 1024 * 1024;

function baseUrl() {
  // Sin fallback a un dominio fijo: un correo de Perú nunca debe enlazar a
  // intranet.transworld.cl. APP_BASE_URL es obligatoria y la valida config/env.
  return process.env.APP_BASE_URL.replace(/\/+$/, "");
}

function formatFecha(date) {
  const value = date ? new Date(date) : new Date();
  return value
    .toLocaleDateString(getLocale(), {
      day: "numeric",
      month: "long",
      year: "numeric",
    })
    .replace(/^\w/, (char) => char.toUpperCase());
}

function toDataUri(buffer, contentType = "image/jpeg") {
  if (!buffer || !buffer.length) return null;
  if (buffer.length > MAX_EMBED_BYTES) {
    console.warn(
      `[Noticias] Imagen demasiado grande para embebir en correo (${buffer.length} bytes).`,
    );
    return null;
  }
  const mime = contentType && contentType.startsWith("image/") ? contentType : "image/jpeg";
  return `data:${mime};base64,${Buffer.from(buffer).toString("base64")}`;
}

function mimeFromPath(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".png") return "image/png";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  return "image/jpeg";
}

async function loadAsDataUri(relativePath) {
  if (!relativePath) return null;
  try {
    const { buffer, contentType } = await storage.downloadFile(relativePath);
    return toDataUri(buffer, contentType || mimeFromPath(relativePath));
  } catch (err) {
    console.warn(
      `[Noticias] No se pudo embebir "${relativePath}" en el correo:`,
      err.message || err,
    );
    return null;
  }
}

/**
 * Recorta al centro y reescala a 600×180. El archivo ya sale en la proporción
 * del correo: no hay que estirar con height en el HTML (Outlook lo distorsiona).
 */
async function cropCoverForEmail(buffer) {
  const { loadImage, createCanvas } = require("@napi-rs/canvas");
  const image = await loadImage(buffer);
  const srcW = image.width;
  const srcH = image.height;
  if (!srcW || !srcH) {
    throw new Error("portada sin dimensiones");
  }

  const targetW = COVER_EMAIL_WIDTH;
  const targetH = COVER_EMAIL_HEIGHT;
  const targetAspect = targetW / targetH;
  let sx = 0;
  let sy = 0;
  let sw = srcW;
  let sh = srcH;
  const srcAspect = srcW / srcH;
  if (srcAspect > targetAspect) {
    sw = Math.round(srcH * targetAspect);
    sx = Math.round((srcW - sw) / 2);
  } else if (srcAspect < targetAspect) {
    sh = Math.round(srcW / targetAspect);
    sy = Math.round((srcH - sh) / 2);
  }

  const canvas = createCanvas(targetW, targetH);
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(image, sx, sy, sw, sh, 0, 0, targetW, targetH);
  // Calidad 0–100. 0.85 se interpretaba como ~1 y dejaba el JPEG cuadriculado.
  return canvas.toBuffer("image/jpeg", 85);
}

async function loadCoverAsDataUri(relativePath) {
  if (!relativePath) return null;
  try {
    const { buffer } = await storage.downloadFile(relativePath);
    if (!buffer || !buffer.length) return null;
    const cropped = await cropCoverForEmail(buffer);
    return toDataUri(cropped, "image/jpeg");
  } catch (err) {
    console.warn(
      `[Noticias] No se pudo embebir la portada "${relativePath}" en el correo:`,
      err.message || err,
    );
    return null;
  }
}

/**
 * Usa previews persistidos o rasteriza localmente el PDF y deja las páginas listas
 * como data-URI para el correo.
 */
async function buildPdfEmailPages(item) {
  const pages = [];

  // 1) Páginas ya guardadas en Storage (descartar basura < 8 KB).
  if (Array.isArray(item.preview_pages) && item.preview_pages.length) {
    for (const page of item.preview_pages.slice(0, MAX_EMAIL_PDF_PAGES)) {
      try {
        const { buffer, contentType } = await storage.downloadFile(page.path);
        if (!buffer || buffer.length < 8 * 1024) continue;
        const dataUri = toDataUri(buffer, contentType || mimeFromPath(page.path));
        if (dataUri) {
          pages.push({
            url: dataUri,
            width: page.width || null,
            height: page.height || null,
            page: page.page || pages.length + 1,
          });
        }
      } catch (err) {
        console.warn(
          `[Noticias] No se pudo leer preview "${page.path}":`,
          err.message || err,
        );
      }
    }
    if (pages.length) return { pages, expanded: null };
  }

  if (item.preview_path) {
    const dataUri = await loadAsDataUri(item.preview_path);
    if (dataUri) {
      pages.push({
        url: dataUri,
        width: item.preview_width || null,
        height: item.preview_height || null,
        page: 1,
      });
      if (item.pages && item.pages <= 1) return { pages, expanded: null };
    }
  }

  if (!item.public_id) return { pages, expanded: null };

  // Rasterizado local (proceso hijo por página).
  try {
    const { buffer } = await storage.downloadFile(item.public_id);
    const { pages: numPages, excerpt, previews } = await pdfRenderer.analyze(buffer);

    if (previews.length) {
      const baseName = String(item.public_id).split("/").pop().replace(/\.[^.]+$/, "") || "pdf";
      const savedPages = [];

      for (let i = 0; i < previews.length; i += 1) {
        const pagePreview = previews[i];
        const ext = pagePreview.mime === "image/jpeg" ? "jpg" : "png";
        try {
          const saved = await fileStorage.saveFile(
            pagePreview.buffer,
            PREVIEW_FOLDER,
            `${baseName}-p${i + 1}.${ext}`,
            { contentType: pagePreview.mime || "image/png" },
          );
          savedPages.push({
            path: saved.public_id,
            width: pagePreview.width,
            height: pagePreview.height,
            page: i + 1,
          });
        } catch (err) {
          console.warn(`[Noticias] No se pudo guardar página ${i + 1}:`, err.message || err);
        }

        const dataUri = toDataUri(pagePreview.buffer, pagePreview.mime || "image/png");
        if (dataUri) {
          pages.push({
            url: dataUri,
            width: pagePreview.width,
            height: pagePreview.height,
            page: i + 1,
          });
        }
      }

      if (savedPages.length) {
        return {
          pages,
          expanded: {
            pages: numPages || item.pages || savedPages.length,
            excerpt: excerpt || item.excerpt,
            preview_pages: savedPages,
            preview_path: savedPages[0].path,
            preview_width: savedPages[0].width,
            preview_height: savedPages[0].height,
          },
        };
      }
    }
  } catch (err) {
    console.warn(
      `[Noticias] Rasterizado local de "${item.name}" falló:`,
      err.message || err,
    );
  }

  return { pages, expanded: null };
}

/**
 * Prepara un adjunto para el correo con imágenes embebidas (data-URI).
 */
async function prepareForEmail(item, noticiaUrl) {
  let emailPages = [];
  let expanded = null;

  if (item.kind === attachmentModel.KIND.IMAGE) {
    const dataUri = await loadAsDataUri(item.public_id || item.preview_path);
    if (dataUri) {
      emailPages = [
        {
          url: dataUri,
          width: item.width || item.preview_width,
          height: item.height || item.preview_height,
          page: 1,
        },
      ];
    } else {
      console.warn(`[Noticias] Imagen "${item.name}" sin datos para embebir.`);
    }
  } else if (item.kind === attachmentModel.KIND.PDF) {
    const result = await buildPdfEmailPages(item);
    emailPages = result.pages;
    expanded = result.expanded;
    if (expanded) {
      Object.assign(item, expanded);
      const refreshed = attachmentModel.normalizeOne(item);
      if (refreshed) Object.assign(item, refreshed);
    }
    if (!emailPages.length) {
      console.warn(`[Noticias] PDF "${item.name}" sin páginas visibles para el correo.`);
    }
  }

  const prepared = {
    ...item,
    emailPages,
    emailUrl: emailPages[0]?.url || null,
    viewUrl: noticiaUrl,
    emailPagesTruncated:
      item.kind === attachmentModel.KIND.PDF &&
      item.pages &&
      emailPages.length > 0 &&
      emailPages.length < item.pages,
    attachmentsExpanded: Boolean(expanded),
  };

  if (item.kind === attachmentModel.KIND.WORD && item.html_path) {
    const html = await documentCache.getHtml(item.html_path);
    if (html) {
      const { html: truncated, truncated: wasTruncated } = emailStyles.truncateHtml(
        html,
        MAX_WORD_HTML_CHARS,
      );
      prepared.emailHtml = emailStyles.inlineStyles(truncated);
      prepared.emailHtmlTruncated = wasTruncated;
    }
  }

  return prepared;
}

/**
 * Genera el HTML del correo de una noticia.
 */
async function buildEmailHtml(noticia) {
  const noticiaUrl = `${baseUrl()}/noticias/${noticia.id}`;
  const items = attachmentModel.normalize(noticia.attachments);

  const adjuntos = [];
  let attachmentsExpanded = false;
  for (const item of items) {
    const prepared = await prepareForEmail(item, noticiaUrl);
    if (prepared.attachmentsExpanded) attachmentsExpanded = true;
    adjuntos.push(prepared);
  }

  if (attachmentsExpanded && noticia.id) {
    try {
      await repository.updateAttachments(noticia.id, attachmentModel.serialize(items));
    } catch (err) {
      console.warn(
        "[Noticias] No se pudieron guardar las páginas del PDF tras el correo:",
        err.message || err,
      );
    }
  }

  const contenidoLimpio = sanitizeArticleHtml(noticia.content);

  // Portada embebida y recortada a 600×180 para no depender de la carga remota.
  let coverUrl = null;
  if (noticia.image) {
    const coverPath = signedMedia.toRelativePath(noticia.image) || noticia.image;
    coverUrl = await loadCoverAsDataUri(coverPath);
  }

  const bodyHtml = await ejs.renderFile(TEMPLATE_PATH, {
    noticiaUrl,
    adjuntos,
    contenidoHtml: emailStyles.inlineStyles(contenidoLimpio),
  });

  return renderEmailLayout({
    area: MAIL_SENDERS.news,
    heading: noticia.title,
    eyebrow: formatFecha(noticia.created_at),
    subheading: noticia.subtitle || "",
    cover: coverUrl ? { src: coverUrl, alt: noticia.title, href: noticiaUrl } : null,
    bodyHtml,
    cta: { href: noticiaUrl, label: "Leer en la Intranet →" },
    preheader:
      noticia.subtitle || excerptFrom(contenidoLimpio, 140) || "Nueva publicación en la Intranet",
  });
}

function buildEmailText(noticia) {
  const noticiaUrl = `${baseUrl()}/noticias/${noticia.id}`;
  const partes = [noticia.title];

  if (noticia.subtitle) partes.push(noticia.subtitle);
  partes.push("", htmlToText(sanitizeArticleHtml(noticia.content)));

  const items = attachmentModel.normalize(noticia.attachments);
  if (items.length) {
    partes.push("", "Contenido incluido:");
    items.forEach((item) => partes.push(`- ${item.name} (${item.label})`));
  }

  partes.push("", `Leer en la Intranet: ${noticiaUrl}`);
  return partes.join("\n");
}

function parseUserIds(userIds) {
  return (Array.isArray(userIds) ? userIds : [userIds])
    .map((id) => parseInt(id, 10))
    .filter((id) => Number.isInteger(id) && id > 0);
}

async function resolveRecipients({ enviarTodos, userIds }) {
  if (enviarTodos) return repository.emailsForAll();
  return repository.emailsForIds(parseUserIds(userIds));
}

/**
 * Envía la noticia. Un único mensaje con los destinatarios en copia oculta.
 * @returns {Promise<{enviados: number}>}
 */
async function enviarNoticia(noticia, opciones = {}) {
  const destinatarios = await resolveRecipients(opciones);
  if (destinatarios.length === 0) return { enviados: 0 };

  const html = await buildEmailHtml(noticia);

  await sendMail({
    to: resolveMailFrom(),
    bcc: destinatarios,
    subject: `Noticias: ${noticia.title}`,
    html,
    text: buildEmailText(noticia),
    senderName: MAIL_SENDERS.news,
    skipFooter: true,
    skipLayout: true,
  });
  return { enviados: destinatarios.length };
}

module.exports = { enviarNoticia };
