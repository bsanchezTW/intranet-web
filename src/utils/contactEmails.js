/**
 * Correo de empresa vs. correo de la cuenta.
 *
 * `users.email` es el correo con el que se entra, se verifica la cuenta y
 * llegan los avisos. Casi siempre es el de empresa, pero quien no tiene uno
 * usa su correo personal: en ese caso `email` y `personal_email` son iguales,
 * y ese correo es personal — se oculta en el directorio y no llega al
 * asistente.
 */

/** true si la cuenta usa el correo personal (no hay correo de empresa). */
function accountUsesPersonalEmail(row) {
  const email = String(row?.email || "").trim().toLowerCase();
  const personal = String(row?.personal_email || "").trim().toLowerCase();
  return Boolean(email) && email === personal;
}

/** Correo de empresa de la ficha, o null. */
function companyEmail(row) {
  if (!row?.email || accountUsesPersonalEmail(row)) return null;
  return row.email;
}

/** Lo mismo en SQL, para no traer el correo personal a quien no debe verlo. */
function companyEmailSql(alias = "u") {
  return `CASE WHEN LOWER(TRIM(${alias}.email)) = LOWER(TRIM(${alias}.personal_email))
            THEN NULL ELSE ${alias}.email END`;
}

/**
 * Correo personal enmascarado para listados: las dos primeras letras y el
 * dominio ("ti***@icloud.com"). Basta para reconocerlo, no para escribirle.
 */
function maskEmail(email) {
  const value = String(email || "").trim();
  const at = value.lastIndexOf("@");
  if (at < 1) return value ? "***" : null;
  const local = value.slice(0, at);
  const visible = local.length > 3 ? 2 : 1;
  return `${local.slice(0, visible)}***${value.slice(at)}`;
}

/** SQL: true si la cuenta usa el correo personal. */
function accountUsesPersonalEmailSql(alias = "u") {
  return `COALESCE(LOWER(TRIM(${alias}.email)) = LOWER(TRIM(${alias}.personal_email)), FALSE)`;
}

module.exports = {
  accountUsesPersonalEmail,
  companyEmail,
  companyEmailSql,
  accountUsesPersonalEmailSql,
  maskEmail,
};
