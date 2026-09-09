const db = require("../db");
const { normalizeAppCatalog } = require("../constants/appCatalogs");

/**
 * Lista las apps de un catálogo con los alias en español que esperan las
 * vistas. La consulta es la misma para "Apps" y para la autoayuda de Soporte:
 * lo único que cambia es el catálogo.
 */
async function listAppsByCatalog(catalog) {
  // `sort_order` manda cuando alguien ordenó a mano; lo que nunca se tocó
  // (NULL) conserva el orden por fecha y queda al final.
  const { rows } = await db.query(
    `SELECT * FROM applications
      WHERE catalog = $1
      ORDER BY sort_order ASC NULLS LAST, created_at DESC`,
    [normalizeAppCatalog(catalog)],
  );
  return rows.map((app) => ({
    ...app,
    nombre: app.name ?? app.nombre,
    descripcion: app.description ?? app.descripcion,
    fecha_creacion: app.created_at ?? app.fecha_creacion,
    ultima_actualizacion: app.updated_at ?? app.ultima_actualizacion,
    cambios: app.changelog ?? app.cambios,
    notificado: app.notified ?? app.notificado,
  }));
}

/**
 * Reescribe el orden de un catálogo con la secuencia de ids recibida.
 *
 * El `catalog` va en el WHERE para que una lista manipulada no pueda mover
 * tarjetas de otro catálogo, y se hace en una sola sentencia para que el orden
 * quede consistente aunque dos administradores guarden a la vez.
 */
async function reorderAppsInCatalog(catalog, ids) {
  const catalogo = normalizeAppCatalog(catalog);
  // Se exige entero positivo: `Number(null)`, `Number("")` y `Number([])` dan 0,
  // y colarían un id falso en la lista si sólo se comprobara que es entero.
  const limpios = (Array.isArray(ids) ? ids : [])
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);

  if (limpios.length === 0) return 0;

  const { rowCount } = await db.query(
    `UPDATE applications AS a
        SET sort_order = orden.posicion
       FROM (SELECT * FROM UNNEST($1::int[]) WITH ORDINALITY AS t(id, posicion)) AS orden
      WHERE a.id = orden.id
        AND a.catalog = $2`,
    [limpios, catalogo],
  );

  return rowCount;
}

module.exports = { listAppsByCatalog, reorderAppsInCatalog };
