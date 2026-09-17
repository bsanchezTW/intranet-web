(function (global) {
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
    return analyzePasswordStrength(password).score >= 3;
  }

  const POLICY_HINT =
    "Usa al menos 8 caracteres y combina 3 de estos 4: minúsculas, mayúsculas, números o símbolos.";

  /**
   * Pinta un medidor con el mismo marcado que el del registro
   * (.login-password-strength: segmentos, etiqueta y lista de reglas).
   * Devuelve el resultado del análisis.
   */
  function renderMeter(box, password) {
    const result = analyzePasswordStrength(password);
    if (!box) return result;
    const hasValue = String(password || "").length > 0;
    const label = box.querySelector(".login-password-strength-label");

    box.hidden = !hasValue;
    if (label) {
      label.textContent = hasValue ? result.label : "";
      label.className =
        "login-password-strength-label" + (hasValue ? " " + result.level : "");
    }
    box.querySelectorAll(".login-password-strength-segment").forEach((seg) => {
      const idx = Number(seg.dataset.segment);
      seg.className =
        "login-password-strength-segment" +
        (hasValue && idx <= result.score ? " active-" + result.score : "");
    });
    box.querySelectorAll("[data-rule]").forEach((item) => {
      item.classList.toggle("valid", hasValue && Boolean(result.checks[item.dataset.rule]));
    });
    return result;
  }

  global.PasswordStrength = {
    analyzePasswordStrength,
    isPasswordStrongEnough,
    renderMeter,
    POLICY_HINT,
  };
})(window);
