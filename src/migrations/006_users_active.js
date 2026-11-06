/**
 * Gestión de Permisos, fase 11: la cuenta queda sólo activa o inactiva.
 *
 * `role` (Usuario / Administrador / Deshabilitado) ya no decide nada: los
 * permisos salen de /permisos. Se reemplaza por `active` y la columna vieja
 * se conserva renombrada a `role_legacy`, sin uso, como respaldo: el arranque
 * de permisos (bootstrap.js) la lee si un país todavía no lo corrió.
 *
 * Activa = el rol de antes podía iniciar sesión (Usuario, Administrador o un
 * alias que normalizeRole trataba como uno de ellos). Vacío y Deshabilitado
 * quedan inactivos.
 */
module.exports = {
  id: "006_users_active",
  async up(client) {
    const { rows } = await client.query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'users'
          AND column_name IN ('role', 'role_legacy', 'active')`,
    );
    const columnas = new Set(rows.map((r) => r.column_name));

    if (!columnas.has("active")) {
      await client.query("ALTER TABLE users ADD COLUMN active BOOLEAN NOT NULL DEFAULT FALSE");
      if (columnas.has("role")) {
        await client.query(`
          UPDATE users
             SET active = NULLIF(BTRIM(role), '') IS NOT NULL
                      AND LOWER(BTRIM(role)) NOT IN ('deshabilitado', 'disabled')
        `);
      }
    }

    if (columnas.has("role") && !columnas.has("role_legacy")) {
      await client.query("ALTER TABLE users RENAME COLUMN role TO role_legacy");
      await client.query("ALTER TABLE users ALTER COLUMN role_legacy DROP NOT NULL");
      await client.query("ALTER TABLE users ALTER COLUMN role_legacy DROP DEFAULT");
    }
  },
};
