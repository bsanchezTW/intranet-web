const logger = require("../../utils/logger");

/**
 * Tareas programadas (cierre de tickets, limpieza de historial, purga de
 * borradores de gastos, transiciones de vacaciones).
 *
 * Antes cada proceso web las corría con su setInterval: con varios procesos
 * de Passenger se duplicaban, cada reinicio las disparaba de nuevo y, si
 * Passenger apagaba el proceso por inactividad, no corrían nunca.
 *
 * Ahora quién corre una tarea y cuándo lo decide la base: claim() hace un
 * único INSERT … ON CONFLICT … WHERE last_run <= NOW() - periodo en
 * <schema>.job_runs. Gana un solo proceso por periodo, sea el intervalo de
 * la app o el cron del servidor (scripts/tareas.js), y un reinicio no la
 * repite antes de tiempo.
 *
 * El periodo del reclamo es un 90 % del nominal: un cron cada hora que se
 * atrasa unos segundos igual encuentra la tarea vencida.
 */

const HOUR = 60 * 60 * 1000;
const CLAIM_SLACK = 0.9;
const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

/**
 * Las tareas de la intranet. `enabled` mira las capacidades del país; `run`
 * devuelve un resumen para el log.
 */
function defaultJobs({ db, isFeatureEnabled }) {
  return [
    {
      name: "tickets-cierre",
      intervalMs: HOUR,
      enabled: () => isFeatureEnabled("supportTickets"),
      async run() {
        const result = await db.query(`
          UPDATE support_tickets
             SET status = 'closed', closed_at = NOW(), auto_closed = TRUE
           WHERE status = 'pending_close'
             AND resolved_at < (NOW() - INTERVAL '1 day')`);
        return `cerrados ${result.rowCount || 0} ticket(s) pendiente(s) de cierre`;
      },
    },
    {
      name: "historial-limpieza",
      intervalMs: 12 * HOUR,
      enabled: () => true,
      async run() {
        const result = await db.query(
          "DELETE FROM change_log WHERE created_at < (NOW() - INTERVAL '5 days')",
        );
        return `eliminados ${result.rowCount || 0} registro(s) de historial`;
      },
    },
    {
      name: "gastos-purga",
      intervalMs: 12 * HOUR,
      enabled: () => true,
      async run() {
        const expenseRequests = require("../expenses/expenseRequestService");
        const { drafts, files } = await expenseRequests.purgeStaleDrafts();
        // Después de la purga, para que sus archivos no cuenten como en uso.
        const huerfanos = await expenseRequests.purgeOrphanUploads();
        return `borradores ${drafts} (${files} comprobante(s)), comprobantes huérfanos ${huerfanos.deleted}`;
      },
    },
    {
      name: "vacaciones-transiciones",
      intervalMs: 12 * HOUR,
      enabled: () => isFeatureEnabled("vacations"),
      async run() {
        const vacations = require("../vacations/vacationRequestService");
        const { inProgress, completed } = await vacations.runDailyStatusTransitions();
        return `${inProgress} en curso, ${completed} completadas`;
      },
    },
  ];
}

function createJobRunner({ db, schema, jobs }) {
  if (!SCHEMA_NAME.test(String(schema || ""))) throw new Error(`jobRunner: schema inválido "${schema}"`);
  const table = `${schema}.job_runs`;
  const byName = new Map(jobs.map((job) => [job.name, job]));
  let readyPromise = null;
  let timer = null;

  function ready() {
    if (!readyPromise) {
      readyPromise = db
        .query(
          `CREATE TABLE IF NOT EXISTS ${table} (
             name         varchar(80) PRIMARY KEY,
             last_run     timestamptz NOT NULL,
             last_status  varchar(10),
             last_message text,
             finished_at  timestamptz
           )`,
        )
        .catch((err) => {
          readyPromise = null;
          throw err;
        });
    }
    return readyPromise;
  }

  /** ¿Le toca a este proceso? Reserva el periodo si sí. */
  async function claim(job, { force = false } = {}) {
    await ready();
    const periodo = force ? 0 : Math.floor(job.intervalMs * CLAIM_SLACK);
    const { rows } = await db.query(
      `INSERT INTO ${table} AS j (name, last_run)
       VALUES ($1, NOW())
       ON CONFLICT (name) DO UPDATE SET last_run = NOW()
       WHERE j.last_run <= NOW() - ($2::bigint * INTERVAL '1 millisecond')
       RETURNING name`,
      [job.name, periodo],
    );
    return rows.length > 0;
  }

  async function finish(job, status, message) {
    try {
      await db.query(
        `UPDATE ${table} SET last_status = $2, last_message = $3, finished_at = NOW() WHERE name = $1`,
        [job.name, status, String(message || "").slice(0, 2000)],
      );
    } catch (err) {
      logger.error("tareas", err);
    }
  }

  /**
   * Corre una tarea si le toca. Devuelve { name, ran, status?, message? }.
   * Un error de la tarea se registra y no se propaga.
   */
  async function runJob(name, { force = false } = {}) {
    const job = byName.get(name);
    if (!job) throw new Error(`No existe la tarea "${name}".`);
    if (!job.enabled()) return { name, ran: false, status: "apagada" };
    if (!(await claim(job, { force }))) return { name, ran: false, status: "no-toca" };
    try {
      const message = await job.run();
      await finish(job, "ok", message);
      logger.info("tareas", `${name}: ${message}`);
      return { name, ran: true, status: "ok", message };
    } catch (err) {
      logger.error("tareas", err);
      await finish(job, "error", err && err.message);
      return { name, ran: true, status: "error", message: err && err.message };
    }
  }

  /** Todas las tareas que tocan, una tras otra (cada una es una conexión). */
  async function runDue(options = {}) {
    const results = [];
    for (const job of jobs) {
      try {
        results.push(await runJob(job.name, options));
      } catch (err) {
        logger.error("tareas", err);
        results.push({ name: job.name, ran: false, status: "error", message: err.message });
      }
    }
    return results;
  }

  /**
   * Revisa cada `tickMs` qué tareas tocan. Con el reclamo en la base, varios
   * procesos haciendo esto no duplican nada.
   */
  function startInterval(tickMs = 5 * 60 * 1000) {
    if (timer) return;
    runDue().catch((err) => logger.error("tareas", err));
    timer = setInterval(() => runDue().catch((err) => logger.error("tareas", err)), tickMs);
  }

  function stop() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { runJob, runDue, startInterval, stop, jobs };
}

/** ¿Corre el intervalo dentro de la app? Se apaga con IN_PROCESS_JOBS=false (cron). */
function inProcessJobsEnabled(env = process.env) {
  return String(env.IN_PROCESS_JOBS ?? "").trim().toLowerCase() !== "false";
}

module.exports = { createJobRunner, defaultJobs, inProcessJobsEnabled, CLAIM_SLACK };
