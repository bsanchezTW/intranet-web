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

  it("tablas que se crean al primer uso: varios procesos a la vez no chocan", async () => {
    // Schema propio y vacío: es el primer despliegue, con varios procesos de
    // Passenger atendiendo peticiones a la vez. Sin el lock de lockedDdl, uno
    // choca con otro en los catálogos (23505) y esa petición responde 500.
    const FRESCO = "it_primer_uso";
    await pool.query(`DROP SCHEMA IF EXISTS ${FRESCO} CASCADE`);
    await pool.query(`CREATE SCHEMA ${FRESCO}`);
    try {
      const { PgSessionStore } = require("../src/services/session/pgSessionStore");
      const { createAssistantQuota } = require("../src/services/assistant/assistantQuota");
      const { createJobRunner } = require("../src/services/jobs/jobRunner");
      const { createEmailIntake } = require("../src/services/tickets/emailIntake");
      const silent = { info() {}, warn() {}, error() {} };
      const PROCESOS = 8;
      const primerUso = [];
      for (let i = 0; i < PROCESOS; i += 1) {
        const store = new PgSessionStore({ db, schema: FRESCO });
        primerUso.push(new Promise((resolve, reject) => store.get("x", (err) => (err ? reject(err) : resolve()))));
        primerUso.push(
          createAssistantQuota({ db, schema: FRESCO, timezone: "UTC", limits: { daily: 100, perMinute: 100 } })
            .reserve(1)
            .then((r) => { if (!r.ok) throw new Error(r.error); }),
        );
        primerUso.push(
          createJobRunner({ db, schema: FRESCO, jobs: [{ name: "x", intervalMs: 1000, enabled: () => true, run: async () => "ok" }] })
            .runJob("x"),
        );
        primerUso.push(createEmailIntake({ db, schema: FRESCO, parse: async () => ({}), logger: silent }).loadState());
      }
      const resultados = await Promise.allSettled(primerUso);
      const fallos = resultados.filter((r) => r.status === "rejected").map((r) => r.reason.message);
      assert.deepEqual(fallos, []);

      const { rows } = await pool.query(
        `SELECT table_name FROM information_schema.tables WHERE table_schema = $1 ORDER BY table_name`,
        [FRESCO],
      );
      assert.deepEqual(rows.map((r) => r.table_name), ["assistant_usage", "email_intake_state", "job_runs", "sessions"]);
    } finally {
      await pool.query(`DROP SCHEMA IF EXISTS ${FRESCO} CASCADE`);
    }
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

  it("evaluación: las alternativas de todas las preguntas en una consulta (ids bigint)", async () => {
    await pool.query(`CREATE TABLE ${SCHEMA}.question_options (id bigint PRIMARY KEY, question_id bigint, text text)`);
    await pool.query(
      `INSERT INTO ${SCHEMA}.question_options VALUES (100, 10, 'x'), (101, 10, 'z'), (111, 11, 'y'), (999, 77, 'otra')`,
    );
    const { attachOptions } = require("../src/services/courses/evaluation");
    const preguntas = [{ id: "10" }, { id: "11" }];
    const { rows } = await pool.query(
      `SELECT id, question_id, text FROM ${SCHEMA}.question_options
        WHERE question_id = ANY($1::bigint[])
        ORDER BY id ASC`,
      [preguntas.map((p) => p.id)],
    );
    assert.deepEqual(
      attachOptions(preguntas, rows).map((p) => p.alternativas.map((a) => a.text)),
      [["x", "z"], ["y"]],
    );
  });

  it("tareas: un solo proceso gana el periodo", async () => {
    const { createJobRunner } = require("../src/services/jobs/jobRunner");
    let corridas = 0;
    const jobs = [{ name: "prueba", intervalMs: 60 * 60 * 1000, enabled: () => true, run: async () => { corridas += 1; return "ok"; } }];
    const procesos = Array.from({ length: 6 }, () => createJobRunner({ db, schema: SCHEMA, jobs }));
    await Promise.all(procesos.map((p) => p.runJob("prueba")));
    assert.equal(corridas, 1);
    assert.equal((await procesos[0].runJob("prueba")).status, "no-toca");
    assert.equal((await procesos[0].runJob("prueba", { force: true })).ran, true);
    const { rows } = await pool.query(`SELECT last_status FROM ${SCHEMA}.job_runs WHERE name = 'prueba'`);
    assert.equal(rows[0].last_status, "ok");
  });

  it("migraciones: dos procesos a la vez aplican cada una una sola vez", async () => {
    await pool.query(`CREATE TABLE ${SCHEMA}.users (id int PRIMARY KEY, email varchar(150))`);
    await pool.query(`CREATE TABLE ${SCHEMA}.news_articles (id int PRIMARY KEY)`);
    await pool.query(`CREATE TABLE ${SCHEMA}.applications (id int PRIMARY KEY)`);
    const { runMigrations } = require("../src/services/schema/migrator");
    const migrations = require("../src/migrations");
    const silent = { info() {} };
    const run = () => runMigrations({ connect: () => pool.connect(), schema: SCHEMA, migrations, logger: silent });
    const [a, b] = await Promise.all([run(), run()]);
    assert.equal(a.applied.length + b.applied.length, migrations.length);
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM ${SCHEMA}.schema_migrations`);
    assert.equal(rows[0].n, migrations.length);
    const cols = await pool.query(
      `SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = 'users'`,
      [SCHEMA],
    );
    assert.ok(cols.rows.some((r) => r.column_name === "confirm_attempts"));
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
