const logger = require("../../utils/logger");
const { createRateLimiter } = require("../../utils/rateLimiter");
const { lockedDdl } = require("../schema/lockedDdl");

/**
 * Cuota del asistente por persona.
 *
 * Cada turno cuesta una o varias llamadas a la API de Anthropic y no había
 * ningún tope: cualquiera con sesión podía generar gasto sin límite (a mano
 * o con un script). Dos frenos:
 *
 *   - Por día (ASSISTANT_DAILY_TURNS, 50 por omisión): en la base, en
 *     <schema>.assistant_usage. El turno se RESERVA antes de llamar a la API
 *     con un único INSERT … ON CONFLICT … WHERE turns < tope: pedidos en
 *     paralelo no pasan el tope y vale para todos los procesos. El día es el
 *     del país (zona horaria de la instancia). También guarda los tokens, para
 *     ver el gasto por persona.
 *   - Por minuto (ASSISTANT_TURNS_PER_MINUTE, 6): en memoria, contra ráfagas.
 *
 * Si la base falla, el turno se niega: sin poder contar no se gasta.
 */

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

function quotaLimits(env = process.env) {
  return {
    daily: positiveInt(env.ASSISTANT_DAILY_TURNS, 50),
    perMinute: positiveInt(env.ASSISTANT_TURNS_PER_MINUTE, 6),
  };
}

function createAssistantQuota({ db, schema, timezone, limits = quotaLimits(), now } = {}) {
  if (!db || typeof db.query !== "function") throw new Error("assistantQuota: falta db");
  if (!SCHEMA_NAME.test(String(schema || ""))) throw new Error(`assistantQuota: schema inválido "${schema}"`);
  if (!timezone) throw new Error("assistantQuota: falta la zona horaria");

  const table = `${schema}.assistant_usage`;
  const burst = createRateLimiter({ windowMs: 60 * 1000, max: limits.perMinute, ...(now ? { now } : {}) });
  let readyPromise = null;

  function ready() {
    if (!readyPromise) {
      readyPromise = db
        .query(
          lockedDdl(table, [
            `CREATE TABLE IF NOT EXISTS ${table} (
               user_id       integer NOT NULL,
               day           date    NOT NULL,
               turns         integer NOT NULL DEFAULT 0,
               input_tokens  bigint  NOT NULL DEFAULT 0,
               output_tokens bigint  NOT NULL DEFAULT 0,
               PRIMARY KEY (user_id, day)
             )`,
          ]),
        )
        .catch((err) => {
          readyPromise = null;
          throw err;
        });
    }
    return readyPromise;
  }

  /**
   * Reserva un turno. { ok: true, used } o { ok: false, reason, error }.
   */
  async function reserve(userId) {
    const id = Number(userId);
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, reason: "usuario", error: "No se pudo identificar tu cuenta." };
    }

    const rafaga = burst.hit(String(id));
    if (!rafaga.allowed) {
      const segundos = Math.max(1, Math.ceil(rafaga.retryAfterMs / 1000));
      return {
        ok: false,
        reason: "minuto",
        error: `Estás enviando muchas preguntas seguidas. Espera ${segundos} segundos.`,
      };
    }

    try {
      await ready();
      const { rows } = await db.query(
        `INSERT INTO ${table} (user_id, day, turns)
         VALUES ($1, (NOW() AT TIME ZONE $2)::date, 1)
         ON CONFLICT (user_id, day) DO UPDATE
           SET turns = ${table}.turns + 1
         WHERE ${table}.turns < $3
         RETURNING turns`,
        [id, timezone, limits.daily],
      );
      if (!rows.length) {
        return {
          ok: false,
          reason: "dia",
          error: `Llegaste al límite de ${limits.daily} consultas diarias del asistente. Vuelve mañana.`,
        };
      }
      return { ok: true, used: Number(rows[0].turns) };
    } catch (err) {
      logger.error("asistente", err);
      return {
        ok: false,
        reason: "base",
        error: "No pude verificar tu cupo del asistente. Intenta de nuevo en un momento.",
      };
    }
  }

  /** Suma los tokens del turno. No bloquea: un fallo sólo se registra. */
  async function record(userId, usage = {}) {
    try {
      await ready();
      await db.query(
        `UPDATE ${table}
            SET input_tokens  = input_tokens + $3,
                output_tokens = output_tokens + $4
          WHERE user_id = $1 AND day = (NOW() AT TIME ZONE $2)::date`,
        [
          Number(userId),
          timezone,
          Number(usage.input_tokens || 0) + Number(usage.cache_read_input_tokens || 0)
            + Number(usage.cache_creation_input_tokens || 0),
          Number(usage.output_tokens || 0),
        ],
      );
    } catch (err) {
      logger.error("asistente", err);
    }
  }

  return { reserve, record, limits };
}

module.exports = { createAssistantQuota, quotaLimits };
