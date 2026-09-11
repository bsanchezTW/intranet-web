// Acceso a datos del módulo de noticias. Todo el SQL de news_articles vive aquí;
// los controladores no escriben consultas.

const db = require("../../db");
const { NOTICIA_VIEW_COLUMNS } = require("../../utils/schemaMappers");

const COLUMNS = NOTICIA_VIEW_COLUMNS;

/**
 * Slug legible: conserva las tildes como su letra base (antes "Año Nuevo"
 * producía "ao-nuevo") y garantiza unicidad consultando la tabla en vez de
 * confiar en 4 dígitos de timestamp.
 */
async function generateUniqueSlug(title, { excludeId = null } = {}) {
  const base =
    String(title || "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "noticia";

  for (let attempt = 0; attempt < 50; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const { rows } = await db.query(
      excludeId
        ? "SELECT 1 FROM news_articles WHERE slug = $1 AND id <> $2 LIMIT 1"
        : "SELECT 1 FROM news_articles WHERE slug = $1 LIMIT 1",
      excludeId ? [candidate, excludeId] : [candidate],
    );
    if (rows.length === 0) return candidate;
  }

  return `${base}-${Date.now().toString(36)}`;
}

async function listAll() {
  const { rows } = await db.query(
    `SELECT ${COLUMNS} FROM news_articles ORDER BY featured DESC, created_at DESC`,
  );
  return rows;
}

/**
 * Noticias recientes distintas de la actual, para el aside del detalle.
 * No trae `content` ni `attachments`: solo lo que se pinta en la tarjeta.
 */
async function listRelated(excludeId, limit = 4) {
  const { rows } = await db.query(
    `SELECT id, title, slug, image, created_at
     FROM news_articles
     WHERE id <> $1
     ORDER BY created_at DESC
     LIMIT $2`,
    [excludeId, limit],
  );
  return rows;
}

async function findById(id) {
  const { rows } = await db.query(`SELECT ${COLUMNS} FROM news_articles WHERE id = $1`, [id]);
  return rows[0] || null;
}

async function findByIdOrSlug(param) {
  const isNumeric = /^\d+$/.test(String(param));
  const { rows } = await db.query(
    isNumeric
      ? `SELECT ${COLUMNS} FROM news_articles WHERE id = $1`
      : `SELECT ${COLUMNS} FROM news_articles WHERE slug = $1`,
    [isNumeric ? parseInt(param, 10) : param],
  );
  return rows[0] || null;
}

async function create({ title, subtitle, slug, content, image, attachments, author }) {
  const { rows } = await db.queryRetryIdCollision(
    `INSERT INTO news_articles (title, subtitle, slug, content, image, attachments, author, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
     RETURNING id`,
    [title, subtitle || "", slug, content, image || null, attachments || "[]", author],
  );
  return rows[0].id;
}

async function update(id, { title, subtitle, slug, content, image, attachments }) {
  await db.query(
    `UPDATE news_articles
     SET title = $1, subtitle = $2, slug = $3, content = $4, image = $5, attachments = $6
     WHERE id = $7`,
    [title, subtitle || "", slug, content, image || null, attachments || "[]", id],
  );
}

async function updateAttachments(id, attachments) {
  await db.query("UPDATE news_articles SET attachments = $1 WHERE id = $2", [attachments, id]);
}

async function remove(id) {
  await db.query("DELETE FROM news_articles WHERE id = $1", [id]);
}

/**
 * Solo puede haber una noticia destacada: se limpia el resto en la misma
 * transacción lógica antes de marcar la nueva.
 */
async function setFeatured(id, featured) {
  const isFeatured =
    featured === true || featured === "1" || featured === "true" || featured === "on";

  if (isFeatured) {
    await db.query("UPDATE news_articles SET featured = false WHERE featured = true AND id <> $1", [
      id,
    ]);
  }

  await db.query("UPDATE news_articles SET featured = $1 WHERE id = $2", [isFeatured, id]);
  return isFeatured;
}

// Comparación insensible a tildes sin depender de la extensión `unaccent`.
const SIN_TILDES = `translate(%s,
  'áàäâãéèëêíìïîóòöôõúùüûñÁÀÄÂÃÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑ',
  'aaaaaeeeeiiiiooooouuuunAAAAAEEEEIIIIOOOOOUUUUN')`;

/**
 * Nombre real de cada autor. `news_articles.author` guarda el usuario o el
 * correo, nunca el nombre; sin esto la ficha mostraría "Babarca".
 *
 * Se intenta en dos pasadas:
 *   1. Por la parte local del correo registrado (coincidencia exacta).
 *   2. Por la convención de usuario de la empresa, inicial + primer apellido
 *      ("babarca" → Bastián Abarca), que rescata las cuentas antiguas cuyo
 *      correo ya cambió.
 *
 * @param {string[]} claves Partes locales en minúsculas (ver presenter.claveAutor).
 * @returns {Promise<Record<string, string>>} clave → "Nombre Apellido"
 */
async function findAuthorNames(claves) {
  const pendientes = new Set((claves || []).filter(Boolean));
  if (!pendientes.size) return {};

  const nombreDe = (row) => [row.first_name, row.last_name].filter(Boolean).join(" ").trim();

  const resolver = async (sql) => {
    if (!pendientes.size) return {};
    const { rows } = await db.query(sql, [[...pendientes]]);
    return rows.reduce((acc, row) => {
      const nombre = nombreDe(row);
      if (!nombre || !pendientes.has(row.clave)) return acc;
      acc[row.clave] = nombre;
      pendientes.delete(row.clave);
      return acc;
    }, {});
  };

  const porCorreo = await resolver(
    `SELECT lower(split_part(email, '@', 1)) AS clave, first_name, last_name
     FROM users
     WHERE lower(split_part(email, '@', 1)) = ANY($1::text[])`,
  );

  const porConvencion = await resolver(
    `SELECT lower(${SIN_TILDES.replace("%s", "left(first_name, 1) || split_part(last_name, ' ', 1)")}) AS clave,
            first_name, last_name
     FROM users
     WHERE COALESCE(first_name, '') <> '' AND COALESCE(last_name, '') <> ''
       AND lower(${SIN_TILDES.replace("%s", "left(first_name, 1) || split_part(last_name, ' ', 1)")}) = ANY($1::text[])`,
  );

  return { ...porCorreo, ...porConvencion };
}

async function listUsersWithEmail() {
  const { rows } = await db.query(`
    SELECT u.id, u.first_name, u.last_name, u.email, at.area_name AS area,
           at.color AS area_color
    FROM users u
    LEFT JOIN work_areas at ON at.id = u.work_area_id
    WHERE u.email IS NOT NULL AND TRIM(u.email) <> ''
    ORDER BY u.last_name ASC NULLS LAST, u.first_name ASC
  `);
  return rows;
}

async function emailsForAll() {
  const { rows } = await db.query(
    "SELECT email FROM users WHERE email IS NOT NULL AND TRIM(email) <> ''",
  );
  return rows.map((row) => row.email);
}

async function emailsForIds(ids) {
  if (!ids.length) return [];
  const { rows } = await db.query(
    `SELECT email FROM users
     WHERE id = ANY($1::int[]) AND email IS NOT NULL AND TRIM(email) <> ''`,
    [ids],
  );
  return rows.map((row) => row.email);
}

async function logChange(userId, action, linkPath) {
  if (!userId) return;
  await db.query(
    "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
    [userId, action, "Noticias", linkPath],
  );
}

module.exports = {
  COLUMNS,
  generateUniqueSlug,
  listAll,
  listRelated,
  findById,
  findByIdOrSlug,
  create,
  update,
  updateAttachments,
  remove,
  setFeatured,
  findAuthorNames,
  listUsersWithEmail,
  emailsForAll,
  emailsForIds,
  logChange,
};
