const { APP_CATALOG_VALUES, DEFAULT_APP_CATALOG } = require("../constants/appCatalogs");

/**
 * Columnas de applications: ícono, iOS, web, catálogo (Apps / Soporte) y
 * orden manual. Si `applications` es la vista sobre shared.applications, las
 * columnas viven en el catálogo compartido y no hay nada que hacer aquí.
 *
 * `catalog` nace con DEFAULT en el catálogo corporativo: lo ya publicado en
 * /apps no cambia. `sort_order` nace NULL: mientras nadie reordene, se
 * conserva el orden por fecha.
 */
module.exports = {
  id: "004_applications_columns",
  async up(client) {
    const { rows } = await client.query(`
      SELECT c.relkind
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = current_schema() AND c.relname = 'applications'
       LIMIT 1`);
    if (!rows[0] || rows[0].relkind === "v") return;

    const valores = APP_CATALOG_VALUES.map((v) => `'${v.replace(/'/g, "''")}'`).join(", ");
    await client.query(`
      ALTER TABLE applications
        ADD COLUMN IF NOT EXISTS icon_url TEXT,
        ADD COLUMN IF NOT EXISTS url_ios TEXT,
        ADD COLUMN IF NOT EXISTS url_web TEXT,
        ADD COLUMN IF NOT EXISTS catalog VARCHAR(20) NOT NULL DEFAULT '${DEFAULT_APP_CATALOG.replace(/'/g, "''")}',
        ADD COLUMN IF NOT EXISTS sort_order INTEGER
    `);
    await client.query(`
      DO $do$
      BEGIN
        IF NOT EXISTS (
          SELECT 1
            FROM pg_constraint con
            JOIN pg_class c ON c.oid = con.conrelid
            JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE con.conname = 'applications_catalog_check'
             AND c.relname = 'applications'
             AND n.nspname = current_schema()
        ) THEN
          ALTER TABLE applications
            ADD CONSTRAINT applications_catalog_check CHECK (catalog IN (${valores}));
        END IF;
      END
      $do$;
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_applications_catalog ON applications (catalog)");
    await client.query(
      "CREATE INDEX IF NOT EXISTS idx_applications_catalog_orden ON applications (catalog, sort_order)",
    );
  },
};
