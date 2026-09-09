const dns = require("dns");
const net = require("net");
const { Pool } = require("pg");

if (typeof dns.setDefaultResultOrder === "function") {
  dns.setDefaultResultOrder("ipv4first");
}
if (typeof net.setDefaultAutoSelectFamily === "function") {
  net.setDefaultAutoSelectFamily(false);
}

const {
  postgresStartupOptions,
  searchPathStatement,
} = require("./config/supabaseProjects");
const { isIdPrimaryKeyCollision } = require("./utils/idCollision");
const logger = require("./utils/logger");

const DEFAULT_POOL_MAX = 8;
const DEFAULT_CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_IDLE_TIMEOUT_MS = 30000;

function looksLikeSupabaseHost() {
  const host = process.env.DB_HOST || "";
  const databaseUrl = process.env.DATABASE_URL || "";
  return (
    host.includes("supabase.co") ||
    host.includes("supabase.com") ||
    databaseUrl.includes("supabase.co") ||
    databaseUrl.includes("supabase.com")
  );
}

function resolveSsl() {
  const flag = String(process.env.DB_SSL || "").trim().toLowerCase();
  if (flag === "true" || flag === "1") {
    return { rejectUnauthorized: false };
  }
  if (flag === "false" || flag === "0") {
    return false;
  }

  return looksLikeSupabaseHost() ? { rejectUnauthorized: false } : false;
}

function postgresOptionsForCountry(country = process.env.COUNTRY) {
  const raw = String(country || "").trim();
  if (!raw) return undefined;
  return postgresStartupOptions(raw);
}

function lookupIpv4(hostname, _options, callback) {
  dns.lookup(hostname, { family: 4 }, callback);
}

function poolLimits() {
  const max = Number(process.env.DB_POOL_MAX);
  const connectionTimeoutMillis = Number(process.env.DB_CONNECT_TIMEOUT_MS);
  const idleTimeoutMillis = Number(process.env.DB_IDLE_TIMEOUT_MS);
  return {
    max: Number.isFinite(max) && max > 0 ? max : DEFAULT_POOL_MAX,
    connectionTimeoutMillis: Number.isFinite(connectionTimeoutMillis) && connectionTimeoutMillis > 0
      ? connectionTimeoutMillis
      : DEFAULT_CONNECT_TIMEOUT_MS,
    idleTimeoutMillis: Number.isFinite(idleTimeoutMillis) && idleTimeoutMillis > 0
      ? idleTimeoutMillis
      : DEFAULT_IDLE_TIMEOUT_MS,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
  };
}

function currentPoolPort() {
  if (process.env.DATABASE_URL?.trim()) {
    try {
      return Number(new URL(process.env.DATABASE_URL.trim()).port || 5432);
    } catch {
      return 5432;
    }
  }
  return process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432;
}

function createPool() {
  const ssl = resolveSsl();
  const options = postgresOptionsForCountry();
  const extra = options ? { options } : {};
  const limits = poolLimits();
  const lookup = looksLikeSupabaseHost() ? { lookup: lookupIpv4 } : {};

  if (process.env.DATABASE_URL?.trim()) {
    return new Pool({
      connectionString: process.env.DATABASE_URL.trim(),
      ssl,
      ...extra,
      ...limits,
      ...lookup,
    });
  }

  return new Pool({
    host: process.env.DB_HOST,
    port: currentPoolPort(),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD || process.env.DB_PASS,
    database: process.env.DB_NAME,
    ssl,
    ...extra,
    ...limits,
    ...lookup,
  });
}

function isNetworkUnreachable(err) {
  if (!err) return false;
  const code = err.code;
  if (
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    code === "ENETUNREACH" ||
    code === "EHOSTUNREACH" ||
    code === "EAI_AGAIN"
  ) {
    return true;
  }
  if (Array.isArray(err.errors) && err.errors.some(isNetworkUnreachable)) {
    return true;
  }
  return /ECONNREFUSED|connection timeout|AggregateError/i.test(
    String(err.message || err),
  );
}

function setPoolPort(port) {
  if (process.env.DATABASE_URL?.trim()) {
    try {
      const parsed = new URL(process.env.DATABASE_URL.trim());
      parsed.port = String(port);
      process.env.DATABASE_URL = parsed.toString();
    } catch {
      // DB_PORT cubre el caso de URL ilegible.
    }
  }
  process.env.DB_PORT = String(port);
}

function attachPoolHandlers(target) {
  target.on("connect", (client) => {
    client
      .query(
        "SELECT current_user AS db_user, current_schema() AS schema, inet_server_port() AS port",
      )
      .then((result) => {
        if (firstConnectLogged) return;
        firstConnectLogged = true;
        const row = result.rows[0] || {};
        logger.info(
          "db",
          `conectado ${row.db_user || "?"} schema=${row.schema || "?"} puerto=${row.port || "?"} en ${Date.now() - poolCreatedAt}ms`,
        );
      })
      .catch((error) => {
        if (firstConnectLogged) return;
        firstConnectLogged = true;
        logger.error("db", error);
      });
  });

  target.on("error", (error) => {
    logger.error("db", error);
  });
}

function replacePool(next) {
  const previous = pool;
  pool = next;
  attachPoolHandlers(pool);
  previous.removeAllListeners();
  previous.end().catch(() => {});
}

async function withPoolerPortFallback(operation) {
  try {
    return await operation();
  } catch (err) {
    const from = currentPoolPort();
    const to = from === 5432 ? 6543 : from === 6543 ? 5432 : null;
    if (alternatePortTried || !to || !looksLikeSupabaseHost() || !isNetworkUnreachable(err)) {
      throw err;
    }
    alternatePortTried = true;
    firstConnectLogged = false;
    logger.warn(
      "db",
      `puerto ${from} inalcanzable (${err.code || "sin code"}); reintentando pooler en ${to}`,
    );
    setPoolPort(to);
    replacePool(createPool());
    return operation();
  }
}

async function applySearchPath(client, country = process.env.COUNTRY) {
  await client.query(searchPathStatement(country));
}

let pool = createPool();
const poolCreatedAt = Date.now();
let firstConnectLogged = false;
let alternatePortTried = false;
// El pooler en modo transacción (cPanel → :6543) ignora `options=-c search_path`.
// Si una consulta choca con "relation does not exist", pasamos a SET explícito.
let forceSearchPath = false;

attachPoolHandlers(pool);

function warmPool() {
  withPoolerPortFallback(() => pool.query("SELECT 1")).catch((error) => {
    logger.error("db", error);
  });
}

async function getClient() {
  return withPoolerPortFallback(async () => {
    const client = await pool.connect();
    try {
      await applySearchPath(client);
    } catch (error) {
      client.release();
      throw error;
    }
    return client;
  });
}

function isMissingRelationError(err) {
  return Boolean(err && (err.code === "42P01" || err.code === "3F000"));
}

async function queryWithSearchPath(text, params) {
  const client = await pool.connect();
  try {
    await applySearchPath(client);
    return await client.query(text, params);
  } finally {
    client.release();
  }
}

async function query(text, params) {
  return withPoolerPortFallback(async () => {
    if (forceSearchPath) {
      return queryWithSearchPath(text, params);
    }
    try {
      return await pool.query(text, params);
    } catch (err) {
      if (!isMissingRelationError(err)) throw err;
      forceSearchPath = true;
      logger.warn(
        "db",
        "el pooler no aplicó search_path; se fija el schema del país en cada consulta",
      );
      return queryWithSearchPath(text, params);
    }
  });
}

async function queryRetryIdCollision(text, params, maxAttempts = 8) {
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      return await query(text, params);
    } catch (err) {
      lastErr = err;
      if (!isIdPrimaryKeyCollision(err) || attempt === maxAttempts - 1) {
        throw err;
      }
    }
  }
  throw lastErr;
}

function getPoolDiagnostics() {
  let searchPathSql = null;
  try {
    searchPathSql = searchPathStatement(process.env.COUNTRY);
  } catch {
    searchPathSql = null;
  }
  return {
    forceSearchPath,
    firstConnectLogged,
    totalCount: pool.totalCount,
    idleCount: pool.idleCount,
    waitingCount: pool.waitingCount,
    startupOptions: postgresOptionsForCountry() || null,
    searchPathSql,
    actualPort: currentPoolPort(),
    alternatePortTried,
  };
}

module.exports = {
  query,
  queryRetryIdCollision,
  isIdPrimaryKeyCollision,
  isMissingRelationError,
  isNetworkUnreachable,
  getClient,
  get pool() {
    return pool;
  },
  applySearchPath,
  searchPathStatement,
  postgresOptionsForCountry,
  currentPoolPort,
  getPoolDiagnostics,
  warmPool,
};
