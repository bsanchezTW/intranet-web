const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { createJobRunner, defaultJobs, inProcessJobsEnabled, CLAIM_SLACK } = require("../src/services/jobs/jobRunner");

/*
  Tareas programadas: una sola ejecución por periodo aunque las revisen
  varios procesos o un cron, y sin repetirse en cada reinicio.
*/

const HOUR = 60 * 60 * 1000;

/** Base en memoria que imita el reclamo de job_runs con un reloj propio. */
function jobsDb(clock) {
  const runs = new Map();
  const log = [];
  return {
    runs,
    log,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, " ").trim();
      log.push(q);
      if (/^CREATE TABLE IF NOT EXISTS \w+\.job_runs/.test(q)) return { rows: [] };
      if (/^INSERT INTO \w+\.job_runs AS j/.test(q)) {
        const [name, periodo] = params;
        const row = runs.get(name);
        if (!row) {
          runs.set(name, { last_run: clock.now() });
          return { rows: [{ name }] };
        }
        if (row.last_run <= clock.now() - Number(periodo)) {
          row.last_run = clock.now();
          return { rows: [{ name }] };
        }
        return { rows: [] };
      }
      if (/^UPDATE \w+\.job_runs SET last_status/.test(q)) {
        Object.assign(runs.get(params[0]), { last_status: params[1], last_message: params[2] });
        return { rows: [] };
      }
      throw new Error(`Consulta no simulada: ${q}`);
    },
  };
}

function setup({ enabled = () => true, run } = {}) {
  let t = Date.UTC(2026, 10, 2, 12);
  const clock = { now: () => t, advance: (ms) => { t += ms; } };
  const db = jobsDb(clock);
  let corridas = 0;
  const jobs = [
    {
      name: "limpieza",
      intervalMs: HOUR,
      enabled,
      run: run || (async () => {
        corridas += 1;
        return "ok";
      }),
    },
  ];
  // Dos "procesos" con la misma base.
  const a = createJobRunner({ db, schema: "chile", jobs });
  const b = createJobRunner({ db, schema: "chile", jobs });
  return { a, b, db, clock, corridas: () => corridas };
}

describe("jobRunner", () => {
  it("dos procesos revisando a la vez: corre una sola vez", async () => {
    const { a, b, corridas } = setup();
    const [ra, rb] = await Promise.all([a.runJob("limpieza"), b.runJob("limpieza")]);
    assert.equal(corridas(), 1);
    assert.deepEqual([ra.ran, rb.ran].sort(), [false, true]);
  });

  it("un reinicio no la repite antes de su periodo", async () => {
    const { a, b, clock, corridas } = setup();
    await a.runJob("limpieza");
    clock.advance(10 * 60 * 1000);
    assert.equal((await b.runJob("limpieza")).status, "no-toca");
    clock.advance(HOUR * CLAIM_SLACK);
    assert.equal((await b.runJob("limpieza")).ran, true);
    assert.equal(corridas(), 2);
  });

  it("--forzar corre aunque no toque", async () => {
    const { a, corridas } = setup();
    await a.runJob("limpieza");
    assert.equal((await a.runJob("limpieza", { force: true })).ran, true);
    assert.equal(corridas(), 2);
  });

  it("una tarea que falla queda registrada y no corta las demás", async () => {
    const { a, db } = setup({ run: async () => { throw new Error("pooler caído"); } });
    const r = await a.runJob("limpieza");
    assert.equal(r.status, "error");
    assert.equal(db.runs.get("limpieza").last_status, "error");
    assert.match(db.runs.get("limpieza").last_message, /pooler caído/);
  });

  it("una tarea apagada en el país no se reclama", async () => {
    const { a, db } = setup({ enabled: () => false });
    assert.equal((await a.runJob("limpieza")).status, "apagada");
    assert.equal(db.runs.size, 0);
  });

  it("usa la tabla del schema del país y rechaza uno inválido", async () => {
    const { a, db } = setup();
    await a.runJob("limpieza");
    assert.ok(db.log.every((q) => q.includes("chile.job_runs")));
    assert.throws(() => createJobRunner({ db, schema: "x; drop", jobs: [] }), /schema inválido/);
  });

  it("una tarea desconocida es un error", async () => {
    const { a } = setup();
    await assert.rejects(a.runJob("no-existe"), /No existe la tarea/);
  });

  it("IN_PROCESS_JOBS=false apaga el intervalo de la app", () => {
    assert.equal(inProcessJobsEnabled({}), true);
    assert.equal(inProcessJobsEnabled({ IN_PROCESS_JOBS: "false" }), false);
    assert.equal(inProcessJobsEnabled({ IN_PROCESS_JOBS: "true" }), true);
  });
});

describe("tareas de la intranet", () => {
  it("son las cuatro de antes, con su periodo y su capacidad del país", () => {
    const features = new Set(["supportTickets"]);
    const jobs = defaultJobs({ db: { query: async () => ({ rowCount: 0 }) }, isFeatureEnabled: (f) => features.has(f) });
    assert.deepEqual(
      jobs.map((j) => [j.name, j.intervalMs / HOUR, j.enabled()]),
      [
        ["tickets-cierre", 1, true],
        ["historial-limpieza", 12, true],
        ["gastos-purga", 12, true],
        ["vacaciones-transiciones", 12, false],
      ],
    );
  });

  it("el cierre de tickets mantiene su SQL", async () => {
    const consultas = [];
    const db = { query: async (sql) => { consultas.push(sql.replace(/\s+/g, " ").trim()); return { rowCount: 3 }; } };
    const [tickets] = defaultJobs({ db, isFeatureEnabled: () => true });
    assert.equal(await tickets.run(), "cerrados 3 ticket(s) pendiente(s) de cierre");
    assert.match(consultas[0], /status = 'pending_close' AND resolved_at < \(NOW\(\) - INTERVAL '1 day'\)/);
  });
});
