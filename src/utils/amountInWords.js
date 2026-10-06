/**
 * Monto en letras, como lo exige un título valor:
 *   6942.40, "DÓLARES AMERICANOS"
 *   → "SEIS MIL NOVECIENTOS CUARENTA Y DOS CON 40/100 DÓLARES AMERICANOS"
 *
 * Los céntimos van siempre en fracción (xx/100), también cuando son cero. El
 * "uno" se apocopa delante de MIL y MILLONES (VEINTIÚN MIL, UN MILLÓN) y se
 * conserva entero al final del número (VEINTIUNO CON 00/100).
 */

const UNIDADES = ["", "UNO", "DOS", "TRES", "CUATRO", "CINCO", "SEIS", "SIETE", "OCHO", "NUEVE"];

const DIEZ_A_VEINTINUEVE = [
  "DIEZ", "ONCE", "DOCE", "TRECE", "CATORCE", "QUINCE", "DIECISÉIS", "DIECISIETE",
  "DIECIOCHO", "DIECINUEVE", "VEINTE", "VEINTIUNO", "VEINTIDÓS", "VEINTITRÉS",
  "VEINTICUATRO", "VEINTICINCO", "VEINTISÉIS", "VEINTISIETE", "VEINTIOCHO", "VEINTINUEVE",
];

const DECENAS = ["", "", "", "TREINTA", "CUARENTA", "CINCUENTA", "SESENTA", "SETENTA", "OCHENTA", "NOVENTA"];

const CENTENAS = [
  "", "CIENTO", "DOSCIENTOS", "TRESCIENTOS", "CUATROCIENTOS", "QUINIENTOS",
  "SEISCIENTOS", "SETECIENTOS", "OCHOCIENTOS", "NOVECIENTOS",
];

function apocopar(texto) {
  if (texto.endsWith("VEINTIUNO")) return `${texto.slice(0, -9)}VEINTIÚN`;
  if (texto.endsWith("UNO")) return `${texto.slice(0, -3)}UN`;
  return texto;
}

/** 0–999. */
function centenas(n) {
  if (n === 0) return "";
  if (n === 100) return "CIEN";
  const c = Math.floor(n / 100);
  const resto = n % 100;
  let decenas;
  if (resto < 10) decenas = UNIDADES[resto];
  else if (resto < 30) decenas = DIEZ_A_VEINTINUEVE[resto - 10];
  else {
    const u = resto % 10;
    decenas = DECENAS[Math.floor(resto / 10)] + (u ? ` Y ${UNIDADES[u]}` : "");
  }
  return [CENTENAS[c], decenas].filter(Boolean).join(" ");
}

/** 0–999 999. */
function menosDeUnMillon(n) {
  const miles = Math.floor(n / 1000);
  const resto = n % 1000;
  const partes = [];
  if (miles === 1) partes.push("MIL");
  else if (miles > 1) partes.push(`${apocopar(centenas(miles))} MIL`);
  if (resto) partes.push(centenas(resto));
  return partes.join(" ");
}

/** Entero no negativo en letras (hasta 999 999 999 999). */
function integerToWords(value) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n) || n < 0) throw new RangeError(`Número fuera de rango: ${value}`);
  if (n >= 1e12) throw new RangeError(`Número demasiado grande: ${value}`);
  if (n === 0) return "CERO";

  const millones = Math.floor(n / 1e6);
  const resto = n % 1e6;
  const partes = [];
  if (millones === 1) partes.push("UN MILLÓN");
  else if (millones > 1) partes.push(`${apocopar(menosDeUnMillon(millones))} MILLONES`);
  if (resto) partes.push(menosDeUnMillon(resto));
  return partes.join(" ");
}

/**
 * Monto con céntimos en letras. `currencyWords` va al final tal cual
 * (p. ej. "SOLES", "DÓLARES AMERICANOS").
 */
function amountToWords(amount, currencyWords = "") {
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(cents) || cents < 0) {
    throw new RangeError(`Monto inválido: ${amount}`);
  }
  const entero = integerToWords(Math.floor(cents / 100));
  const fraccion = String(cents % 100).padStart(2, "0");
  return [`${entero} CON ${fraccion}/100`, currencyWords].filter(Boolean).join(" ");
}

module.exports = { integerToWords, amountToWords };
