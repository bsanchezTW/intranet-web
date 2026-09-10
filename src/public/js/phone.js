/**
 * Campo de celular en el navegador. El formato lo define la instancia y llega
 * en window.__PHONE_CONFIG__, inyectado por la vista desde config/country.js:
 * así el cliente y el servidor no mantienen dos reglas que se desincronizan.
 */
(function (global) {
  const cfg = global.__PHONE_CONFIG__ || {
    callingCode: "56",
    prefixLabel: "+56",
    nationalDigits: 9,
    mobileLeadingDigit: "9",
    groups: [1, 4, 4],
    example: "9 1234 5678",
    maxLength: 11,
    errorMessage: "Teléfono incorrecto",
  };

  const ERROR_MSG = cfg.errorMessage;

  function digitsOnly(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function groupDigits(digits) {
    const out = [];
    let rest = String(digits || "");
    for (let i = 0; i < cfg.groups.length && rest.length; i++) {
      out.push(rest.slice(0, cfg.groups[i]));
      rest = rest.slice(cfg.groups[i]);
    }
    if (rest.length) out.push(rest);
    return out.join(" ");
  }

  /** Dígitos nacionales de cualquier entrada, o null si no es móvil válido. */
  function toNationalDigits(value) {
    let digits = digitsOnly(value);
    if (!digits) return null;
    if (
      digits.length === cfg.nationalDigits + cfg.callingCode.length &&
      digits.indexOf(cfg.callingCode) === 0
    ) {
      digits = digits.slice(cfg.callingCode.length);
    }
    if (digits.length !== cfg.nationalDigits) return null;
    if (digits.indexOf(cfg.mobileLeadingDigit) !== 0) return null;
    return digits;
  }

  function isValidMobilePhone(phone) {
    return toNationalDigits(phone) !== null;
  }

  function isValidLocalPhone(local) {
    return toNationalDigits(local) !== null;
  }

  function toLocalPart(fullPhone) {
    const national = toNationalDigits(fullPhone);
    if (national) return groupDigits(national);
    return String(fullPhone || "").trim();
  }

  function toFullPhone(localPart) {
    const national = toNationalDigits(localPart);
    if (!national) return "";
    return cfg.prefixLabel + " " + groupDigits(national);
  }

  /** Formato progresivo mientras se escribe (acepta entradas parciales). */
  function formatLocalInput(raw) {
    let digits = digitsOnly(raw);

    if (digits.indexOf(cfg.callingCode) === 0 && digits.length > cfg.nationalDigits) {
      digits = digits.slice(cfg.callingCode.length);
    }
    if (digits.charAt(0) === "0") digits = digits.slice(1);

    digits = digits.slice(0, cfg.nationalDigits);
    if (!digits.length) return "";

    return groupDigits(digits);
  }

  function initField(root, options) {
    if (!root) return null;

    const localInput = root.querySelector(".phone-field__local");
    const hiddenInput =
      root.querySelector('input[type="hidden"][name="phone"]') ||
      root.querySelector('input[type="hidden"][name="telefono"]') ||
      root.querySelector(".phone-field__full");

    if (!localInput || !hiddenInput) return null;

    const onChange =
      options && typeof options.onChange === "function" ? options.onChange : null;

    function sync() {
      const formatted = formatLocalInput(localInput.value);
      if (localInput.value !== formatted) {
        localInput.value = formatted;
      }

      const full = toFullPhone(formatted);
      hiddenInput.value = full;

      const hasPartial = formatted.length > 0;
      localInput.setCustomValidity(
        hasPartial && !isValidLocalPhone(formatted) ? ERROR_MSG : "",
      );

      if (onChange) onChange(full, formatted);
    }

    localInput.addEventListener("input", sync);
    localInput.addEventListener("blur", sync);

    if (!localInput.value.trim() && hiddenInput.value) {
      localInput.value = toLocalPart(hiddenInput.value);
    }

    sync();

    return {
      root,
      localInput,
      hiddenInput,
      sync,
      getValue: () => hiddenInput.value,
    };
  }

  function isFieldValid(root) {
    if (!root) return false;
    const hiddenInput =
      root.querySelector('input[type="hidden"][name="phone"]') ||
      root.querySelector('input[type="hidden"][name="telefono"]');
    return hiddenInput ? isValidMobilePhone(hiddenInput.value) : false;
  }

  function isFieldEmpty(root) {
    if (!root) return true;
    const localInput = root.querySelector(".phone-field__local");
    return !localInput || !localInput.value.trim();
  }

  function bindTelefonoInput(input, options) {
    const root = input && input.closest("[data-phone-field]");
    if (root) return initField(root, options);
    return null;
  }

  global.PhoneField = {
    CONFIG: cfg,
    ERROR_MSG,
    isValidMobilePhone,
    isValidLocalPhone,
    toLocalPart,
    toFullPhone,
    formatLocalInput,
    initField,
    isFieldValid,
    isFieldEmpty,
    bindTelefonoInput,
  };
})(typeof window !== "undefined" ? window : globalThis);
