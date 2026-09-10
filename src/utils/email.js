const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i;

const EMAIL_ERROR = "Correo incorrecto";
const EMAIL_REQUIRED = "Correo requerido";

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
  EMAIL_PATTERN,
  EMAIL_ERROR,
  isValidEmail,
  validateEmail,
};
