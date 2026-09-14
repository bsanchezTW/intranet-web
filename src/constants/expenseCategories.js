/**
 * Categorías de cada línea del desglose.
 *
 * Son las columnas de "Códigos de cuenta" de la planilla de rendición en papel,
 * más las compras que la planilla no contemplaba (hardware, suscripciones) y
 * "Otros" para lo que no calza en ninguna. "Gastos hotel" pasa a llamarse
 * Hospedaje y es la única que pide días.
 */

const EXPENSE_CATEGORY = Object.freeze({
  TELEFONO: "telefono",
  COMIDAS: "comidas",
  HOSPEDAJE: "hospedaje",
  ARRIENDO_AUTO: "arriendo_auto",
  PASAJES: "pasajes",
  TRANSFER: "transfer",
  PEAJES: "peajes",
  COMBUSTIBLE: "combustible",
  HARDWARE: "hardware",
  SOFTWARE: "software",
  OTROS: "otros",
});

const EXPENSE_CATEGORY_LABELS = Object.freeze({
  telefono: "Teléfono",
  comidas: "Comidas",
  hospedaje: "Hospedaje",
  arriendo_auto: "Arriendo de auto",
  pasajes: "Pasajes",
  transfer: "Transfer",
  peajes: "Peajes",
  combustible: "Combustible",
  hardware: "Hardware y equipos",
  software: "Software y suscripciones",
  otros: "Otros",
});

/** En el orden en que aparecen en el selector. */
const ALL_EXPENSE_CATEGORIES = Object.freeze(Object.values(EXPENSE_CATEGORY));

/** Tope de días de hospedaje en una sola línea. */
const MAX_LODGING_DAYS = 365;

function isExpenseCategory(value) {
  return ALL_EXPENSE_CATEGORIES.includes(value);
}

function expenseCategoryLabel(value) {
  return EXPENSE_CATEGORY_LABELS[value] || "—";
}

function categoryRequiresDays(value) {
  return value === EXPENSE_CATEGORY.HOSPEDAJE;
}

module.exports = {
  EXPENSE_CATEGORY,
  EXPENSE_CATEGORY_LABELS,
  ALL_EXPENSE_CATEGORIES,
  MAX_LODGING_DAYS,
  isExpenseCategory,
  expenseCategoryLabel,
  categoryRequiresDays,
};
