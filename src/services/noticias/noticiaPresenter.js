// Presentador de noticias — traduce una fila de `news_articles` al modelo que
// consumen las vistas (listado, detalle y aside de relacionadas).
//
// Existe para que ninguna plantilla tenga que formatear fechas, deducir el
// nombre del autor ni contar adjuntos: esa lógica vivía duplicada en
// noticias/index.ejs y noticias/detalle.ejs.

const attachmentModel = require("./attachmentModel");
const { toTitleCase } = require("../../utils/formatName");
const { monogramInitials } = require("../../utils/monogram");
const { minutosDeLectura, etiquetaDeLectura } = require("../../utils/readingTime");

const { getLocale } = require("../../config/country");

const LOCALE = getLocale();

const FORMATO_LARGO = { day: "numeric", month: "long", year: "numeric" };
const FORMATO_CORTO = { day: "2-digit", month: "short", year: "numeric" };

/**
 * Clave con la que se identifica a un autor: la parte local del correo en
 * minúsculas. `news_articles.author` guarda unas veces el correo completo
 * ("babarca@transworld.cl") y otras solo el usuario ("babarca"); ambas formas
 * producen la misma clave.
 * @param {string} author
 * @returns {string}
 */
function claveAutor(author) {
  return String(author || "").trim().toLowerCase().split("@")[0];
}

/**
 * Nombre para mostrar. Si el autor existe en `users` se usa su nombre real; si
 * no (usuarios dados de baja, noticias heredadas), se deduce del propio texto.
 * @param {string} author
 * @param {Record<string, string>} [nombres] Nombres reales por clave de autor.
 * @returns {string}
 */
function nombreAutor(author, nombres = {}) {
  const real = nombres[claveAutor(author)];
  if (real) return real;

  const deducido = String(author || "").split("@")[0].replace(/[._-]+/g, " ").trim();
  return toTitleCase(deducido) || "Intranet";
}

/**
 * Iniciales para el avatar (máximo dos letras).
 * @param {string} nombre
 * @returns {string}
 */
function iniciales(nombre) {
  const letras = monogramInitials({ nombre });
  return letras === "?" ? "T" : letras;
}

/**
 * @param {string|Date} fecha
 * @param {Intl.DateTimeFormatOptions} opciones
 * @returns {string}
 */
function formatearFecha(fecha, opciones) {
  const valor = fecha instanceof Date ? fecha : new Date(fecha);
  if (Number.isNaN(valor.getTime())) return "";
  return valor.toLocaleDateString(LOCALE, opciones);
}

function fechaISO(fecha) {
  const valor = fecha instanceof Date ? fecha : new Date(fecha);
  return Number.isNaN(valor.getTime()) ? "" : valor.toISOString();
}

/**
 * Modelo de vista de una noticia. Añade campos derivados sin tocar los
 * originales, de modo que quien necesite el dato crudo lo sigue teniendo.
 *
 * @param {object} noticia Fila de news_articles.
 * @param {{adjuntos?: object[], nombresAutor?: Record<string, string>}} [opciones]
 *   `adjuntos` ya normalizados (evita normalizar dos veces cuando el detalle ya
 *   resolvió el HTML de los Word) y los nombres reales de autor resueltos
 *   contra `users`.
 * @returns {object}
 */
function toViewModel(noticia, { adjuntos, nombresAutor } = {}) {
  const items = adjuntos || attachmentModel.normalize(noticia.attachments);
  const resumen = attachmentModel.summarize(items);
  const autor = nombreAutor(noticia.author, nombresAutor);

  return {
    ...noticia,
    adjuntos: items,
    resumen,
    autor,
    autorIniciales: iniciales(autor),
    minutosLectura: minutosDeLectura(noticia.content),
    lecturaLabel: etiquetaDeLectura(noticia.content),
    fechaLarga: formatearFecha(noticia.created_at, FORMATO_LARGO),
    fechaCorta: formatearFecha(noticia.created_at, FORMATO_CORTO),
    fechaISO: fechaISO(noticia.created_at),
    // Claves de filtrado del listado: tipos de adjunto presentes en la noticia.
    tiposAdjunto: Object.keys(resumen.counts),
    // Texto plano indexable por el buscador del listado.
    textoBusqueda: [noticia.title, noticia.subtitle, autor].filter(Boolean).join(" ").toLowerCase(),
  };
}

/**
 * @param {object[]} noticias
 * @param {{nombresAutor?: Record<string, string>}} [opciones]
 * @returns {object[]}
 */
function toViewModelList(noticias, { nombresAutor } = {}) {
  return (noticias || []).map((noticia) => toViewModel(noticia, { nombresAutor }));
}

module.exports = {
  LOCALE,
  claveAutor,
  nombreAutor,
  iniciales,
  formatearFecha,
  toViewModel,
  toViewModelList,
};
