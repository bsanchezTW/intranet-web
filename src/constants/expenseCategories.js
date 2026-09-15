/**
 * Categorías de cada línea del desglose.
 *
 * Parten de los "Códigos de cuenta" de la planilla en papel. Los códigos viejos
 * se conservan para no romper líneas ya guardadas: lo que cambia es la etiqueta
 * y el selector (más grupos, más detalle). "pasajes" dejó de ofrecerse y se
 * partió en aéreos / terrestres; combustible pide rendimiento, distancia y
 * precio por litro.
 */

const EXPENSE_CATEGORY = Object.freeze({
  TELEFONO: "telefono",
  COMIDAS: "comidas",
  HOSPEDAJE: "hospedaje",
  ARRIENDO_AUTO: "arriendo_auto",
  PASAJES: "pasajes",
  PASAJES_AEREOS: "pasajes_aereos",
  PASAJES_TERRESTRES: "pasajes_terrestres",
  TRANSFER: "transfer",
  PEAJES: "peajes",
  COMBUSTIBLE: "combustible",
  ESTACIONAMIENTO: "estacionamiento",
  TAXI_APPS: "taxi_apps",
  HARDWARE: "hardware",
  SOFTWARE: "software",
  MATERIALES: "materiales",
  ENVIOS: "envios",
  OTROS: "otros",
});

const EXPENSE_CATEGORY_LABELS = Object.freeze({
  telefono: "Telefonía",
  comidas: "Alimentación",
  hospedaje: "Hospedaje",
  arriendo_auto: "Arriendo de vehículo",
  pasajes: "Pasajes",
  pasajes_aereos: "Pasajes aéreos",
  pasajes_terrestres: "Pasajes terrestres",
  transfer: "Traslado",
  peajes: "Peajes",
  combustible: "Combustible",
  estacionamiento: "Estacionamiento",
  taxi_apps: "Taxi y apps de transporte",
  hardware: "Hardware y equipos",
  software: "Software y suscripciones",
  materiales: "Materiales e insumos",
  envios: "Envíos y courier",
  otros: "Otros",
});

/** Grupos del selector. `pasajes` no entra: sigue siendo válido al leer. */
const EXPENSE_CATEGORY_GROUPS = Object.freeze([
  Object.freeze({
    id: "viaje",
    label: "Viaje y estadía",
    codes: Object.freeze([
      EXPENSE_CATEGORY.HOSPEDAJE,
      EXPENSE_CATEGORY.COMIDAS,
      EXPENSE_CATEGORY.PASAJES_AEREOS,
      EXPENSE_CATEGORY.PASAJES_TERRESTRES,
      EXPENSE_CATEGORY.TRANSFER,
    ]),
  }),
  Object.freeze({
    id: "vehiculo",
    label: "Vehículo",
    codes: Object.freeze([
      EXPENSE_CATEGORY.COMBUSTIBLE,
      EXPENSE_CATEGORY.PEAJES,
      EXPENSE_CATEGORY.ESTACIONAMIENTO,
      EXPENSE_CATEGORY.ARRIENDO_AUTO,
      EXPENSE_CATEGORY.TAXI_APPS,
    ]),
  }),
  Object.freeze({
    id: "equipos",
    label: "Comunicaciones y equipos",
    codes: Object.freeze([
      EXPENSE_CATEGORY.TELEFONO,
      EXPENSE_CATEGORY.HARDWARE,
      EXPENSE_CATEGORY.SOFTWARE,
    ]),
  }),
  Object.freeze({
    id: "otros",
    label: "Otros",
    codes: Object.freeze([
      EXPENSE_CATEGORY.MATERIALES,
      EXPENSE_CATEGORY.ENVIOS,
      EXPENSE_CATEGORY.OTROS,
    ]),
  }),
]);

const ALL_EXPENSE_CATEGORIES = Object.freeze(Object.values(EXPENSE_CATEGORY));

const HIDDEN_EXPENSE_CATEGORIES = Object.freeze([EXPENSE_CATEGORY.PASAJES]);

/** Tope de días de hospedaje en una sola línea. */
const MAX_LODGING_DAYS = 365;

function isExpenseCategory(value) {
  return ALL_EXPENSE_CATEGORIES.includes(value);
}

function isSelectableCategory(value) {
  return isExpenseCategory(value) && !HIDDEN_EXPENSE_CATEGORIES.includes(value);
}

function expenseCategoryLabel(value) {
  return EXPENSE_CATEGORY_LABELS[value] || "—";
}

function categoryRequiresDays(value) {
  return value === EXPENSE_CATEGORY.HOSPEDAJE;
}

function categoryRequiresFuel(value) {
  return value === EXPENSE_CATEGORY.COMBUSTIBLE;
}

function parsePositiveDecimal(value, max) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const n = Number(
    raw.replace(/\s/g, "").replace(/\.(?=\d{3}\b)/g, "").replace(",", "."),
  );
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return Math.round(n * 10000) / 10000;
}

function computeFuelLiters(yieldKmL, distanceKm) {
  if (!yieldKmL || !distanceKm) return null;
  return Math.round((distanceKm / yieldKmL) * 100) / 100;
}

function computeFuelAmount(liters, pricePerLiter) {
  if (liters == null || !pricePerLiter) return null;
  return Math.round(liters * pricePerLiter * 100) / 100;
}

/**
 * Extra de combustible. En un envío los tres números son obligatorios; en un
 * borrador se guarda lo que haya. Litros y monto se recalculan aquí: el
 * cliente no puede mandar otra cifra.
 */
function normalizeFuelDetails(raw, { required } = {}) {
  const source = raw && typeof raw === "object" ? raw.details || raw : {};
  const yieldKmL = parsePositiveDecimal(source.yield_km_l, 999);
  const distanceKm = parsePositiveDecimal(source.distance_km, 999999);
  const pricePerLiter = parsePositiveDecimal(source.price_per_liter, 1e7);

  if (yieldKmL == null && distanceKm == null && pricePerLiter == null) {
    if (required) return { ok: false, error: "missing" };
    return { ok: true, details: null };
  }

  if (yieldKmL == null || distanceKm == null || pricePerLiter == null) {
    if (required) return { ok: false, error: "missing" };
    return {
      ok: true,
      details: {
        yield_km_l: yieldKmL,
        distance_km: distanceKm,
        price_per_liter: pricePerLiter,
        liters: computeFuelLiters(yieldKmL, distanceKm),
      },
    };
  }

  return {
    ok: true,
    details: {
      yield_km_l: yieldKmL,
      distance_km: distanceKm,
      price_per_liter: pricePerLiter,
      liters: computeFuelLiters(yieldKmL, distanceKm),
    },
  };
}

function formatDecimal(value) {
  if (value == null || value === "") return "";
  const n = Number(value);
  if (!Number.isFinite(n)) return "";
  return String(n).replace(".", ",");
}

function formatFuelDetails(details, formatMoneyFn) {
  if (!details || details.yield_km_l == null) return "";
  const precio =
    typeof formatMoneyFn === "function"
      ? formatMoneyFn(details.price_per_liter)
      : formatDecimal(details.price_per_liter);
  const partes = [
    `${formatDecimal(details.yield_km_l)} km/L`,
    `${formatDecimal(details.distance_km)} km`,
    `${precio}/L`,
  ];
  return partes.join(" · ");
}

module.exports = {
  EXPENSE_CATEGORY,
  EXPENSE_CATEGORY_LABELS,
  EXPENSE_CATEGORY_GROUPS,
  ALL_EXPENSE_CATEGORIES,
  HIDDEN_EXPENSE_CATEGORIES,
  MAX_LODGING_DAYS,
  isExpenseCategory,
  isSelectableCategory,
  expenseCategoryLabel,
  categoryRequiresDays,
  categoryRequiresFuel,
  parsePositiveDecimal,
  computeFuelLiters,
  computeFuelAmount,
  normalizeFuelDetails,
  formatDecimal,
  formatFuelDetails,
};
