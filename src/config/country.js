/**
 * Identidad de país de esta instancia.
 *
 * Cada deployment pertenece a exactamente un país y lo declara con COUNTRY.
 * No es una preferencia del usuario ni un atributo del colaborador: es la
 * identidad de la ejecución completa.
 *
 * Este es el ÚNICO archivo autorizado a leer process.env.COUNTRY. El resto del
 * proyecto usa getCurrentCountry() / getCountryConfig().
 */

const COUNTRY_CODES = ["CL", "PE"];

/** Dominios públicos aceptados al iniciar sesión, comunes a ambos países. */
const PUBLIC_EMAIL_DOMAINS = [
  "gmail.com",
  "icloud.com",
  "outlook.com",
  "outlook.cl",
  "hotmail.com",
  "hotmail.cl",
  "yahoo.com",
  "yahoo.cl",
];

/** Jornada de oficina usada para el SLA de tickets (lun–jue / vie). */
const DEFAULT_BUSINESS_HOURS = {
  weekday: { startHour: 9, startMinute: 0, endHour: 18, endMinute: 30 },
  friday: { startHour: 9, startMinute: 0, endHour: 15, endMinute: 30 },
};

const COUNTRY_CONFIGS = {
  CL: {
    code: "CL",
    name: "Chile",
    timezone: "America/Santiago",
    locale: "es-CL",
    corporateEmailDomain: "transworld.cl",
    // Moneda de los montos del centro de gastos. El peso chileno no usa
    // decimales: mostrarlos convierte "45.000" en un monto que nadie escribe.
    currency: { code: "CLP", symbol: "$", decimals: 0 },
    pageTitleSuffix: "Intranet Transworld Chile",
    sessionCookieName: "tw_sid_cl",
    devPort: 3000,
    businessHours: DEFAULT_BUSINESS_HOURS,
    // Celulares chilenos: +56 9 XXXX XXXX
    phone: {
      callingCode: "56",
      nationalDigits: 9,
      mobileLeadingDigit: "9",
      groups: [1, 4, 4],
      example: "9 1234 5678",
    },
    corporateSite: "https://www.transworld.cl/",
    weather: {
      latitude: -33.3742,
      longitude: -70.6725,
      locationName: "Huechuraba",
      cityLabel: "Huechuraba, Santiago",
      detailUrl:
        "https://www.meteored.cl/tiempo-en_Santiago+de+Chile-America+Sur-Chile-Region+Metropolitana+de+Santiago-SCEL-1-18578.html",
    },
    supportEmail: "soporte@transworld.cl",
    hrEmail: "rrhh@transworld.cl",
    noReplyEmail: "noreply@transworld.cl",
    contactEmail: "contacto@transworld.cl",
  },
  PE: {
    code: "PE",
    name: "Perú",
    timezone: "America/Lima",
    locale: "es-PE",
    corporateEmailDomain: "transworld.pe",
    currency: { code: "PEN", symbol: "S/", decimals: 2 },
    pageTitleSuffix: "Intranet Transworld Perú",
    sessionCookieName: "tw_sid_pe",
    devPort: 3001,
    // TODO(RRHH Perú): confirmar la jornada real de la oficina de Lima.
    businessHours: DEFAULT_BUSINESS_HOURS,
    // Celulares peruanos: +51 XXX XXX XXX (9 dígitos, empiezan en 9)
    phone: {
      callingCode: "51",
      nationalDigits: 9,
      mobileLeadingDigit: "9",
      groups: [3, 3, 3],
      example: "987 654 321",
    },
    corporateSite: "https://www.transworld.cl/",
    weather: {
      latitude: -12.0464,
      longitude: -77.0428,
      locationName: "Lima",
      cityLabel: "Lima",
      detailUrl:
        "https://www.meteored.pe/tiempo-en_Lima-America+Sur-Peru-Provincia+de+Lima-SPIM-1-16982.html",
    },
    // TODO(TI Perú): confirmar las casillas locales antes de salir a producción.
    supportEmail: "soporte@transworld.pe",
    hrEmail: "rrhh@transworld.pe",
    noReplyEmail: "noreply@transworld.pe",
    contactEmail: "contacto@transworld.pe",
  },
};

/** TLD del otro país: Chile no acepta .pe y Perú no acepta .cl. */
const FOREIGN_EMAIL_TLD = {
  CL: "pe",
  PE: "cl",
};

function isForeignCountryEmailDomain(domain, countryCode) {
  const tld = FOREIGN_EMAIL_TLD[String(countryCode || "").trim().toUpperCase()];
  if (!tld) return false;
  const normalized = String(domain || "").trim().toLowerCase();
  return normalized === tld || normalized.endsWith(`.${tld}`);
}

function publicDomainsForCountry(countryCode) {
  return PUBLIC_EMAIL_DOMAINS.filter(
    (domain) => !isForeignCountryEmailDomain(domain, countryCode),
  );
}

// El dominio corporativo siempre encabeza la lista: es el que el formulario de
// login preselecciona. Los públicos del otro país (p. ej. hotmail.cl en Perú)
// quedan fuera.
for (const config of Object.values(COUNTRY_CONFIGS)) {
  config.forbiddenEmailTld = FOREIGN_EMAIL_TLD[config.code];
  config.allowedLoginDomains = [
    config.corporateEmailDomain,
    ...publicDomainsForCountry(config.code),
  ];
}

function isValidCountryCode(value) {
  return COUNTRY_CODES.includes(String(value || "").trim().toUpperCase());
}

/**
 * País de esta instancia. Sin fallback: si COUNTRY falta o es inválida la
 * aplicación no debe arrancar (la validación vive en config/env.js, esto es la
 * segunda barrera por si alguien requiere este módulo por su cuenta).
 */
function getCurrentCountry() {
  const raw = String(process.env.COUNTRY || "").trim().toUpperCase();
  if (!isValidCountryCode(raw)) {
    throw new Error(
      `COUNTRY inválida o ausente: "${process.env.COUNTRY ?? ""}". ` +
        `Valores admitidos: ${COUNTRY_CODES.join(", ")}.`,
    );
  }
  return raw;
}

function getCountryConfig(countryCode = getCurrentCountry()) {
  const code = String(countryCode || "").trim().toUpperCase();
  const config = COUNTRY_CONFIGS[code];
  if (!config) {
    throw new Error(`País no registrado: ${countryCode}`);
  }
  return config;
}

/** Zona IANA de la instancia. Atajo del uso más frecuente. */
function getTimezone() {
  return getCountryConfig().timezone;
}

/** Locale de la instancia, para Intl y toLocaleString. */
function getLocale() {
  return getCountryConfig().locale;
}

/** Moneda de la instancia: { code, symbol, decimals }. */
function getCurrency() {
  return getCountryConfig().currency;
}

/** Monto formateado con la moneda del país (Intl, sin dependencias). */
function formatMoney(amount, countryCode = getCurrentCountry()) {
  const { code, decimals } = getCountryConfig(countryCode).currency;
  // Number(null) y Number("") son 0: sin este guardia un monto ausente se
  // mostraría como un cero legítimo en vez de como "sin dato".
  if (amount === null || amount === undefined || amount === "") return "—";
  const value = Number(amount);
  if (!Number.isFinite(value)) return "—";
  return new Intl.NumberFormat(getCountryConfig(countryCode).locale, {
    style: "currency",
    currency: code,
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

module.exports = {
  COUNTRY_CODES,
  PUBLIC_EMAIL_DOMAINS,
  FOREIGN_EMAIL_TLD,
  isValidCountryCode,
  isForeignCountryEmailDomain,
  getCurrentCountry,
  getCountryConfig,
  getTimezone,
  getLocale,
  getCurrency,
  formatMoney,
};
