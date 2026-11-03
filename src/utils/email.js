const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

const EMAIL_ERROR = "Correo incorrecto";
const EMAIL_REQUIRED = "Correo requerido";

/**
 * ¿Son el mismo buzón? Sin distinguir mayúsculas ni espacios: un ticket
 * creado por correo trae el remitente como lo escribió su cliente
 * ("Ana@Transworld.cl") y su dueño inicia sesión como ana@transworld.cl.
 */
function sameEmail(a, b) {
  const x = String(a ?? "").trim().toLowerCase();
  const y = String(b ?? "").trim().toLowerCase();
  return x !== "" && x === y;
}

function isValidEmail(email) {
  return EMAIL_PATTERN.test(String(email || "").trim());
}

function validateEmail(email, { required = false } = {}) {
  const value = String(email || "").trim().toLowerCase();

  if (!value) {
    if (required) {
      return { valid: false, value: null, error: EMAIL_REQUIRED };
    }
    return { valid: true, value: null, error: null };
  }

  if (!isValidEmail(value)) {
    return { valid: false, value: null, error: EMAIL_ERROR };
  }

  return { valid: true, value, error: null };
}

module.exports = {
  sameEmail,
  EMAIL_PATTERN,
  EMAIL_ERROR,
  isValidEmail,
  validateEmail,
};
