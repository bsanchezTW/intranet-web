function analyzePasswordStrength(password) {
  const value = String(password || "");

  const checks = {
    length: value.length >= 8,
    lowercase: /[a-z]/.test(value),
    uppercase: /[A-Z]/.test(value),
    number: /[0-9]/.test(value),
    symbol: /[^A-Za-z0-9]/.test(value),
  };

  const passed = Object.values(checks).filter(Boolean).length;

  if (!value.length) {
    return { score: 0, level: "empty", label: "", checks, passed: 0 };
  }
  if (value.length < 8 || passed <= 2) {
    return { score: 1, level: "weak", label: "Muy débil", checks, passed };
  }
  if (passed === 3) {
    return { score: 2, level: "fair", label: "Débil", checks, passed };
  }
  if (passed === 4) {
    return { score: 3, level: "good", label: "Aceptable", checks, passed };
  }
  if (value.length >= 12) {
    return { score: 5, level: "strong", label: "Muy fuerte", checks, passed };
  }
  return { score: 4, level: "strong", label: "Fuerte", checks, passed };
}

function isPasswordStrongEnough(password) {
  const { score } = analyzePasswordStrength(password);
  return score >= 3;
}

// Mensaje único para todos los flujos que crean o cambian contraseñas
// (registro, restablecer clave temporal y cambio desde el perfil).
const PASSWORD_POLICY_MESSAGE =
  "La contraseña es muy débil. Debe tener al menos 8 caracteres y combinar 3 de estos 4: minúsculas, mayúsculas, números o símbolos.";

module.exports = { isPasswordStrongEnough, PASSWORD_POLICY_MESSAGE };
