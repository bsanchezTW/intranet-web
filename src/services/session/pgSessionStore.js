const { Store } = require("express-session");
const logger = require("../../utils/logger");
const { lockedDdl } = require("../schema/lockedDdl");

/**
 * Store de express-session sobre Postgres (la misma base de la app).
 *
 * Reemplaza al MemoryStore, que perdía todas las sesiones en cada reinicio,
 * crecía sin tope y no se comparte entre procesos de Passenger: con dos
 * procesos, cada petición caía en uno al azar y la sesión "se cerraba sola".
 *
 * Decisiones:
 *   - La tabla va calificada con el schema del país (chile.sessions,
 *     peru.sessions), no por search_path: el pooler en modo transacción
 *     ignora search_path y una tabla creada en `public` sería compartida. Con
 *     una tabla común, la cookie de un país abriría una sesión en el otro con
 *     el id de usuario del primero.
 *   - `rolling` renueva la cookie en cada petición y express-session llama
 *     a touch() cada vez. Escribir en cada request es un UPDATE por clic
 *     contra el pooler; touch sólo escribe si el vencimiento guardado quedó
 *     atrás por más de `touchIntervalMs`. Lo que la sesión pierde con eso es
 *     a lo sumo ese intervalo de vida.
 *   - Las sesiones vencidas se ignoran al leer y se borran cada tanto.
 */

const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000;
const DEFAULT_TOUCH_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_PRUNE_INTERVAL_MS = 15 * 60 * 1000;
const MAX_TRACKED_SIDS = 20000;

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;

class PgSessionStore extends Store {
  /**
   * @param {object} options
   * @param {{ query: Function }} options.db  módulo db (o un doble en tests)
   * @param {string} options.schema           schema del país ("chile", "peru")
   */
  constructor({
    db,
    schema,
    ttlMs = DEFAULT_TTL_MS,
    touchIntervalMs = DEFAULT_TOUCH_INTERVAL_MS,
    now = () => Date.now(),
  } = {}) {
    super();
    if (!db || typeof db.query !== "function") {
      throw new Error("PgSessionStore: falta db");
    }
    if (!SCHEMA_NAME.test(String(schema || ""))) {
      throw new Error(`PgSessionStore: schema inválido "${schema}"`);
    }
    this.db = db;
    this.table = `${schema}.sessions`;
    this.ttlMs = ttlMs;
    this.touchIntervalMs = touchIntervalMs;
    this.now = now;
    // Último vencimiento escrito por este proceso, para no reescribirlo en
    // cada petición. Si otro proceso lo renovó, sólo se escribe de más.
    this.lastExpire = new Map();
    this.readyPromise = null;
    this.pruneTimer = null;
  }

  /** Crea la tabla una vez; si falla, el siguiente uso lo reintenta. */
  ready() {
    if (!this.readyPromise) {
      // Tabla e índice en una transacción con lock: sin choques entre
      // procesos que arrancan a la vez (ver lockedDdl).
      this.readyPromise = this.db
        .query(
          lockedDdl(this.table, [
            `CREATE TABLE IF NOT EXISTS ${this.table} (
               sid    varchar(255) PRIMARY KEY,
               sess   jsonb        NOT NULL,
               expire timestamptz  NOT NULL
             )`,
            `CREATE INDEX IF NOT EXISTS sessions_expire_idx ON ${this.table} (expire)`,
          ]),
        )
        .catch((err) => {
          this.readyPromise = null;
          throw err;
        });
    }
    return this.readyPromise;
  }

  expireFor(sess) {
    const expires = sess && sess.cookie && sess.cookie.expires;
    const at = expires ? new Date(expires).getTime() : NaN;
    return new Date(Number.isFinite(at) ? at : this.now() + this.ttlMs);
  }

  remember(sid, expire) {
    if (this.lastExpire.size >= MAX_TRACKED_SIDS && !this.lastExpire.has(sid)) {
      this.lastExpire.delete(this.lastExpire.keys().next().value);
    }
    this.lastExpire.set(sid, expire.getTime());
  }

  get(sid, callback) {
    this.ready()
      .then(() =>
        this.db.query(
          `SELECT sess, expire FROM ${this.table} WHERE sid = $1 AND expire > NOW()`,
          [sid],
        ),
      )
      .then(({ rows }) => {
        if (!rows.length) {
          this.lastExpire.delete(sid);
          return callback(null, null);
        }
        this.remember(sid, new Date(rows[0].expire));
        const sess = rows[0].sess;
        return callback(null, typeof sess === "string" ? JSON.parse(sess) : sess);
      })
      .catch((err) => callback(err));
  }

  set(sid, sess, callback = () => {}) {
    const expire = this.expireFor(sess);
    this.ready()
      .then(() =>
        this.db.query(
          `INSERT INTO ${this.table} (sid, sess, expire)
           VALUES ($1, $2::jsonb, $3)
           ON CONFLICT (sid) DO UPDATE SET sess = EXCLUDED.sess, expire = EXCLUDED.expire`,
          [sid, JSON.stringify(sess), expire],
        ),
      )
      .then(() => {
        this.remember(sid, expire);
        callback(null);
      })
      .catch((err) => callback(err));
  }

  touch(sid, sess, callback = () => {}) {
    const expire = this.expireFor(sess);
    const last = this.lastExpire.get(sid);
    if (last != null && expire.getTime() - last < this.touchIntervalMs) {
      return callback(null);
    }
    this.ready()
      .then(() =>
        this.db.query(`UPDATE ${this.table} SET expire = $2 WHERE sid = $1`, [sid, expire]),
      )
      .then(() => {
        this.remember(sid, expire);
        callback(null);
      })
      .catch((err) => callback(err));
    return undefined;
  }

  destroy(sid, callback = () => {}) {
    this.lastExpire.delete(sid);
    this.ready()
      .then(() => this.db.query(`DELETE FROM ${this.table} WHERE sid = $1`, [sid]))
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  /** Borra las vencidas. Devuelve cuántas. */
  async prune() {
    await this.ready();
    const result = await this.db.query(`DELETE FROM ${this.table} WHERE expire <= NOW()`);
    return result.rowCount || 0;
  }

  /** Limpieza periódica que no retiene el proceso abierto. */
  startPruning(intervalMs = DEFAULT_PRUNE_INTERVAL_MS) {
    if (this.pruneTimer) return;
    this.pruneTimer = setInterval(() => {
      this.prune().catch((err) => logger.error("sesiones", err));
    }, intervalMs);
    if (typeof this.pruneTimer.unref === "function") this.pruneTimer.unref();
  }

  stopPruning() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }
}

module.exports = { PgSessionStore, DEFAULT_TTL_MS };
