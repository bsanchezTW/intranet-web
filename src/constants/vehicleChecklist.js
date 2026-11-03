/**
 * Checklist de vehículos (Logística): catálogos, numeración y la regla del
 * resultado. Puro, para usarlo en el servicio, las vistas, el PDF y los tests.
 */

const { getLocale } = require("../config/country");

/** Momento de la revisión. */
const INSPECTION_KINDS = Object.freeze([
  { value: "salida", label: "Antes de salir" },
  { value: "retorno", label: "Al regresar" },
  { value: "periodica", label: "Revisión periódica" },
]);

/** Respuesta de cada ítem. */
const ANSWERS = Object.freeze([
  { value: "ok", label: "Bien", short: "OK" },
  { value: "falla", label: "Con falla", short: "Falla" },
  { value: "na", label: "No aplica", short: "N/A" },
]);

const RESULTS = Object.freeze({
  apto: { key: "apto", label: "Apto" },
  observado: { key: "observado", label: "Apto con observaciones" },
  no_apto: { key: "no_apto", label: "No apto" },
});

/** Nivel de combustible al revisar (opcional). */
const FUEL_LEVELS = Object.freeze(["Reserva", "1/4", "1/2", "3/4", "Lleno"]);

const VEHICLE_KINDS = Object.freeze([
  { value: "camioneta", label: "Camioneta" },
  { value: "furgon", label: "Furgón" },
  { value: "camion", label: "Camión" },
  { value: "automovil", label: "Automóvil" },
  { value: "motocicleta", label: "Motocicleta" },
  { value: "otro", label: "Otro" },
]);

const MAX_SEQ = 99999;

function labelFrom(list, value) {
  const found = list.find((item) => item.value === value);
  return found ? found.label : value || "";
}

/** "45.230 km" con los separadores del país; "—" sin dato. */
function formatKm(value) {
  if (value == null || value === "") return "—";
  return `${Number(value).toLocaleString(getLocale())} km`;
}

/** CV-00001-2026 */
function formatChecklistNumber(year, seq) {
  return `CV-${String(seq).padStart(5, "0")}-${year}`;
}

/**
 * Resultado de la revisión: una falla en un ítem crítico deja el vehículo
 * fuera de servicio; una falla en uno no crítico permite salir, pero queda
 * anotada. `answers`: [{ critical, answer }].
 */
function computeResult(answers) {
  const fallas = (answers || []).filter((a) => a.answer === "falla");
  if (fallas.some((a) => a.critical)) return "no_apto";
  if (fallas.length) return "observado";
  return "apto";
}

/**
 * Plantilla inicial, mientras no se carguen los ítems de la planilla Excel de
 * Logística. Se inserta una sola vez (si la tabla está vacía) y después se
 * administra desde /logistica/checklists/plantilla. Los documentos del
 * vehículo cambian de nombre según el país.
 */
function defaultTemplate(countryCode) {
  const peru = String(countryCode).toUpperCase() === "PE";
  const groups = [
    ["Documentación", [
      [peru ? "Tarjeta de identificación vehicular" : "Permiso de circulación vigente", true],
      ["Revisión técnica vigente", true],
      [peru ? "SOAT vigente" : "Seguro obligatorio (SOAP) vigente", true],
      ["Licencia de conducir del conductor vigente", true],
    ]],
    ["Luces", [
      ["Luces altas y bajas", false],
      ["Intermitentes y luces de emergencia", false],
      ["Luces de freno y de retroceso", true],
    ]],
    ["Neumáticos", [
      ["Estado de los neumáticos (desgaste, cortes)", true],
      ["Presión de los neumáticos", false],
      ["Neumático de repuesto", false],
    ]],
    ["Motor y niveles", [
      ["Nivel de aceite", false],
      ["Líquido refrigerante", false],
      ["Líquido de frenos", true],
      ["Agua del limpiaparabrisas", false],
      ["Sin fugas visibles bajo el vehículo", false],
    ]],
    ["Frenos y dirección", [
      ["Freno de servicio", true],
      ["Freno de mano", true],
      ["Dirección sin juego ni ruidos", true],
    ]],
    ["Cabina", [
      ["Cinturones de seguridad", true],
      ["Bocina", false],
      ["Espejos retrovisores", false],
      ["Limpiaparabrisas", false],
      ["Parabrisas sin trizaduras", false],
      ["Tablero sin luces de advertencia", false],
    ]],
    ["Equipamiento de seguridad", [
      ["Extintor cargado y vigente", true],
      ["Botiquín", false],
      ["Triángulos o conos de seguridad", false],
      ["Chaleco reflectante", false],
      ["Gata y llave de ruedas", false],
    ]],
    ["Carrocería", [
      ["Carrocería sin daños nuevos", false],
      ["Limpieza interior y exterior", false],
    ]],
  ];
  const items = [];
  for (const [category, rows] of groups) {
    for (const [label, critical] of rows) {
      items.push({ category, label, critical, sort_order: (items.length + 1) * 10 });
    }
  }
  return items;
}

module.exports = {
  INSPECTION_KINDS,
  ANSWERS,
  RESULTS,
  FUEL_LEVELS,
  VEHICLE_KINDS,
  MAX_SEQ,
  labelFrom,
  formatKm,
  formatChecklistNumber,
  computeResult,
  defaultTemplate,
};
