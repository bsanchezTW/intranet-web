const https = require('https');
const { getCountryConfig } = require('../config/country');
const logger = require('../utils/logger');

const REQUEST_TIMEOUT_MS = 8000;
// El BCRP publica con un día de atraso y salta feriados: tres semanas dan de
// sobra los dos últimos valores para la tendencia.
const BCRP_LOOKBACK_DAYS = 21;
const BCRP_SERIES = { dolar: 'PD04640PD', euro: 'PD04648PD' };
const OPEN_ER_URL = 'https://open.er-api.com/v6/latest/USD';

const EMPTY = { valor: null, valorAyer: null };

// Último valor bueno de cada indicador: si un ciclo falla se sigue mostrando.
let lastKnown = {};

function getJson(url) {
  return new Promise((resolve, reject) => {
    const options = {
        headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
    };

    const req = https.get(url, options, (res) => {
      if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`API respondió con estado ${res.statusCode}`));
      }

      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (e) { reject(e); }
      });
    });
    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy();
      reject(new Error(`Timeout obteniendo ${url}`));
    });
    req.on('error', reject);
  });
}

function describeFailure(error) {
  const message = String((error && error.message) || error);
  if (/timeout/i.test(message)) return 'timeout';
  if (/hang up|TLS|disconnected|ECONNRESET/i.test(message)) return 'red';
  return message;
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

// --- Formatos de cada API -----------------------------------------------------

function parseMindicador(data) {
  const serie = Array.isArray(data?.serie) ? data.serie : [];
  const hoy = serie[0];
  if (!hoy || !Number(hoy.valor)) return null;
  const ayer = serie[1] || hoy;
  return { valor: Number(hoy.valor), valorAyer: Number(ayer.valor) };
}

/** Los días sin dato vienen como "n.d."; la serie va de antiguo a reciente. */
function parseBcrp(data) {
  const periods = Array.isArray(data?.periods) ? data.periods : [];
  const values = periods
    .map((p) => Number(Array.isArray(p.values) ? p.values[0] : NaN))
    .filter((v) => Number.isFinite(v) && v > 0);
  if (values.length === 0) return null;
  const valor = values[values.length - 1];
  const valorAyer = values.length > 1 ? values[values.length - 2] : valor;
  return { valor, valorAyer };
}

/**
 * open.er-api da un solo valor diario por moneda, con base USD. Sin el valor
 * anterior la tendencia queda "igual". No sirve para la UF: su CLF se desvía
 * varios puntos de la UF oficial, y es mejor mostrar "—" que un monto falso.
 */
function parseOpenEr(data) {
  const rates = data && data.result === 'success' ? data.rates : null;
  const clp = Number(rates && rates.CLP);
  if (!clp) return {};
  const eur = Number(rates.EUR);
  return {
    dolar: { valor: round(clp, 2), valorAyer: null },
    euro: eur ? { valor: round(clp / eur, 2), valorAyer: null } : null,
  };
}

function bcrpUrl(serie, now) {
  const end = new Date(now);
  const start = new Date(now - BCRP_LOOKBACK_DAYS * 24 * 60 * 60 * 1000);
  const day = (d) => d.toISOString().slice(0, 10);
  return `https://estadisticas.bcrp.gob.pe/estadisticas/series/api/${serie}/json/${day(start)}/${day(end)}`;
}

// --- Proveedores por país -----------------------------------------------------

/** Pide cada código por separado; devuelve lo que llegó y por qué falló el resto. */
async function fetchEach(codigos, urlOf, parse, fetchJson) {
  const settled = await Promise.allSettled(codigos.map((c) => fetchJson(urlOf(c))));
  const values = {};
  const failures = [];
  settled.forEach((r, i) => {
    const dato = r.status === 'fulfilled' ? parse(r.value) : null;
    if (dato) values[codigos[i]] = dato;
    else failures.push(`${codigos[i]} ${r.status === 'rejected' ? describeFailure(r.reason) : 'sin datos'}`);
  });
  return { values, failures };
}

const PROVIDERS = {
  // Chile: mindicador.cl y, para lo que no responda, open.er-api.
  async mindicador({ codigos, fetchJson }) {
    const primary = await fetchEach(
      codigos,
      (c) => `https://mindicador.cl/api/${c}`,
      parseMindicador,
      fetchJson,
    );
    const missing = codigos.filter((c) => !primary.values[c]);
    if (missing.length === 0) return primary.values;

    let fallback = {};
    let fallbackFailure = null;
    try {
      fallback = parseOpenEr(await fetchJson(OPEN_ER_URL));
    } catch (err) {
      fallbackFailure = describeFailure(err);
    }
    const recovered = missing.filter((c) => fallback[c]);
    const lost = missing.filter((c) => !fallback[c]);

    const parts = [`mindicador sin respuesta (${primary.failures.join(', ')})`];
    if (recovered.length) parts.push(`${recovered.join(', ')} desde open.er-api`);
    if (lost.length) parts.push(`${lost.join(', ')} sin dato${fallbackFailure ? ` (open.er-api ${fallbackFailure})` : ''}`);
    logger.warn('finanzas', parts.join('; '));

    const values = { ...primary.values };
    for (const c of recovered) values[c] = fallback[c];
    return values;
  },

  // Perú: series del BCRP en soles. No hay UF.
  async bcrp({ codigos, fetchJson, now }) {
    const wanted = codigos.filter((c) => BCRP_SERIES[c]);
    const { values, failures } = await fetchEach(
      wanted,
      (c) => bcrpUrl(BCRP_SERIES[c], now),
      parseBcrp,
      fetchJson,
    );
    if (failures.length) logger.warn('finanzas', `BCRP sin respuesta (${failures.join(', ')})`);
    return values;
  },
};

/** Una vuelta a la fuente del país, sin memoria. Lo que falte queda fuera. */
async function fetchIndicadores({
  includeUf = true,
  country,
  fetchJson = getJson,
  now = Date.now(),
} = {}) {
  const { indicators } = getCountryConfig(country);
  const provider = PROVIDERS[indicators.source];
  const codigos = includeUf ? ['dolar', 'euro', 'uf'] : ['dolar', 'euro'];
  return provider({ codigos, fetchJson, now });
}

async function getIndicadores({ includeUf = true } = {}) {
  let fresh = {};
  try {
    fresh = await fetchIndicadores({ includeUf });
  } catch (err) {
    logger.warn('finanzas', err);
  }
  lastKnown = { ...lastKnown, ...fresh };
  return {
    dolar: lastKnown.dolar || EMPTY,
    euro: lastKnown.euro || EMPTY,
    uf: includeUf ? lastKnown.uf || EMPTY : EMPTY,
  };
}

module.exports = {
  getIndicadores,
  fetchIndicadores,
  parseMindicador,
  parseBcrp,
  parseOpenEr,
  bcrpUrl,
};
