const dns = require("dns").promises;
const net = require("net");
const db = require("../db");
const logger = require("../utils/logger");
const {
  extractDatabaseRole,
  getCountryDbBinding,
} = require("../config/supabaseProjects");

function redactDatabaseUrl(raw) {
  const value = String(raw || "").trim();
  if (!value) return null;
  try {
    const parsed = new URL(value);
    if (parsed.password) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "(DATABASE_URL inválida)";
  }
}

function formatPgError(err) {
  if (!err) return "error desconocido";
  const bits = [];
  if (err.code) bits.push(`code=${err.code}`);
  if (err.address) bits.push(`address=${err.address}`);
  if (err.port != null) bits.push(`port=${err.port}`);
  if (err.syscall) bits.push(`syscall=${err.syscall}`);
  if (Array.isArray(err.errors)) {
    for (const inner of err.errors) {
      bits.push(
        `nested=${inner.code || inner.message || "?"}@${inner.address || "?"}:${inner.port || "?"}`,
      );
    }
  }
  bits.push(logger.describeError(err).message || String(err.message || err));
  return bits.join(" ").trim();
}

function resolveDbTarget() {
  if (process.env.DATABASE_URL?.trim()) {
    try {
      const parsed = new URL(process.env.DATABASE_URL.trim());
      return {
        host: parsed.hostname,
        port: parsed.port ? Number(parsed.port) : 5432,
      };
    } catch {
      return { host: null, port: 5432 };
    }
  }
  return {
    host: process.env.DB_HOST || null,
    port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 5432,
  };
}

function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port, family: 4 });
    const finish = (status, detail) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve({
        host,
        port,
        status,
        detail,
        ms: Date.now() - started,
      });
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish("ok", `TCP ${host}:${port} abierto (IPv4)`));
    socket.once("timeout", () => finish("fail", `timeout ${timeoutMs}ms`));
    socket.once("error", (err) =>
      finish("fail", `${err.code || err.message}${err.address ? ` ${err.address}` : ""}`),
    );
  });
}

async function probeDns(host) {
  const result = { ipv4: [], ipv6: [], error: null };
  try {
    result.ipv4 = await dns.resolve4(host);
  } catch (err) {
    result.error = `A: ${err.code || err.message}`;
  }
  try {
    result.ipv6 = await dns.resolve6(host);
  } catch (err) {
    if (!result.ipv4.length) {
      result.error = [result.error, `AAAA: ${err.code || err.message}`]
        .filter(Boolean)
        .join(" · ");
    }
  }
  return result;
}

function networkHint(tcpResults) {
  const byPort = Object.fromEntries(tcpResults.map((row) => [row.port, row]));
  const pg5432 = byPort[5432];
  const pg6543 = byPort[6543];
  const https = byPort[443];
  if (pg5432?.status === "ok") {
    return "El puerto 5432 abre: el fallo no es el firewall. Revisa usuario/clave o SSL.";
  }
  if (pg6543?.status === "ok" && pg5432?.status !== "ok") {
    return "5432 está bloqueado y 6543 abre. En cPanel pon DB_PORT=6543 (pooler transacción) y reinicia Passenger.";
  }
  if (https?.status === "ok" && pg5432?.status !== "ok" && pg6543?.status !== "ok") {
    return "Hay Internet (443 abre) pero cPanel bloquea Postgres (5432 y 6543). Hay que pedir al hosting salida TCP a aws-1-us-west-2.pooler.supabase.com.";
  }
  if (https?.status !== "ok") {
    return "Este servidor no tiene salida de red usable. No va a poder hablar con Supabase hasta que el hosting lo habilite.";
  }
  return null;
}

function snapshotEnv() {
  const country = String(process.env.COUNTRY || "").trim().toUpperCase();
  let binding = null;
  try {
    binding = getCountryDbBinding(country);
  } catch (err) {
    binding = { error: err.message };
  }

  return {
    country: country || "(vacío)",
    nodeEnv: process.env.NODE_ENV || "(no definido)",
    appBaseUrl: process.env.APP_BASE_URL || "(vacío)",
    tz: process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone,
    dbHost: process.env.DB_HOST || "(vacío)",
    dbPort: process.env.DB_PORT || "(default 5432)",
    dbUser: process.env.DB_USER || "(vacío)",
    dbName: process.env.DB_NAME || "(vacío)",
    dbSsl: process.env.DB_SSL || "(auto)",
    dbRole: extractDatabaseRole(process.env) || "(no leído)",
    databaseUrl: redactDatabaseUrl(process.env.DATABASE_URL),
    expectedSchema: binding?.schema || null,
    expectedRole: binding?.role || null,
    expectedBucket: binding?.bucket || null,
    passengerAppEnv: process.env.PASSENGER_APP_ENV || null,
    bindingError: binding?.error || null,
  };
}

function pushStep(steps, status, title, detail, extra = {}) {
  steps.push({
    at: new Date().toISOString(),
    ms: extra.ms ?? null,
    status,
    title,
    detail: detail == null ? "" : String(detail),
  });
}

async function timed(fn) {
  const started = Date.now();
  const value = await fn();
  return { value, ms: Date.now() - started };
}

async function runDbProbe() {
  const steps = [];
  const env = snapshotEnv();
  const poolInfo = db.getPoolDiagnostics();

  pushStep(
    steps,
    "info",
    "Instancia",
    `COUNTRY=${env.country}  schema esperado=${env.expectedSchema || "?"}  rol esperado=${env.expectedRole || "?"}`,
  );
  pushStep(
    steps,
    poolInfo.forceSearchPath ? "warn" : "info",
    "Pool Node",
    `forceSearchPath=${poolInfo.forceSearchPath}  puerto=${poolInfo.actualPort || env.dbPort}  conexiones=${poolInfo.totalCount} idle=${poolInfo.idleCount} waiting=${poolInfo.waitingCount}  options="${poolInfo.startupOptions || "(ninguna)"}"`,
  );

  const target = resolveDbTarget();
  if (target.host) {
    try {
      const { value, ms } = await timed(() => probeDns(target.host));
      const ipv4 = value.ipv4.join(", ") || "(ninguna)";
      const ipv6 = value.ipv6.join(", ") || "(ninguna)";
      pushStep(
        steps,
        value.ipv4.length ? "ok" : "fail",
        `DNS ${target.host}`,
        `A=${ipv4}  AAAA=${ipv6}${value.error ? `  ${value.error}` : ""}`,
        { ms },
      );
    } catch (err) {
      pushStep(steps, "fail", `DNS ${target.host}`, formatPgError(err));
    }

    const tcpResults = await Promise.all(
      [target.port, target.port === 5432 ? 6543 : 5432, 443]
        .filter((port, index, all) => all.indexOf(port) === index)
        .map((port) => tcpProbe(target.host, port)),
    );
    for (const probe of tcpResults) {
      pushStep(
        steps,
        probe.status === "ok" ? "ok" : "fail",
        `TCP ${probe.port}`,
        probe.detail,
        { ms: probe.ms },
      );
    }
    const hint = networkHint(tcpResults);
    if (hint) {
      pushStep(steps, tcpResults.some((row) => row.port !== 443 && row.status === "ok") ? "warn" : "fail", "Qué significa", hint);
    }
  }

  try {
    const { value, ms } = await timed(() => db.query("SELECT 1 AS ok"));
    pushStep(steps, "ok", "Conexión (SELECT 1)", `pool.query respondió ok=${value.rows[0]?.ok}  puerto=${db.currentPoolPort()}`, { ms });
  } catch (err) {
    pushStep(steps, "fail", "Conexión (SELECT 1)", formatPgError(err));
    return {
      ok: false,
      env: snapshotEnv(),
      pool: db.getPoolDiagnostics(),
      steps,
      recent: logger.recentEntries("db"),
    };
  }

  let identity;
  try {
    const { value, ms } = await timed(() =>
      db.pool.query(`
        SELECT current_user AS db_user,
               current_schema() AS schema,
               current_setting('search_path') AS search_path,
               current_database() AS database,
               inet_server_port() AS server_port
      `),
    );
    identity = value.rows[0] || {};
    const schemaOk = env.expectedSchema && identity.schema === env.expectedSchema;
    const roleOk =
      !env.expectedRole ||
      String(identity.db_user || "").startsWith(`${env.expectedRole}`);
    pushStep(
      steps,
      schemaOk && roleOk ? "ok" : "fail",
      "Identidad sin SET search_path (así entra el login)",
      `user=${identity.db_user}  schema=${identity.schema}  search_path=${identity.search_path}  db=${identity.database}  puerto=${identity.server_port}`,
      { ms },
    );
    if (!schemaOk) {
      pushStep(
        steps,
        "fail",
        "Schema incorrecto",
        `current_schema()="${identity.schema}" y esta instancia espera "${env.expectedSchema}". El pooler de cPanel (sobre todo :6543) ignora options=-c search_path.`,
      );
    }
  } catch (err) {
    pushStep(steps, "fail", "Identidad sin SET search_path", formatPgError(err));
  }

  try {
    const { value, ms } = await timed(() =>
      db.pool.query("SELECT COUNT(*)::int AS n FROM users"),
    );
    pushStep(
      steps,
      "ok",
      "SELECT COUNT(*) FROM users (sin SET)",
      `filas=${value.rows[0]?.n} — esta es la consulta que hace el login`,
      { ms },
    );
  } catch (err) {
    pushStep(
      steps,
      "fail",
      "SELECT COUNT(*) FROM users (sin SET)",
      formatPgError(err),
    );
  }

  try {
    const { value, ms } = await timed(async () => {
      const client = await db.getClient();
      try {
        const session = await client.query(`
          SELECT current_schema() AS schema,
                 current_setting('search_path') AS search_path
        `);
        const users = await client.query("SELECT COUNT(*)::int AS n FROM users");
        const tables = await client.query(`
          SELECT tablename
          FROM pg_tables
          WHERE schemaname = current_schema()
          ORDER BY tablename
        `);
        return {
          schema: session.rows[0]?.schema,
          searchPath: session.rows[0]?.search_path,
          users: users.rows[0]?.n,
          tables: tables.rows.map((row) => row.tablename),
        };
      } finally {
        client.release();
      }
    });
    pushStep(
      steps,
      value.schema === env.expectedSchema ? "ok" : "fail",
      "Con SET search_path del país (getClient)",
      `schema=${value.schema}  search_path=${value.searchPath}  users=${value.users}  tablas=${value.tables.join(", ") || "(ninguna)"}`,
      { ms },
    );
  } catch (err) {
    pushStep(steps, "fail", "Con SET search_path del país (getClient)", formatPgError(err));
  }

  try {
    const { value, ms } = await timed(() => db.query("SELECT COUNT(*)::int AS n FROM users"));
    pushStep(
      steps,
      "ok",
      "db.query (wrapper de la app, con reintento 42P01)",
      `filas=${value.rows[0]?.n}  forceSearchPath=${db.getPoolDiagnostics().forceSearchPath}`,
      { ms },
    );
  } catch (err) {
    pushStep(steps, "fail", "db.query (wrapper de la app)", formatPgError(err));
  }

  const failed = steps.some((step) => step.status === "fail");
  return {
    ok: !failed,
    env,
    pool: db.getPoolDiagnostics(),
    steps,
    recent: logger.recentEntries("db"),
  };
}

module.exports = {
  redactDatabaseUrl,
  formatPgError,
  snapshotEnv,
  runDbProbe,
};
