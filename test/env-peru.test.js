const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const dns = require("node:dns");
const path = require("node:path");
const dotenv = require("dotenv");
const { Pool } = require("pg");

const { getCountryConfig } = require("../src/config/country");
const { getFeatures } = require("../src/config/features");
const { getStorageConfig } = require("../src/config/storage");
const {
  SHARED_INTRANET_PROJECT_REF,
  applyCountryPoolerUser,
  assertCountryDatabaseRole,
  assertCountryStorageBucket,
  defaultStorageBucketForCountry,
  getCountryDbBinding,
  searchPathStatement,
} = require("../src/config/supabaseProjects");

function loadSharedEnv() {
  const quiet = { quiet: true };
  dotenv.config({ path: path.join(__dirname, "..", ".env"), ...quiet });
  dotenv.config({ path: path.join(__dirname, "..", ".env.local"), ...quiet });
}

/** Env que debe declarar cPanel / `npm run dev:pe`, sin heredar Chile. */
function peruInstanceEnv(overrides = {}) {
  const env = {
    COUNTRY: "PE",
    SESSION_SECRET: "test-session-secret-peru",
    APP_BASE_URL: "http://localhost:3001",
    SUPABASE_URL: `https://${SHARED_INTRANET_PROJECT_REF}.supabase.co`,
    SUPABASE_SECRET_KEY: "sb_secret_test_peru",
    SUPABASE_STORAGE_BUCKET: defaultStorageBucketForCountry("PE"),
    DB_HOST: "aws-1-us-west-2.pooler.supabase.com",
    DB_PORT: "5432",
    DB_USER: `postgres.${SHARED_INTRANET_PROJECT_REF}`,
    DB_NAME: "postgres",
    DB_SSL: "true",
    ...overrides,
  };
  applyCountryPoolerUser(env);
  return env;
}

function hasLiveDbCredentials() {
  if (process.env.DATABASE_URL?.trim()) return true;
  return Boolean(
    process.env.DB_HOST?.trim() &&
      process.env.DB_USER?.trim() &&
      process.env.DB_NAME?.trim() &&
      (process.env.DB_PASSWORD || process.env.DB_PASS),
  );
}

function livePeruEnv() {
  const env = {
    ...process.env,
    COUNTRY: "PE",
    APP_BASE_URL: "http://localhost:3001",
    SUPABASE_STORAGE_BUCKET: defaultStorageBucketForCountry("PE"),
  };
  applyCountryPoolerUser(env);
  return env;
}

function lookupIpv4(hostname, _options, callback) {
  dns.lookup(hostname, { family: 4 }, callback);
}

function createPePool(env) {
  const ssl = { rejectUnauthorized: false };
  const lookup = { lookup: lookupIpv4 };
  if (env.DATABASE_URL?.trim()) {
    return new Pool({
      connectionString: env.DATABASE_URL.trim(),
      ssl,
      max: 1,
      connectionTimeoutMillis: 12000,
      ...lookup,
    });
  }
  return new Pool({
    host: env.DB_HOST,
    port: env.DB_PORT ? Number(env.DB_PORT) : 5432,
    user: env.DB_USER,
    password: env.DB_PASSWORD || env.DB_PASS,
    database: env.DB_NAME,
    ssl,
    max: 1,
    connectionTimeoutMillis: 12000,
    ...lookup,
  });
}

describe("env Perú — contrato de instancia (cPanel / dev:pe)", () => {
  it("PE-01: identidad de Perú no hereda Chile", () => {
    const pe = getCountryConfig("PE");
    const cl = getCountryConfig("CL");

    assert.equal(pe.code, "PE");
    assert.equal(pe.name, "Perú");
    assert.equal(pe.timezone, "America/Lima");
    assert.equal(pe.locale, "es-PE");
    assert.equal(pe.corporateEmailDomain, "transworld.pe");
    assert.equal(pe.sessionCookieName, "tw_sid_pe");
    assert.equal(pe.devPort, 3001);
    assert.equal(pe.noReplyEmail, "noreply@transworld.pe");
    assert.notEqual(pe.sessionCookieName, cl.sessionCookieName);
    assert.notEqual(pe.corporateEmailDomain, cl.corporateEmailDomain);
  });

  it("PE-02: schema, rol, bucket y search_path son solo peru", () => {
    const binding = getCountryDbBinding("PE");
    assert.equal(binding.schema, "peru");
    assert.equal(binding.role, "intranet_peru");
    assert.equal(binding.bucket, "intranet-content-pe");
    assert.equal(defaultStorageBucketForCountry("PE"), "intranet-content-pe");
    assert.equal(searchPathStatement("PE"), "SET search_path TO peru");
    assert.equal(searchPathStatement("PE").includes("chile"), false);
  });

  it("PE-03: el lanzador reescribe postgres.<ref> al rol de Perú", () => {
    const env = peruInstanceEnv();
    assert.equal(env.COUNTRY, "PE");
    assert.equal(env.DB_USER, `intranet_peru.${SHARED_INTRANET_PROJECT_REF}`);
    assert.equal(assertCountryDatabaseRole(env), "intranet_peru");
    assert.equal(
      assertCountryStorageBucket(env.SUPABASE_STORAGE_BUCKET, "PE"),
      "intranet-content-pe",
    );
  });

  it("PE-04: Storage de Perú no puede usar el bucket de Chile", () => {
    const env = peruInstanceEnv({
      SUPABASE_STORAGE_BUCKET: "intranet-content",
    });
    assert.throws(() => getStorageConfig(env), /reservado para CL/);
  });

  it("PE-05: Storage válido usa intranet-content-pe en el mismo proyecto", () => {
    const storage = getStorageConfig(peruInstanceEnv());
    assert.equal(storage.bucket, "intranet-content-pe");
    assert.match(storage.url, new RegExp(SHARED_INTRANET_PROJECT_REF));
  });

  it("PE-06: features de Perú no heredan Chile (asistente sí; LinkedIn/UF/menú/tickets no)", () => {
    const features = getFeatures("PE");
    assert.equal(features.linkedinFeed, false);
    assert.equal(features.chileUfIndicator, false);
    assert.equal(features.lunchMenu, false);
    assert.equal(features.claudeAssistant, true);
    assert.equal(features.supportTickets, false);
    assert.equal(features.homeQuickAccess, true);
    assert.equal(features.expenseRequests, false);
    assert.equal(features.chileHrPortals, false);
  });

  it("PE-07: login acepta transworld.pe y rechaza transworld.cl", () => {
    const pe = getCountryConfig("PE");
    assert.equal(pe.allowedLoginDomains[0], "transworld.pe");
    assert.ok(!pe.allowedLoginDomains.includes("transworld.cl"));
    assert.ok(!pe.allowedLoginDomains.includes("hotmail.cl"));
    assert.equal(pe.forbiddenEmailTld, "cl");
    assert.ok(!pe.brand.loginLogo.includes("18"));
    assert.ok(!pe.brand.navbarLogo.includes("18"));
    assert.ok(!pe.brand.loginBackground.includes("18"));
  });
});

describe("env Perú — conexión real (search_path del rol)", () => {
  it("PE-08: al conectar como intranet_peru el schema actual es peru", { timeout: 20000 }, async (t) => {
    loadSharedEnv();
    if (!hasLiveDbCredentials()) {
      t.skip("sin DATABASE_URL ni DB_* en .env");
      return;
    }

    const env = livePeruEnv();
    assert.equal(env.COUNTRY, "PE");
    assert.match(String(env.DB_USER || env.DATABASE_URL), /intranet_peru/);

    const pool = createPePool(env);
    let client;
    try {
      client = await pool.connect();
      const { rows } = await client.query(
        `SELECT current_user AS db_user,
                current_schema() AS schema,
                current_setting('search_path') AS search_path`,
      );
      const row = rows[0];
      assert.match(
        String(row.db_user),
        /^intranet_peru\b/,
        `se conectó como "${row.db_user}"; en cPanel DB_USER debe ser intranet_peru.<ref>`,
      );
      assert.equal(
        row.schema,
        "peru",
        `search_path="${row.search_path}". El login en producción 500 si el schema no es peru.`,
      );

      const users = await client.query(
        `SELECT COUNT(*)::int AS n
         FROM users
         WHERE email_confirmed = true`,
      );
      assert.ok(
        users.rows[0].n >= 1,
        "schema peru.users no tiene cuentas confirmadas para probar login",
      );
    } finally {
      if (client) client.release();
      await pool.end();
    }
  });
});
