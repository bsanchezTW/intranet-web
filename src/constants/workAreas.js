/**
 * Colores de áreas de trabajo: hex persistido en work_areas.color.
 * Los chips derivan fondo y texto de matiz/saturación para que el modo
 * oscuro no necesite un par de hex por área.
 *
 * El id público es un entero de 4 dígitos (1111–9999), no IDENTITY 1, 2, 3.
 */

const DEFAULT_COLOR = "#5a6879";

const WORK_AREA_ID_MIN = 1111;
const WORK_AREA_ID_MAX = 9999;

function isWorkAreaPublicId(id) {
  const n = Number(id);
  return Number.isInteger(n) && n >= WORK_AREA_ID_MIN && n <= WORK_AREA_ID_MAX;
}

/** Rango de marcas diacríticas combinantes que deja `normalize("NFD")`. */
const COMBINING_MARKS = /[̀-ͯ]/g;

/**
 * Minúsculas y sin diacríticos, para comparar nombres escritos a mano.
 * `area_name` se teclea en el modal de áreas, así que conviven "Informática",
 * "Informatica" y "TI"; compararlos en crudo perdería coincidencias.
 */
function normalizeAreaName(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .trim()
    .toLowerCase();
}

/**
 * Slug estable de un área. Resuelve los enlaces históricos de /procesos
 * (`/procesos/procedimientos/logistica`) contra el área real, y el backfill
 * de documents.work_area_id contra los `type` legacy.
 */
function areaSlug(areaName) {
  return normalizeAreaName(areaName)
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

const WORK_AREA_HSL = {
  Informática: { h: 142, s: 55 },
  Logística: { h: 258, s: 58 },
  Bodega: { h: 38, s: 72 },
  Comercial: { h: 48, s: 68 },
  Ventas: { h: 25, s: 75 },
  "Control y Gestión": { h: 232, s: 58 },
  Eléctrica: { h: 190, s: 68 },
  Finanzas: { h: 330, s: 62 },
  Gerencia: { h: 292, s: 58 },
  Marketing: { h: 200, s: 72 },
  Tramonto: { h: 172, s: 62 },
};

function hslToHex(h, sPercent, lPercent = 45) {
  const hue = Number(h);
  const s = Number(sPercent) / 100;
  const l = Number(lPercent) / 100;
  if (!Number.isFinite(hue) || !Number.isFinite(s) || !Number.isFinite(l)) {
    return DEFAULT_COLOR;
  }
  const a = s * Math.min(l, 1 - l);
  const f = (n) => {
    const k = (n + hue / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

function normalizeHex(value) {
  if (value == null) return null;
  const raw = String(value).trim();
  const match = raw.match(/^#?([0-9a-fA-F]{6})$/);
  if (!match) return null;
  return `#${match[1].toLowerCase()}`;
}

function hexToHsl(hex) {
  const n = normalizeHex(hex);
  if (!n) return { h: 215, s: 16 };
  const r = parseInt(n.slice(1, 3), 16) / 255;
  const g = parseInt(n.slice(3, 5), 16) / 255;
  const b = parseInt(n.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = l === 0 || l === 1 ? 0 : d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r:
        h = ((g - b) / d) % 6;
        break;
      case g:
        h = (b - r) / d + 2;
        break;
      default:
        h = (r - g) / d + 4;
    }
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: Math.round(h), s: Math.round(s * 100) };
}

function pillStyleFromHex(hex) {
  const { h, s } = hexToHsl(hex);
  return `--pill-h: ${h}; --pill-s: ${s}%;`;
}

const WORK_AREA_COLORS = Object.fromEntries(
  Object.entries(WORK_AREA_HSL).map(([name, { h, s }]) => [
    name,
    hslToHex(h, s),
  ]),
);

const WORK_AREA_COLOR_LOOKUP = Object.fromEntries(
  Object.entries(WORK_AREA_COLORS).map(([name, hex]) => [
    name.toLowerCase(),
    hex,
  ]),
);
WORK_AREA_COLOR_LOOKUP.ti = WORK_AREA_COLORS.Informática;
WORK_AREA_COLOR_LOOKUP.informatica = WORK_AREA_COLORS.Informática;

const COLOR_PALETTE = [
  ...Object.entries(WORK_AREA_HSL).map(([label, { h, s }]) => ({
    hex: hslToHex(h, s),
    label,
  })),
  { hex: DEFAULT_COLOR, label: "Gris" },
];

function getColorForAreaName(areaName) {
  if (!areaName) return DEFAULT_COLOR;
  const found = WORK_AREA_COLOR_LOOKUP[String(areaName).trim().toLowerCase()];
  return found || DEFAULT_COLOR;
}

function resolveAreaColor(color, areaName) {
  const stored = normalizeHex(color);
  if (stored && stored !== DEFAULT_COLOR) return stored;
  const byName = getColorForAreaName(areaName);
  if (byName !== DEFAULT_COLOR) return byName;
  return stored || DEFAULT_COLOR;
}

function getWorkAreaPill(areaName, color) {
  if (!areaName || areaName === "-") {
    return {
      pillClass: "pill pill-area pill-area-default",
      pillStyle: pillStyleFromHex(DEFAULT_COLOR),
      color: DEFAULT_COLOR,
    };
  }
  const hex = resolveAreaColor(color, areaName);
  return {
    pillClass: "pill pill-area",
    pillStyle: pillStyleFromHex(hex),
    color: hex,
  };
}

function getWorkAreaPillClass(areaName, color) {
  return getWorkAreaPill(areaName, color).pillClass;
}

function enrichAreaWithPill(area) {
  const pill = getWorkAreaPill(area.area_name, area.color);
  return {
    ...area,
    color: pill.color,
    pillClass: pill.pillClass,
    pillStyle: pill.pillStyle,
  };
}

module.exports = {
  DEFAULT_COLOR,
  WORK_AREA_ID_MIN,
  WORK_AREA_ID_MAX,
  isWorkAreaPublicId,
  normalizeAreaName,
  areaSlug,
  WORK_AREA_HSL,
  WORK_AREA_COLORS,
  COLOR_PALETTE,
  hslToHex,
  hexToHsl,
  normalizeHex,
  resolveAreaColor,
  getWorkAreaPill,
  getWorkAreaPillClass,
  enrichAreaWithPill,
};
