const { canLogin, normalizeRole } = require("../../constants/roles");

/**
 * Recuperación de acceso: marcar (o quitar) a un superadmin por correo desde
 * el servidor (scripts/superadmin.js).
 *
 * Reemplaza al login de emergencia AUTH_USER/AUTH_PASS, que daba sesión de
 * administrador total por la web con una contraseña compartida, sin cuenta
 * detrás, sin auditoría útil y sin poder revocarse. Esto exige acceso al
 * servidor, actúa sobre una cuenta real y queda en perm_audit como cualquier
 * otro cambio de superadmin (actor vacío = el servidor).
 */
async function markSuperadminByEmail({ db, store, email, remove = false }) {
  const clean = String(email || "").trim().toLowerCase();
  if (!clean || !clean.includes("@")) {
    throw new Error("Indica el correo de la cuenta.");
  }
  const { rows } = await db.query(
    `SELECT id, first_name, last_name, email, role
       FROM users
      WHERE LOWER(TRIM(email)) = $1`,
    [clean],
  );
  if (!rows.length) throw new Error(`No hay una cuenta con el correo ${clean}.`);
  const user = rows[0];
  if (!remove && !canLogin(normalizeRole(user.role))) {
    throw new Error(`La cuenta ${clean} está deshabilitada: habilítala antes de hacerla superadmin.`);
  }
  await store.setSuperadmin(user.id, !remove, null);
  return user;
}

module.exports = { markSuperadminByEmail };
