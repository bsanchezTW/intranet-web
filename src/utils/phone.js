/**
 * Validación y formato de celulares, según el país de la instancia.
 *
 * El formato local sale de config/country.js (`phone`): Chile agrupa
 * 9 XXXX XXXX y Perú XXX XXX XXX. En ambos casos se almacenan solo dígitos,
 * con el código de país delante — el mismo formato de 11 dígitos que ya usa la
 * columna `users.phone`, así que los datos existentes de Chile no cambian.
 */

const { getCountryConfig } = require("../config/country");

function phoneConfig(countryCode) {
  return getCountryConfig(countryCode).phone;
}

function digitsOnly(value) {
  return String(value || "").replace(/\D/g, "");
}

/** Agrupa dígitos según el patrón del país: [1,4,4] → "9 1234 5678". */
function groupDigits(digits, groups) {
  const out = [];
  let rest = String(digits || "");
  for (const size of groups) {
    if (!rest.length) break;
    out.push(rest.slice(0, size));
    rest = rest.slice(size);
  }
  if (rest.length) out.push(rest);
  return out.join(" ");
}

/** Longitud máxima del campo local ya formateado (dígitos + separadores). */
function localMaxLength(cfg = phoneConfig()) {
  return cfg.nationalDigits + cfg.groups.length - 1;
}

// Mensajes de campo: cortos y del mismo tono que los del resto del
// formulario. El formato esperado ya está en el placeholder del campo.
function mobileErrorMessage() {
  return "Teléfono incorrecto";
}

function mobileRequiredMessage() {
  return "Teléfono requerido";
}

/**
 * Extrae los 9 dígitos nacionales de cualquier forma de entrada
 * (con o sin código de país). Devuelve null si no es un móvil válido.
 */
function toNationalDigits(phone, cfg = phoneConfig()) {
  let digits = digitsOnly(phone);
  if (!digits) return null;

  if (
    digits.length === cfg.nationalDigits + cfg.callingCode.length &&
    digits.startsWith(cfg.callingCode)
  ) {
    digits = digits.slice(cfg.callingCode.length);
  }

  if (digits.length !== cfg.nationalDigits) return null;
  if (!digits.startsWith(cfg.mobileLeadingDigit)) return null;

  return digits;
}

/**
 * Dígitos nacionales de un teléfono fijo, o null. Sólo el teléfono de empresa
 * admite fijos: el personal y el del registro siguen siendo celulares.
 */
function toLandlineDigits(phone, cfg = phoneConfig()) {
  if (!cfg.landline) return null;
  const pattern = new RegExp(cfg.landline.pattern);
  let digits = digitsOnly(phone);
  if (!pattern.test(digits) && digits.startsWith(cfg.callingCode)) {
    digits = digits.slice(cfg.callingCode.length);
  }
  return pattern.test(digits) ? digits : null;
}

/** Forma de almacenamiento: código de país + dígitos nacionales, sin separadores. */
function toStoragePhone(phone, cfg = phoneConfig()) {
  const national = toNationalDigits(phone, cfg);
  return national ? `${cfg.callingCode}${national}` : null;
}

/** Forma visible: "+56 9 1234 5678" / "+51 987 654 321". */
function formatPhoneForDisplay(phone, cfg = phoneConfig()) {
  const trimmed = String(phone || "").trim();
  if (!trimmed) return null;

  const national = toNationalDigits(trimmed, cfg);
  if (national) return `+${cfg.callingCode} ${groupDigits(national, cfg.groups)}`;

  const landline = toLandlineDigits(trimmed, cfg);
  if (landline) return `+${cfg.callingCode} ${groupDigits(landline, cfg.landline.groups)}`;

  return trimmed;
}

function isValidMobilePhone(phone, cfg = phoneConfig()) {
  return toNationalDigits(phone, cfg) !== null;
}

/**
 * @returns {{ valid: boolean, value: string|null, storageValue: string|null, error: string|null }}
 */
function validateMobilePhone(phone, { required = false } = {}, cfg = phoneConfig()) {
  const value = String(phone || "").trim();

  if (!value) {
    if (required) {
      return {
        valid: false,
        value: null,
        storageValue: null,
        error: mobileRequiredMessage(),
      };
    }
    return { valid: true, value: null, storageValue: null, error: null };
  }

  const national = toNationalDigits(value, cfg);
  if (!national) {
    return {
      valid: false,
      value: null,
      storageValue: null,
      error: mobileErrorMessage(cfg),
    };
  }

  return {
    valid: true,
    value: formatPhoneForDisplay(value, cfg),
    storageValue: toStoragePhone(value, cfg),
    error: null,
  };
}

/**
 * Teléfono de empresa: celular o fijo. Mismo contrato que validateMobilePhone.
 * @returns {{ valid: boolean, value: string|null, storageValue: string|null, error: string|null }}
 */
function validateWorkPhone(phone, cfg = phoneConfig()) {
  const value = String(phone || "").trim();
  if (!value) return { valid: true, value: null, storageValue: null, error: null };

  const national = toNationalDigits(value, cfg) || toLandlineDigits(value, cfg);
  if (!national) {
    return { valid: false, value: null, storageValue: null, error: mobileErrorMessage(cfg) };
  }
  return {
    valid: true,
    value: formatPhoneForDisplay(value, cfg),
    storageValue: `${cfg.callingCode}${national}`,
    error: null,
  };
}

function toTelHref(phone, cfg = phoneConfig()) {
  const national = toNationalDigits(phone, cfg) || toLandlineDigits(phone, cfg);
  if (!national) return null;
  return `tel:+${cfg.callingCode}${national}`;
}

/**
 * Teléfono personal enmascarado para listados: sólo los últimos 4 dígitos
 * ("+56 * **** 1435"). El resto de los dígitos no sale del servidor.
 */
function maskPhone(phone, cfg = phoneConfig()) {
  const display = formatPhoneForDisplay(phone, cfg);
  if (!display) return null;
  const prefix = `+${cfg.callingCode} `;
  const hasPrefix = display.startsWith(prefix);
  const national = hasPrefix ? display.slice(prefix.length) : display;
  let toHide = digitsOnly(national).length - 4;
  const masked = national.replace(/\d/g, (d) => (toHide-- > 0 ? "*" : d));
  return hasPrefix ? prefix + masked : masked;
}

/** Datos que las vistas inyectan al script de cliente (public/js/phone.js). */
function phoneClientConfig(cfg = phoneConfig()) {
  return {
    callingCode: cfg.callingCode,
    prefixLabel: `+${cfg.callingCode}`,
    nationalDigits: cfg.nationalDigits,
    mobileLeadingDigit: cfg.mobileLeadingDigit,
    groups: cfg.groups,
    landline: cfg.landline || null,
    example: cfg.example,
    maxLength: localMaxLength(cfg),
    errorMessage: mobileErrorMessage(cfg),
  };
}

module.exports = {
  digitsOnly,
  groupDigits,
  localMaxLength,
  mobileErrorMessage,
  mobileRequiredMessage,
  toNationalDigits,
  toLandlineDigits,
  toStoragePhone,
  formatPhoneForDisplay,
  isValidMobilePhone,
  validateMobilePhone,
  validateWorkPhone,
  toTelHref,
  maskPhone,
  phoneClientConfig,
};
