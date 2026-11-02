const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  readDbCa,
  resolveDbSsl,
  isUnverifiedTls,
  connectionStringForSsl,
} = require("../src/config/dbSsl");

/*
  TLS hacia Postgres: con DB_SSL_CA se verifica el certificado del pooler;
  sin ella se mantiene el cifrado sin verificar de siempre (con aviso).
*/

const PEM = "-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n";
const SUPABASE = { DB_HOST: "aws-1-us-west-2.pooler.supabase.com" };

describe("resolveDbSsl", () => {
  it("sin DB_SSL_CA, Supabase sigue cifrando sin verificar (como antes)", () => {
    const ssl = resolveDbSsl({ ...SUPABASE });
    assert.deepEqual(ssl, { rejectUnauthorized: false });
    assert.equal(isUnverifiedTls(ssl), true);
  });

  it("con DB_SSL_CA (PEM en la variable) verifica el certificado", () => {
    const ssl = resolveDbSsl({ ...SUPABASE, DB_SSL_CA: PEM.replace(/\n/g, "\\n") });
    assert.equal(ssl.rejectUnauthorized, true);
    assert.equal(ssl.ca, PEM);
    assert.equal(isUnverifiedTls(ssl), false);
  });

  it("con DB_SSL_CA como ruta lee el archivo", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dbssl-"));
    const file = path.join(dir, "prod-ca-2021.crt");
    fs.writeFileSync(file, PEM);
    try {
      assert.equal(resolveDbSsl({ ...SUPABASE, DB_SSL_CA: file }).ca, PEM);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("falla claro si la ruta no existe o no es un certificado", () => {
    assert.throws(() => readDbCa({ DB_SSL_CA: "/no/existe.crt" }), /no se pudo leer/);
    assert.throws(
      () => readDbCa({ DB_SSL_CA: "x.crt" }, { readFile: () => "no soy un pem" }),
      /no contiene un certificado PEM/,
    );
  });

  it("DB_SSL=false apaga TLS, y junto con DB_SSL_CA es un error", () => {
    assert.equal(resolveDbSsl({ ...SUPABASE, DB_SSL: "false" }), false);
    assert.throws(() => resolveDbSsl({ DB_SSL: "false", DB_SSL_CA: PEM }), /a la vez/);
  });

  it("una base que no es Supabase y sin DB_SSL va sin TLS, como antes", () => {
    assert.equal(resolveDbSsl({ DB_HOST: "localhost" }), false);
    assert.deepEqual(resolveDbSsl({ DB_HOST: "localhost", DB_SSL: "true" }), { rejectUnauthorized: false });
  });
});

describe("connectionStringForSsl", () => {
  const url = "postgresql://u:p@aws-1.pooler.supabase.com:6543/postgres?sslmode=no-verify&application_name=intranet";

  it("con verificación quita los ssl* de la URL, que pg aplicaría por encima", () => {
    const limpia = connectionStringForSsl(url, { ca: PEM, rejectUnauthorized: true });
    assert.doesNotMatch(limpia, /sslmode/);
    assert.match(limpia, /application_name=intranet/);
  });

  it("sin verificación no toca la URL", () => {
    assert.equal(connectionStringForSsl(url, { rejectUnauthorized: false }), url);
    assert.equal(connectionStringForSsl(url, false), url);
  });
});

describe("el pool usa la verificación", () => {
  it("con DB_SSL_CA el Pool queda con rejectUnauthorized y sin sslmode en la URL", () => {
    const keys = ["DATABASE_URL", "DB_SSL_CA", "DB_SSL", "COUNTRY", "DB_HOST"];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    const dbId = require.resolve("../src/db");
    const prev = require.cache[dbId];
    delete require.cache[dbId];
    try {
      delete process.env.DB_SSL;
      delete process.env.DB_HOST;
      process.env.COUNTRY = "CL";
      process.env.DATABASE_URL = "postgresql://intranet_chile.x:p@aws-1-us-west-2.pooler.supabase.com:6543/postgres?sslmode=no-verify";
      process.env.DB_SSL_CA = PEM;
      const db = require("../src/db");
      const { options } = db.pool;
      assert.equal(options.ssl.rejectUnauthorized, true);
      assert.equal(options.ssl.ca.trim(), PEM.trim());
      assert.doesNotMatch(options.connectionString, /sslmode/);
      db.pool.end().catch(() => {});
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
      if (prev) require.cache[dbId] = prev;
      else delete require.cache[dbId];
    }
  });
});
