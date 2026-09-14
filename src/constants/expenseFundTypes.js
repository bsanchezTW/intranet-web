/**
 * Tipo de fondo de la planilla de rendición: un fondo fijo (caja chica que se
 * repone) o un fondo a rendir (adelanto para un trabajo puntual).
 */

const EXPENSE_FUND_TYPE = Object.freeze({
  FIJO: "fijo",
  RENDIR: "rendir",
});

const EXPENSE_FUND_TYPE_LABELS = Object.freeze({
  fijo: "Fondo fijo",
  rendir: "Fondo a rendir",
});

const ALL_EXPENSE_FUND_TYPES = Object.freeze(Object.values(EXPENSE_FUND_TYPE));

function isExpenseFundType(value) {
  return ALL_EXPENSE_FUND_TYPES.includes(value);
}

function expenseFundTypeLabel(value) {
  return EXPENSE_FUND_TYPE_LABELS[value] || "—";
}

module.exports = {
  EXPENSE_FUND_TYPE,
  EXPENSE_FUND_TYPE_LABELS,
  ALL_EXPENSE_FUND_TYPES,
  isExpenseFundType,
  expenseFundTypeLabel,
};
