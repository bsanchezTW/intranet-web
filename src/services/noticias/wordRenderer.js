// Conversión de documentos Word a HTML legible dentro de la noticia y del correo.
//
// .docx → mammoth produce HTML semántico (encabezados, listas, tablas) una sola
// vez, en la subida. Se descartó convertir a PDF porque exigiría LibreOffice o
// Word headless en el servidor, y convertir en cada visita porque repetiría el
// mismo trabajo en cada lectura y en cada envío de correo.
//
// .doc (formato binario antiguo) no lo soporta mammoth: se recurre a
// word-extractor, que devuelve texto plano. Se pierde el formato, pero el
// contenido sigue siendo legible sin descargar nada.

const mammoth = require("mammoth");
const WordExtractor = require("word-extractor");
const fileStorage = require("../fileStorage");
const signedMedia = require("../media/signedMedia");
const { sanitizeDocumentHtml, excerptFrom, htmlToText } = require("../../utils/sanitizeContent");

const STYLE_MAP = [
  "p[style-name='Title'] => h1.doc-title:fresh",
  "p[style-name='Subtitle'] => p.doc-subtitle:fresh",
  "p[style-name='Heading 1'] => h2:fresh",
  "p[style-name='Heading 2'] => h3:fresh",
  "p[style-name='Heading 3'] => h4:fresh",
  "p[style-name='Quote'] => blockquote:fresh",
  "p[style-name='Intense Quote'] => blockquote.doc-quote-intense:fresh",
];

const EXTENSION_BY_MIME = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
};

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Sube cada imagen incrustada en el .docx y devuelve su URL firmada, de modo
 * que también se vea en el correo (donde data: URI no es fiable y /content
 * devolvería 401).
 */
function buildImageConverter(folder, imageFileName) {
  let n = 0;
  return mammoth.images.imgElement(async (image) => {
    try {
      n += 1;
      const extension = EXTENSION_BY_MIME[image.contentType] || ".png";
      const buffer = Buffer.from(await image.read("base64"), "base64");
      const fileName = imageFileName
        ? imageFileName(n, extension)
        : `word-image-${n}${extension}`;
      const saved = await fileStorage.saveFileAs(buffer, folder, fileName, {
        contentType: image.contentType,
      });
      const publicUrl = signedMedia.publicUrl(saved.public_id);
      return { src: publicUrl || saved.secure_url, alt: image.altText || "" };
    } catch (err) {
      console.warn("[Noticias] No se pudo extraer una imagen del Word:", err.message || err);
      return { src: "" };
    }
  });
}

async function renderDocx(buffer, folder, imageFileName) {
  const result = await mammoth.convertToHtml(
    { buffer },
    { styleMap: STYLE_MAP, convertImage: buildImageConverter(folder, imageFileName) },
  );

  result.messages
    .filter((message) => message.type === "error")
    .forEach((message) => console.warn("[Noticias] mammoth:", message.message));

  return result.value || "";
}

async function renderLegacyDoc(buffer) {
  const doc = await new WordExtractor().extract(buffer);
  const body = (doc.getBody() || "").trim();
  if (!body) return "";

  return body
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, "<br>")}</p>`)
    .join("\n");
}

/**
 * Convierte el documento a HTML saneado.
 * @returns {Promise<{html: string, excerpt: string, text: string}>}
 */
async function render(
  buffer,
  { name, folder = "noticias_adjuntos/word_media", imageFileName } = {},
) {
  const isDocx = String(name || "").toLowerCase().endsWith(".docx");

  let rawHtml = "";
  try {
    rawHtml = isDocx
      ? await renderDocx(buffer, folder, imageFileName)
      : await renderLegacyDoc(buffer);
  } catch (err) {
    console.warn(`[Noticias] No se pudo convertir "${name}":`, err.message || err);
    // Último recurso para un .docx corrupto o protegido: al menos el texto.
    try {
      rawHtml = await renderLegacyDoc(buffer);
    } catch {
      rawHtml = "";
    }
  }

  const html = sanitizeDocumentHtml(rawHtml);
  const text = htmlToText(html);

  return { html, text, excerpt: excerptFrom(text, 400) };
}

module.exports = { render };
