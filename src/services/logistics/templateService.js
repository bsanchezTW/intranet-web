const db = require("../../db");
const { cleanText } = require("./inputs");

/**
 * Plantilla de la revisión mecánica: categorías y sus ítems, en orden.
 *
 * Una categoría existe aunque no tenga ítems; al eliminarla se van sus ítems
 * (ON DELETE CASCADE). Nada de esto toca las revisiones ya registradas:
 * vehicle_checklist_answers guarda el texto de cada ítem y su categoría.
 *
 * El orden se guarda en sort_order de 10 en 10 y se renumera completo en
 * cada movimiento, así nunca quedan dos con el mismo lugar.
 *
 * normalizeCategoryInput y normalizeItemInput son puras para probarlas sin
 * base; el resto habla con Postgres.
 */

class TemplateError extends Error {
  constructor(message) {
    super(message);
    this.code = "TEMPLATE_INVALID";
  }
}

function normalizeCategoryInput(body = {}) {
  const values = { name: cleanText(body.name, 60) };
  const errors = {};
  if (!values.name) errors.name = "Escribe el nombre de la categoría.";
  return { values, errors, ok: !errors.name };
}

function normalizeItemInput(body = {}) {
  const values = {
    label: cleanText(body.label, 160),
    critical: body.critical === "1" || body.critical === "on",
  };
  const errors = {};
  if (!values.label) errors.label = "Escribe el ítem.";
  return { values, errors, ok: !errors.label };
}

const DIRECCIONES = { arriba: -1, abajo: 1 };

/** Nuevo orden de una lista de ids al mover uno hacia arriba o abajo. Pura. */
function reorder(ids, id, direccion) {
  const paso = DIRECCIONES[direccion];
  const i = ids.findIndex((x) => String(x) === String(id));
  if (!paso || i < 0) return null;
  const j = i + paso;
  if (j < 0 || j >= ids.length) return ids.slice();
  const out = ids.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

// ---------------------------------------------------------------------------
// Lectura
// ---------------------------------------------------------------------------

/** Categorías en orden, cada una con sus ítems activos en orden. */
async function listCategories() {
  const [{ rows: categorias }, { rows: items }] = await Promise.all([
    db.query("SELECT id, name, sort_order FROM vehicle_checklist_categories ORDER BY sort_order, id"),
    db.query(
      `SELECT id, category_id, label, critical, sort_order
         FROM vehicle_checklist_items
        WHERE active AND category_id IS NOT NULL
        ORDER BY sort_order, id`,
    ),
  ]);
  return categorias.map((c) => ({ ...c, items: items.filter((i) => String(i.category_id) === String(c.id)) }));
}

/**
 * Ítems que pide la revisión mecánica, en el orden de su categoría y luego
 * el propio. `category` es el nombre vigente de la categoría.
 */
async function listTemplateItems() {
  const { rows } = await db.query(
    `SELECT i.id, c.name AS category, i.label, i.critical
       FROM vehicle_checklist_items i
       JOIN vehicle_checklist_categories c ON c.id = i.category_id
      WHERE i.active
      ORDER BY c.sort_order, c.id, i.sort_order, i.id`,
  );
  return rows;
}

// ---------------------------------------------------------------------------
// Categorías
// ---------------------------------------------------------------------------

function nombreRepetido(err, name) {
  if (err.code === "23505") throw new TemplateError(`Ya hay una categoría llamada «${name}».`);
  throw err;
}

async function createCategory(values) {
  try {
    const { rows } = await db.query(
      `INSERT INTO vehicle_checklist_categories (name, sort_order)
       VALUES ($1, (SELECT COALESCE(MAX(sort_order), 0) + 10 FROM vehicle_checklist_categories))
       RETURNING id`,
      [values.name],
    );
    return Number(rows[0].id);
  } catch (err) {
    return nombreRepetido(err, values.name);
  }
}

/** Renombra la categoría y el nombre que guardan sus ítems. */
async function renameCategory(id, values) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    const { rowCount } = await client.query("UPDATE vehicle_checklist_categories SET name = $2 WHERE id = $1", [id, values.name]);
    if (rowCount) await client.query("UPDATE vehicle_checklist_items SET category = $2 WHERE category_id = $1", [id, values.name]);
    await client.query("COMMIT");
    return rowCount > 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    return nombreRepetido(err, values.name);
  } finally {
    client.release();
  }
}

/** Elimina la categoría con sus ítems. Devuelve { name, items } o null. */
async function deleteCategory(id) {
  const { rows } = await db.query(
    `WITH borrada AS (DELETE FROM vehicle_checklist_categories WHERE id = $1 RETURNING id, name)
     SELECT b.name, (SELECT COUNT(*)::int FROM vehicle_checklist_items i WHERE i.category_id = b.id AND i.active) AS items
       FROM borrada b`,
    [id],
  );
  return rows[0] || null;
}

async function renumerar(client, tabla, ids) {
  await client.query(
    `UPDATE ${tabla} t SET sort_order = s.orden * 10
       FROM UNNEST($1::bigint[]) WITH ORDINALITY AS s(id, orden)
      WHERE t.id = s.id`,
    [ids],
  );
}

/** Sube o baja una categoría un lugar. false si no existe. */
async function moveCategory(id, direccion) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('vehicle_checklist_categories'))");
    const { rows } = await client.query("SELECT id FROM vehicle_checklist_categories ORDER BY sort_order, id");
    const orden = reorder(rows.map((r) => r.id), id, direccion);
    if (!orden) {
      await client.query("ROLLBACK");
      return false;
    }
    await renumerar(client, "vehicle_checklist_categories", orden);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------
// Ítems
// ---------------------------------------------------------------------------

/** Agrega un ítem al final de su categoría. null si la categoría no existe. */
async function createItem(categoryId, values) {
  const { rows } = await db.query(
    `INSERT INTO vehicle_checklist_items (category_id, category, label, critical, sort_order)
     SELECT c.id, c.name, $2, $3,
            (SELECT COALESCE(MAX(i.sort_order), 0) + 10 FROM vehicle_checklist_items i WHERE i.category_id = c.id)
       FROM vehicle_checklist_categories c
      WHERE c.id = $1
     RETURNING id`,
    [categoryId, values.label, values.critical],
  );
  return rows[0] ? Number(rows[0].id) : null;
}

/** Editar un ítem no toca las revisiones ya registradas: guardan su texto. */
async function updateItem(id, values) {
  const { rowCount } = await db.query(
    "UPDATE vehicle_checklist_items SET label = $2, critical = $3 WHERE id = $1 AND active",
    [id, values.label, values.critical],
  );
  return rowCount > 0;
}

/** Devuelve { label } del ítem eliminado, o null. */
async function deleteItem(id) {
  const { rows } = await db.query("DELETE FROM vehicle_checklist_items WHERE id = $1 RETURNING label", [id]);
  return rows[0] || null;
}

/** Sube o baja un ítem un lugar dentro de su categoría. */
async function moveItem(id, direccion) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('vehicle_checklist_items'))");
    const { rows: [item] } = await client.query("SELECT category_id FROM vehicle_checklist_items WHERE id = $1 AND active", [id]);
    if (!item) {
      await client.query("ROLLBACK");
      return false;
    }
    const { rows } = await client.query(
      "SELECT id FROM vehicle_checklist_items WHERE category_id = $1 AND active ORDER BY sort_order, id",
      [item.category_id],
    );
    const orden = reorder(rows.map((r) => r.id), id, direccion);
    if (!orden) {
      await client.query("ROLLBACK");
      return false;
    }
    await renumerar(client, "vehicle_checklist_items", orden);
    await client.query("COMMIT");
    return true;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = {
  TemplateError,
  normalizeCategoryInput,
  normalizeItemInput,
  reorder,
  listCategories,
  listTemplateItems,
  createCategory,
  renameCategory,
  deleteCategory,
  moveCategory,
  createItem,
  updateItem,
  deleteItem,
  moveItem,
};
