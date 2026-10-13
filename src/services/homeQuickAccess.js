/**
 * Accesos rápidos del home.
 *
 * El catálogo es cerrado por país. La preferencia de la persona sólo oculta
 * y reordena ids de ese catálogo. NULL (o el equivalente al orden del país,
 * sin ocultos) significa «todos visibles, en el orden del país».
 *
 * Un id que entra al catálogo después de que alguien guardó su orden, y que
 * no está en `hidden`, queda al final de los visibles si todavía hay cupo.
 * La barra muestra como máximo VISIBLE_LIMIT iconos; el resto pasa a ocultos.
 * Los ids de otro país se descartan.
 */

const VISIBLE_LIMIT = 6;

const COUNTRY_ORDER = Object.freeze({
  CL: Object.freeze([
    "site",
    "academy",
    "rex",
    "achs",
    "caja",
    "soporte",
    "organigrama",
    "noticias",
    "galeria",
    "apps",
    "rendiciones",
  ]),
  PE: Object.freeze([
    "site",
    "academy",
    "vacaciones",
    "organigrama",
    "noticias",
    "galeria",
    "apps",
  ]),
});

const ITEMS = Object.freeze({
  site: {
    id: "site",
    label: null,
    href: null,
    external: true,
    glyph: { kind: "img", src: "/img/favicon.png", tone: "brand" },
  },
  academy: {
    id: "academy",
    label: "Academy",
    href: "/cursos",
    glyph: { kind: "img", src: "/img/academy-logo.png", tone: "green" },
  },
  rex: {
    id: "rex",
    label: "Rex+",
    href: "https://transworld.mirexmas.com/",
    external: true,
    feature: "chileHrPortals",
    glyph: { kind: "img", src: "/img/rex-logo.png", tone: "sky" },
  },
  achs: {
    id: "achs",
    label: "ACHS",
    href: "https://www.achs.cl/",
    external: true,
    feature: "chileHrPortals",
    glyph: { kind: "img", src: "/img/achs.png", tone: "mint" },
  },
  caja: {
    id: "caja",
    label: "Caja L.A.",
    href: "https://www.cajalosandes.cl/",
    external: true,
    feature: "chileHrPortals",
    glyph: { kind: "img", src: "/img/cajalosandes.png", tone: "indigo" },
  },
  soporte: {
    id: "soporte",
    label: "Soporte",
    href: "/soporte",
    feature: "supportTickets",
    notif: true,
    glyph: { kind: "text", text: "✚", tone: "muted" },
  },
  vacaciones: {
    id: "vacaciones",
    label: "Vacaciones",
    href: "/RRHH/vacaciones",
    feature: "vacations",
    glyph: { kind: "icon", name: "calendar", tone: "sky" },
  },
  organigrama: {
    id: "organigrama",
    label: "Organigrama",
    href: "/RRHH/organigrama",
    glyph: { kind: "icon", name: "users", tone: "indigo" },
  },
  noticias: {
    id: "noticias",
    label: "Noticias",
    href: "/noticias",
    glyph: { kind: "icon", name: "news", tone: "brand" },
  },
  galeria: {
    id: "galeria",
    label: "Galería",
    href: "/marketing/eventos",
    glyph: { kind: "icon", name: "camera", tone: "mint" },
  },
  apps: {
    id: "apps",
    label: "Apps",
    href: "/apps",
    glyph: { kind: "icon", name: "grid", tone: "green" },
  },
  rendiciones: {
    id: "rendiciones",
    label: "Rendiciones",
    href: "/gastos/nueva/rendicion",
    feature: "expenseRequests",
    glyph: { kind: "icon", name: "receipt", tone: "mint" },
  },
});

function siteLabel(corporateSite) {
  try {
    return new URL(corporateSite).hostname.replace(/^www\./, "");
  } catch {
    return "Sitio";
  }
}

function presentItem(item, corporateSite) {
  const isSite = item.id === "site";
  return {
    id: item.id,
    label: isSite ? siteLabel(corporateSite) : item.label,
    href: isSite ? corporateSite : item.href,
    external: Boolean(item.external),
    notif: Boolean(item.notif),
    glyph: item.glyph,
  };
}

function isAvailable(item, features) {
  if (!item.feature) return true;
  return Boolean(features && features[item.feature]);
}

/** Lista del país, en el orden por defecto, ya filtrada por features. */
function catalogForCountry(countryCode, features, corporateSite) {
  const code = String(countryCode || "").toUpperCase();
  const order = COUNTRY_ORDER[code];
  if (!order) {
    throw new Error(`País sin accesos rápidos: ${countryCode}`);
  }
  return order
    .map((id) => ITEMS[id])
    .filter((item) => item && isAvailable(item, features))
    .map((item) => presentItem(item, corporateSite));
}

function asIdList(value) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of value) {
    const id = String(raw || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** Acepta el jsonb de la cuenta, un objeto o un string JSON. */
function readPreference(value) {
  if (value == null || value === "") return null;
  let data = value;
  if (typeof value === "string") {
    try {
      data = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  return {
    order: asIdList(data.order),
    hidden: asIdList(data.hidden),
  };
}

/**
 * Parte del catálogo del país, quita `hidden`, respeta `order` y deja al
 * final los ids del catálogo que no están ni ordenados ni ocultos.
 */
function resolveHomeQuickAccess({
  countryCode,
  features,
  preference,
  corporateSite,
}) {
  const catalog = catalogForCountry(countryCode, features, corporateSite);
  const byId = new Map(catalog.map((item) => [item.id, item]));
  const allowed = new Set(byId.keys());
  const stored = readPreference(preference);

  if (!stored) {
    const placed = capVisible(catalog, []);
    return {
      visible: placed.visible,
      hidden: placed.hidden,
      defaults: catalog.map((item) => item.id),
    };
  }

  const hiddenIds = new Set(stored.hidden.filter((id) => allowed.has(id)));
  const visible = [];
  const seen = new Set();

  for (const id of stored.order) {
    if (!allowed.has(id) || hiddenIds.has(id) || seen.has(id)) continue;
    visible.push(byId.get(id));
    seen.add(id);
  }

  for (const item of catalog) {
    if (hiddenIds.has(item.id) || seen.has(item.id)) continue;
    visible.push(item);
    seen.add(item.id);
  }

  const placed = capVisible(
    visible,
    catalog.filter((item) => hiddenIds.has(item.id)),
  );

  return {
    visible: placed.visible,
    hidden: placed.hidden,
    defaults: catalog.map((item) => item.id),
  };
}

/** Lo que no cabe en la barra queda oculto, conservando el orden. */
function capVisible(visible, hidden) {
  if (visible.length <= VISIBLE_LIMIT) {
    return { visible, hidden };
  }
  return {
    visible: visible.slice(0, VISIBLE_LIMIT),
    hidden: [...visible.slice(VISIBLE_LIMIT), ...hidden],
  };
}

function matchesDefault(order, hidden, catalogIds) {
  const visibleDefault = catalogIds.slice(0, VISIBLE_LIMIT);
  const hiddenDefault = catalogIds.slice(VISIBLE_LIMIT);
  if (order.length === 0 && hidden.length === 0) return true;
  if (order.length !== visibleDefault.length) return false;
  if (hidden.length !== hiddenDefault.length) return false;
  if (!order.every((id, index) => id === visibleDefault[index])) return false;
  return hidden.every((id, index) => id === hiddenDefault[index]);
}

/**
 * Deja sólo ids del catálogo y como máximo VISIBLE_LIMIT visibles. `reset`,
 * o el orden del país (el resto oculto si no cabe), vuelve a NULL.
 */
function sanitizeHomeQuickAccess(input, catalogIds) {
  const allowedIds = asIdList(catalogIds);
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  if (input.reset === true) return null;

  const allowed = new Set(allowedIds);
  const hidden = asIdList(input.hidden).filter((id) => allowed.has(id));
  const hiddenSet = new Set(hidden);
  const order = [];
  for (const id of asIdList(input.order)) {
    if (!allowed.has(id) || hiddenSet.has(id)) continue;
    if (order.length >= VISIBLE_LIMIT) {
      hiddenSet.add(id);
      continue;
    }
    order.push(id);
  }

  const hiddenIds = allowedIds.filter((id) => hiddenSet.has(id));
  if (matchesDefault(order, hiddenIds, allowedIds)) return null;
  return { order, hidden: hiddenIds };
}

module.exports = {
  VISIBLE_LIMIT,
  COUNTRY_ORDER,
  catalogForCountry,
  resolveHomeQuickAccess,
  sanitizeHomeQuickAccess,
};
