const db = require("../../db");
const { formatPhoneForDisplay } = require("../../utils/phone");

/**
 * Búsquedas de solo lectura que usa el asistente como tools.
 *
 * No son endpoints: sólo las llama el servidor dentro de un turno del chat,
 * y lo que devuelven viaja a Anthropic. Por eso cada resultado se reduce a los
 * campos públicos del directorio — nunca RUT, fecha de nacimiento ni rol.
 */

const MAX_PEOPLE = 5;
const MAX_DOCUMENTS = 8;
const MAX_OTHER_DOCUMENTS = 4;
const MAX_TERMS = 4;

/** Palabras de la consulta (2+ caracteres). Cada una debe coincidir. */
function searchTerms(query) {
  return String(query || "")
    .trim()
    .split(/\s+/)
    .filter((term) => term.length >= 2)
    .slice(0, MAX_TERMS);
}

/** Patrón ILIKE literal: % y _ del usuario no son comodines. */
function likePattern(term) {
  return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** Campos del directorio que se pueden compartir con el modelo. */
function toPublicPerson(row) {
  return {
    nombre: [row.first_name, row.last_name].filter(Boolean).join(" ") || null,
    email: row.email || null,
    telefono: row.phone ? formatPhoneForDisplay(row.phone) || null : null,
    area: row.area_name || null,
  };
}

async function searchPeople(query) {
  const terms = searchTerms(query);
  if (!terms.length) return [];

  const conditions = terms.map(
    (_, i) =>
      `(concat_ws(' ', u.first_name, u.last_name) ILIKE $${i + 1}
        OR u.email ILIKE $${i + 1}
        OR at.area_name ILIKE $${i + 1})`,
  );
  const { rows } = await db.query(
    `SELECT u.first_name, u.last_name, u.email, u.phone, at.area_name
       FROM users u
       LEFT JOIN work_areas at ON at.id = u.work_area_id
      WHERE ${conditions.join(" AND ")}
        AND COALESCE(LOWER(u.role), '') NOT IN ('deshabilitado', 'disabled')
      ORDER BY u.last_name ASC NULLS LAST, u.first_name ASC
      LIMIT ${MAX_PEOPLE}`,
    terms.map(likePattern),
  );
  return rows.map(toPublicPerson);
}

/** Dónde vive el documento, en el lenguaje del menú de Procesos. */
function documentLabel(row) {
  if (row.type === "otros") return "Otros documentos";
  if (row.type === "reglamento") return "Reglamento interno";
  const kind =
    row.doc_kind === "protocolo"
      ? "Protocolos"
      : row.doc_kind === "procedimiento"
        ? "Procedimientos"
        : "Documentos";
  return row.area_name ? `${kind} · ${row.area_name}` : kind;
}

/** Busca por nombre de archivo, no por contenido: el texto de los PDF no está indexado. */
async function searchDocuments(query) {
  const terms = searchTerms(query);
  if (!terms.length) return [];

  const patterns = terms.map(likePattern);
  const byName = (column) => terms.map((_, i) => `${column} ILIKE $${i + 1}`).join(" AND ");

  const [documents, others] = await Promise.all([
    db.query(
      `SELECT d.name, d.url, d.type, d.doc_kind, w.area_name
         FROM documents d
         LEFT JOIN work_areas w ON w.id = d.work_area_id
        WHERE ${byName("d.name")}
        ORDER BY d.created_at DESC
        LIMIT ${MAX_DOCUMENTS}`,
      patterns,
    ),
    db.query(
      `SELECT name, url, 'otros' AS type
         FROM other_documents
        WHERE ${byName("name")}
        ORDER BY created_at DESC
        LIMIT ${MAX_OTHER_DOCUMENTS}`,
      patterns,
    ),
  ]);

  return [...documents.rows, ...others.rows].map((row) => ({
    nombre: row.name,
    url: row.url,
    ubicacion: documentLabel(row),
  }));
}

module.exports = {
  searchTerms,
  likePattern,
  toPublicPerson,
  documentLabel,
  searchPeople,
  searchDocuments,
};
