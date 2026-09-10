/**
 * Documento de identidad del colaborador, según el país de la instancia.
 *
 * Chile usa RUT con dígito verificador (módulo 11) y Perú un DNI de 8 dígitos.
 * La forma la decide config/country.js (`document.kind`), igual que ya ocurre
 * con el teléfono: la columna es una sola (`users.national_id`) y lo que cambia
 * es la validación y el formato.
 *
 * Se guarda siempre normalizado y sin separadores ("12345678-5", "87654321"):
 * los puntos son decoración de pantalla y buscar por RUT con puntos guardados
 * obliga a normalizar en cada consulta.
 */

const { getDocumentConfig } = require("../config/country");

function documentConfig(countryCode) {
  return getDocumentConfig(countryCode);
}

/** Sin puntos, espacios ni guiones, en mayúsculas (la K del RUT). */
function cleanInput(value) {
  return String(value ?? "")
    .replace(/[.\s-]/g, "")
    .trim()
    .toUpperCase();
}

// ---------------------------------------------------------------------------
// Chile — RUT
// ---------------------------------------------------------------------------

/**
 * Dígito verificador por módulo 11: se recorre el cuerpo de derecha a izquierda
 * multiplicando por la serie 2,3,4,5,6,7 que se repite.
 */
function rutCheckDigit(body) {
  let sum = 0;
  let multiplier = 2;
  for (let i = body.length - 1; i >= 0; i -= 1) {
    sum += Number(body[i]) * multiplier;
    multiplier = multiplier === 7 ? 2 : multiplier + 1;
  }
  const remainder = 11 - (sum % 11);
  if (remainder === 11) return "0";
  if (remainder === 10) return "K";
  return String(remainder);
}

/** @returns {{ body: string, dv: string } | null} */
function parseRut(value) {
  const clean = cleanInput(value);
  if (clean.length < 8 || clean.length > 9) return null;

  const body = clean.slice(0, -1);
  const dv = clean.slice(-1);

  if (!/^\d+$/.test(body)) return null;
  if (!/^[\dK]$/.test(dv)) return null;
  // Un RUT de persona parte en 1.000.000; menos que eso es un error de tipeo.
  if (Number(body) < 1000000) return null;
  if (rutCheckDigit(body) !== dv) return null;

  return { body, dv };
}

/** "12345678" → "12.345.678" */
function groupThousands(digits) {
  return String(digits).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

// ---------------------------------------------------------------------------
// Perú — DNI
// ---------------------------------------------------------------------------

function parseDni(value) {
  const clean = cleanInput(value);
  return /^\d{8}$/.test(clean) ? clean : null;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

// Mensaje de campo: corto y en el mismo tono para todos los campos del
// formulario. El formato correcto ya está en el placeholder; repetirlo aquí
// convierte el aviso en un párrafo que nadie lee.
function errorMessage(cfg = documentConfig()) {
  return `${cfg.label} incorrecto`;
}

/**
 * Forma de almacenamiento: "12345678-5" en Chile, "87654321" en Perú.
 * @returns {string|null}
 */
function toStorageNationalId(value, cfg = documentConfig()) {
  if (cfg.kind === "rut") {
    const parsed = parseRut(value);
    return parsed ? `${parsed.body}-${parsed.dv}` : null;
  }
  return parseDni(value);
}

/**
 * Forma visible: "12.345.678-5" / "87654321".
 * Un valor guardado que ya no valide (por ejemplo tras cambiar de país) se
 * devuelve tal cual en vez de desaparecer de la pantalla.
 */
function formatNationalId(value, cfg = documentConfig()) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;

  if (cfg.kind === "rut") {
    const parsed = parseRut(raw);
    if (!parsed) return raw;
    return `${groupThousands(parsed.body)}-${parsed.dv}`;
  }

  return parseDni(raw) || raw;
}

function isValidNationalId(value, cfg = documentConfig()) {
  return toStorageNationalId(value, cfg) !== null;
}

/**
 * @returns {{ valid: boolean, value: string|null, storageValue: string|null, error: string|null }}
 */
function validateNationalId(value, { required = false } = {}, cfg = documentConfig()) {
  const raw = String(value ?? "").trim();

  if (!raw) {
    if (required) {
      return {
        valid: false,
        value: null,
        storageValue: null,
        error: `${cfg.label} requerido`,
      };
    }
    return { valid: true, value: null, storageValue: null, error: null };
  }

  const storageValue = toStorageNationalId(raw, cfg);
  if (!storageValue) {
    return { valid: false, value: null, storageValue: null, error: errorMessage(cfg) };
  }

  return {
    valid: true,
    value: formatNationalId(storageValue, cfg),
    storageValue,
    error: null,
  };
}

/** Datos que las vistas inyectan al script de cliente (public/js/national-id.js). */
function nationalIdClientConfig(cfg = documentConfig()) {
  return {
    kind: cfg.kind,
    label: cfg.label,
    example: cfg.example,
    maxLength: cfg.maxLength,
    help: cfg.help,
    errorMessage: errorMessage(cfg),
  };
}

module.exports = {
  cleanInput,
  rutCheckDigit,
  parseRut,
  parseDni,
  errorMessage,
  toStorageNationalId,
  formatNationalId,
  isValidNationalId,
  validateNationalId,
  nationalIdClientConfig,
};
