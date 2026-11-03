const { toDateOnly } = require("../../utils/vacationDateUtils");

/** Lectura de campos de formulario compartida por los módulos de Logística. */

function cleanText(value, max) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return max ? text.slice(0, max) : text;
}

/** Texto de varias líneas: conserva los saltos, colapsa el resto. */
function cleanMultiline(value, max) {
  const text = String(value ?? "")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return max ? text.slice(0, max) : text;
}

/** Entero ≥ 0 (acepta "45.230"). `{ value, ok }`; vacío es `{ null, true }`. */
function parseOptionalInt(value) {
  const raw = String(value ?? "").replace(/[.\s]/g, "").trim();
  if (!raw) return { value: null, ok: true };
  if (!/^\d+$/.test(raw)) return { value: null, ok: false };
  const n = Number(raw);
  return { value: n, ok: Number.isSafeInteger(n) };
}

/** 'YYYY-MM-DD' que además existe en el calendario. */
function isValidIsoDate(value) {
  const raw = String(value ?? "").trim();
  const iso = toDateOnly(raw);
  if (!iso || iso !== raw) return false;
  const [y, m, d] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parseOptionalDate(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return { value: null, ok: true };
  return isValidIsoDate(raw) ? { value: raw, ok: true } : { value: null, ok: false };
}

/** Id numérico de la URL o del formulario; null si no lo es. */
function parseId(value) {
  const raw = String(value ?? "");
  return /^\d{1,15}$/.test(raw) ? Number(raw) : null;
}

module.exports = {
  cleanText,
  cleanMultiline,
  parseOptionalInt,
  isValidIsoDate,
  parseOptionalDate,
  parseId,
};
