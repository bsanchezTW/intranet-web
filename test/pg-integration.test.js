const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");

/*
  SQL de las tablas que la app crea sola, contra un Postgres de verdad.
  Opcional: corre sólo con INTEGRATION_PG_URL (una base desechable, NUNCA la
  de producción: crea y borra el schema `it_chile`).

    INTEGRATION_PG_URL=postgresql://postgres@127.0.0.1:55432/postgres npm test
*/

const URL_PG = process.env.INTEGRATION_PG_URL;
const SCHEMA = "it_chile";

describe("integración con Postgres", { skip: !URL_PG && "sin INTEGRATION_PG_URL" }, () => {
  let pool;
  const db = { query: (text, params) => pool.query(text, params) };

  before(async () => {
    const { Pool } = require("pg");
    pool = new Pool({ connectionString: URL_PG, max: 20 });
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.query(`CREATE SCHEMA ${SCHEMA}`);
  });

  after(async () => {
    if (!pool) return;
    await pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
    await pool.end();
  });

  it("sesiones: guarda, lee, renueva, vence y borra", async () => {
    const { PgSessionStore } = require("../src/services/session/pgSessionStore");
    const store = new PgSessionStore({ db, schema: SCHEMA, touchIntervalMs: 0 });
    const call = (method, ...args) =>
      new Promise((resolve, reject) => store[method](...args, (err, v) => (err ? reject(err) : resolve(v))));
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    await call("set", "sid-1", { cookie: { expires }, user: { id: 7, nombre: "Ana Pérez" } });
    await call("set", "sid-1", { cookie: { expires }, user: { id: 7, nombre: "Ana Pérez" }, extra: 1 });
    assert.deepEqual((await call("get", "sid-1")).user, { id: 7, nombre: "Ana Pérez" });

    const later = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    await call("touch", "sid-1", { cookie: { expires: later } });
    const { rows } = await pool.query(`SELECT expire FROM ${SCHEMA}.sessions WHERE sid = 'sid-1'`);
    assert.equal(rows[0].expire.toISOString(), later);

    await call("set", "vieja", { cookie: { expires: new Date(Date.now() - 1000).toISOString() } });
    assert.equal(await call("get", "vieja"), null);
    assert.equal(await store.prune(), 1);

    await call("destroy", "sid-1");
    assert.equal(await call("get", "sid-1"), null);
  });

  it("cupo del asistente: el ON CONFLICT con tope es atómico", async () => {
    const { createAssistantQuota } = require("../src/services/assistant/assistantQuota");
    const quota = createAssistantQuota({
      db,
      schema: SCHEMA,
      timezone: "America/Santiago",
      limits: { daily: 5, perMinute: 1000 },
    });
    const resultados = await Promise.all(Array.from({ length: 25 }, () => quota.reserve(7)));
    assert.equal(resultados.filter((r) => r.ok).length, 5);
    assert.equal((await quota.reserve(8)).ok, true);

    await quota.record(7, { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 9 });
    const { rows } = await pool.query(
      `SELECT turns, input_tokens, output_tokens FROM ${SCHEMA}.assistant_usage WHERE user_id = 7`,
    );
    assert.deepEqual(rows[0], { turns: 5, input_tokens: "120", output_tokens: "9" });
  });
});
