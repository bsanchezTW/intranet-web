/**
 * Letras de cambio que gira Transworld Perú.
 *
 * Transworld es siempre el girador: la letra dice "pagar a la Orden de
 * TRANSWORLD POWER AND TELECOM S.A.C." y el cliente es el aceptante. Por eso el
 * girador no se captura en el formulario, vive aquí.
 *
 * El formato impreso replica el talonario físico de la empresa (cláusulas
 * especiales en vertical, columnas de firma del aceptante, recuadro de firma
 * del girador). Ver services/billsOfExchange/billOfExchangePdf.js.
 *
 * El recuadro del girador sale sólo con sus rótulos, como en el talonario: la
 * razón social y el representante los pone el sello de la empresa y la firma
 * va a mano. Por eso aquí no vive ningún dato del representante legal.
 */

const BILL_DRAWER = Object.freeze({
  name: "TRANSWORLD POWER AND TELECOM S.A.C.",
  ruc: "20600956257",
});

/** Cláusulas especiales del reverso izquierdo, tal como las trae el talonario. */
const BILL_CLAUSES = Object.freeze([
  "En caso de mora, esta Letra de Cambio generará las tasas de interés compensatorio y moratorio más altas que la ley permita a su último Tenedor.",
  "El plazo de vencimiento podrá ser prorrogado por el Tenedor, por el plazo que éste señale, sin que sea necesaria la intervención del obligado principal ni de los solidarios.",
  "Esta Letra de Cambio no requiere ser protestada por falta de pago.",
  "Su importe debe ser pagado sólo en la misma moneda que expresa este título valor.",
]);

/**
 * Las letras se giran sólo en dólares americanos. `words` es lo que sigue a
 * "CON 40/100" en el monto en letras; `symbol` el de la casilla de importe.
 * La columna currency_code se conserva para que cada letra diga su moneda.
 */
const BILL_CURRENCY = Object.freeze({
  code: "USD",
  label: "Dólares americanos",
  symbol: "US$",
  words: "DÓLARES AMERICANOS",
});

const BILL_STATUS = Object.freeze({
  ISSUED: "issued",
  PAID: "paid",
  VOIDED: "voided",
});

const BILL_STATUS_VALUES = Object.values(BILL_STATUS);

const BILL_NUMBER_PREFIX = "LT";
const DEFAULT_ISSUE_PLACE = "Lima";
/** Las letras de un mismo cronograma vencen cada 30 días desde el giro. */
const DEFAULT_INTERVAL_DAYS = 30;
const MAX_INSTALLMENTS = 36;
const MAX_INTERVAL_DAYS = 366;

/** "LT-00421-2026": prefijo, correlativo de 5 dígitos y año del giro. */
function formatBillNumber(year, seq) {
  return `${BILL_NUMBER_PREFIX}-${String(seq).padStart(5, "0")}-${year}`;
}

/** Monto con separador de miles y dos decimales: "6,942.40" (uso peruano). */
function formatBillAmount(amount) {
  const cents = Math.round(Number(amount) * 100);
  if (!Number.isFinite(cents)) return "—";
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const integer = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${sign}${integer}.${String(abs % 100).padStart(2, "0")}`;
}

/** "US$ 6,942.40" */
function formatBillMoney(amount) {
  return `${BILL_CURRENCY.symbol} ${formatBillAmount(amount)}`;
}

/**
 * Estado que ve el usuario. "Vencida" no se guarda: es una letra vigente cuya
 * fecha de vencimiento ya pasó, y deja de serlo sola cuando se marca pagada.
 */
function billDisplayStatus(status, dueDate, today) {
  if (status === BILL_STATUS.PAID) return { key: "pagada", label: "Pagada" };
  if (status === BILL_STATUS.VOIDED) return { key: "anulada", label: "Anulada" };
  if (dueDate && today && String(dueDate) < String(today)) {
    return { key: "vencida", label: "Vencida" };
  }
  return { key: "vigente", label: "Vigente" };
}

module.exports = {
  BILL_DRAWER,
  BILL_CLAUSES,
  BILL_CURRENCY,
  BILL_STATUS,
  BILL_STATUS_VALUES,
  BILL_NUMBER_PREFIX,
  DEFAULT_ISSUE_PLACE,
  DEFAULT_INTERVAL_DAYS,
  MAX_INSTALLMENTS,
  MAX_INTERVAL_DAYS,
  formatBillNumber,
  formatBillAmount,
  formatBillMoney,
  billDisplayStatus,
};
