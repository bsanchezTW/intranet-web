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

/**
 * Respuesta de cada ítem: ¿está operativo? Como en la planilla, Sí / No /
 * N/A. Los valores guardados (ok, falla, na) no cambian con las etiquetas.
 */
const ANSWERS = Object.freeze([
  { value: "ok", label: "Sí", short: "Sí" },
  { value: "falla", label: "No", short: "No" },
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
 * Resultado de la revisión: un "No" (no operativo) en un ítem crítico deja
 * el vehículo fuera de servicio; en uno no crítico permite salir, pero queda
 * anotado. `answers`: [{ critical, answer }].
 */
function computeResult(answers) {
  const fallas = (answers || []).filter((a) => a.answer === "falla");
  if (fallas.some((a) => a.critical)) return "no_apto";
  if (fallas.length) return "observado";
  return "apto";
}

/**
 * Plantilla inicial: el «Check list diario» en papel de Logística, con sus
 * categorías y en su orden. Se inserta una sola vez (si la tabla está vacía)
 * y después se administra desde /logistica/checklists/plantilla.
 *
 * Diferencias con la hoja: "Nivel líquido de frenos" era un encabezado con
 * dos ítems de frenos y queda dentro de Frenos; los dos "Estado de llantas"
 * se separan en delanteras y traseras; "Fugas de aceite" pasa a "Sin fugas
 * de aceite" para que Sí sea lo bueno, como en el resto. La hoja no marca
 * críticos: lo son los que impiden circular con seguridad (frenos, llantas,
 * dirección, luces de freno y extintor), y se cambian en la plantilla.
 *
 * Los documentos (revisión técnica, gases, permiso, seguro) y la próxima
 * mantención no son ítems: son datos del vehículo en la flota, y cada
 * checklist los guarda como estaban ese día.
 */
function defaultTemplate() {
  const groups = [
    ["Sistema de luces", [
      ["Luces bajas", false],
      ["Luces altas", false],
      ["Luces de frenos", true],
      ["Luces de retroceso", false],
      ["Intermitentes", false],
      ["Foco faenero", false],
      ["Luces interior cabina", false],
    ]],
    ["Sistema motor", [
      ["Nivel de batería", false],
      ["Chapa de arranque", false],
    ]],
    ["Frenos", [
      ["Frenos", true],
      ["Freno de mano", true],
      ["Nivel de líquido de frenos", true],
    ]],
    ["Neumáticos", [
      ["Estado de llantas delanteras", true],
      ["Estado de llantas traseras", true],
      ["Neumático de repuesto", false],
      ["Llave de rueda de repuesto", false],
    ]],
    ["Carrocería y chasis", [
      ["Carrocería", false],
      ["Funcionamiento de pedales", false],
      ["Pintura general", false],
      ["Amortiguación delantera", false],
      ["Amortiguación trasera", false],
      ["Logo de la empresa", false],
      ["Seguros y chapas", false],
    ]],
    ["Dirección", [
      ["Dirección", true],
      ["Tren delantero", true],
    ]],
    ["Líquidos y filtros", [
      ["Líquidos", false],
      ["Mangueras", false],
      ["Nivel de aceite", false],
      ["Nivel de radiador", false],
      ["Filtro de aire motor", false],
      ["Filtro de aceite", false],
      ["Filtros de combustible", false],
    ]],
    ["Transmisión", [
      ["Caja de cambios", false],
      ["Sin fugas de aceite", false],
    ]],
    ["Accesorios", [
      ["Tacómetro", false],
      ["Alarmas", false],
      ["Chapas", false],
      ["Laterales", false],
      ["Espejos panorámicos", false],
      ["Vidrios", false],
      ["Asientos", false],
      ["Calefacción", false],
      ["Aire acondicionado", false],
      ["Antena radial", false],
      ["Extintor", true],
      ["Seguridad", false],
      ["Chaleco y triángulos", false],
    ]],
    ["Implementos", [
      ["Gata y accesorios", false],
      ["Cuñas", false],
      ["Botiquín", false],
      ["Eslingas", false],
      ["Caja de herramientas Bauker (116 piezas)", false],
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

/**
 * Textos de la plantilla provisoria que se sembró antes de tener la hoja
 * real (Chile y Perú). Si la tabla tiene sólo estos ítems y nunca se
 * registró un checklist, se reemplaza por defaultTemplate().
 */
const PROVISIONAL_TEMPLATE_LABELS = Object.freeze([
  "Permiso de circulación vigente", "Tarjeta de identificación vehicular", "Revisión técnica vigente",
  "Seguro obligatorio (SOAP) vigente", "SOAT vigente", "Licencia de conducir del conductor vigente",
  "Luces altas y bajas", "Intermitentes y luces de emergencia", "Luces de freno y de retroceso",
  "Estado de los neumáticos (desgaste, cortes)", "Presión de los neumáticos", "Neumático de repuesto",
  "Nivel de aceite", "Líquido refrigerante", "Líquido de frenos", "Agua del limpiaparabrisas",
  "Sin fugas visibles bajo el vehículo", "Freno de servicio", "Freno de mano", "Dirección sin juego ni ruidos",
  "Cinturones de seguridad", "Bocina", "Espejos retrovisores", "Limpiaparabrisas", "Parabrisas sin trizaduras",
  "Tablero sin luces de advertencia", "Extintor cargado y vigente", "Botiquín", "Triángulos o conos de seguridad",
  "Chaleco reflectante", "Gata y llave de ruedas", "Carrocería sin daños nuevos", "Limpieza interior y exterior",
]);

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
  PROVISIONAL_TEMPLATE_LABELS,
};
