const { DEFAULT_TICKET_CATEGORY } = require("../../constants/ticketCategories");
const { htmlToText } = require("../../utils/sanitizeContent");

/**
 * Correos del buzón de soporte → tickets (lo usa src/email-listener.js).
 *
 * Antes, en cada aviso de "llegó correo" se leía sólo el ÚLTIMO mensaje: si
 * llegaban dos juntos se perdía uno, y si IMAP se cortaba el listener quedaba
 * vivo pero sordo. Ahora:
 *   - se recuerda el último UID procesado en <schema>.email_intake_state y en
 *     cada pasada se toman TODOS los posteriores, en orden;
 *   - la primera vez (o si el buzón se recreó: cambia UIDVALIDITY) se parte
 *     del final, sin importar el historial como tickets;
 *   - un correo que no se puede leer se salta; un error de la base corta la
 *     pasada SIN avanzar, y el mensaje se reintenta en la siguiente;
 *   - las respuestas automáticas (Auto-Submitted, rebotes) y los correos de la
 *     propia casilla no crean tickets: evitan bucles con las notificaciones.
 */

const SCHEMA_NAME = /^[a-z_][a-z0-9_]*$/;
const MAILBOX = "INBOX";
const MAX_TITLE = 255;
const MAX_DESCRIPTION = 20000;

function headerValue(parsed, name) {
  const value = parsed.headers && typeof parsed.headers.get === "function" ? parsed.headers.get(name) : null;
  if (value == null) return "";
  return typeof value === "string" ? value : String(value.value || value.text || value);
}

/**
 * ¿Este correo debe ser un ticket? { ok: true, ticket } o { ok: false, reason }.
 * Pura (recibe el correo ya parseado).
 */
function ticketFromParsedMail(parsed, { ownAddress = "" } = {}) {
  const from = parsed.from && parsed.from.value && parsed.from.value[0];
  const email = String((from && from.address) || "").trim().toLowerCase();
  if (!email || !email.includes("@")) return { ok: false, reason: "sin-remitente" };

  const own = String(ownAddress || "").trim().toLowerCase();
  if (own && email === own) return { ok: false, reason: "propio" };

  const auto = headerValue(parsed, "auto-submitted").trim().toLowerCase();
  if (auto && auto !== "no") return { ok: false, reason: "automatico" };
  const precedence = headerValue(parsed, "precedence").trim().toLowerCase();
  if (["bulk", "junk", "list", "auto_reply"].includes(precedence)) return { ok: false, reason: "automatico" };
  if (/^(mailer-daemon|postmaster)@/i.test(email)) return { ok: false, reason: "rebote" };

  const texto = parsed.text && parsed.text.trim()
    ? parsed.text
    : parsed.html
      ? htmlToText(parsed.html)
      : "";
  return {
    ok: true,
    ticket: {
      title: String(parsed.subject || "(sin asunto)").trim().slice(0, MAX_TITLE) || "(sin asunto)",
      description: (texto.trim() || "(sin contenido en el correo)").slice(0, MAX_DESCRIPTION),
      requesterName: String((from && from.name) || email).trim().slice(0, MAX_TITLE),
      requesterEmail: email,
    },
  };
}

function createEmailIntake({ db, schema, parse, ownAddress = "", logger = console }) {
  if (!SCHEMA_NAME.test(String(schema || ""))) throw new Error(`emailIntake: schema inválido "${schema}"`);
  const table = `${schema}.email_intake_state`;
  let readyPromise = null;

  function ready() {
    if (!readyPromise) {
      readyPromise = db
        .query(
          `CREATE TABLE IF NOT EXISTS ${table} (
             mailbox      varchar(100) PRIMARY KEY,
             uid_validity varchar(40)  NOT NULL,
             last_uid     bigint       NOT NULL,
             updated_at   timestamptz  NOT NULL DEFAULT NOW()
           )`,
        )
        .catch((err) => {
          readyPromise = null;
          throw err;
        });
    }
    return readyPromise;
  }

  async function loadState() {
    await ready();
    const { rows } = await db.query(`SELECT uid_validity, last_uid FROM ${table} WHERE mailbox = $1`, [MAILBOX]);
    return rows[0] ? { uidValidity: String(rows[0].uid_validity), lastUid: Number(rows[0].last_uid) } : null;
  }

  async function saveState(uidValidity, lastUid) {
    await db.query(
      `INSERT INTO ${table} (mailbox, uid_validity, last_uid, updated_at)
       VALUES ($1, $2, $3, NOW())
       ON CONFLICT (mailbox) DO UPDATE
         SET uid_validity = EXCLUDED.uid_validity, last_uid = EXCLUDED.last_uid, updated_at = NOW()`,
      [MAILBOX, String(uidValidity), lastUid],
    );
  }

  async function insertTicket(ticket) {
    const insert = typeof db.queryRetryIdCollision === "function" ? db.queryRetryIdCollision : db.query;
    const { rows } = await insert.call(
      db,
      `INSERT INTO support_tickets
         (title, description, category, priority, status, requester_name, requester_email)
       VALUES ($1, $2, $3, 'medium', 'open', $4, $5)
       RETURNING id`,
      [ticket.title, ticket.description, DEFAULT_TICKET_CATEGORY, ticket.requesterName, ticket.requesterEmail],
    );
    return rows[0] && rows[0].id;
  }

  /**
   * Una pasada sobre el buzón abierto en `client` (ImapFlow).
   * Devuelve { created, skipped, baseline? }.
   */
  async function processNew(client) {
    const box = client.mailbox || {};
    const uidValidity = String(box.uidValidity ?? "");
    const state = await loadState();

    if (!state || state.uidValidity !== uidValidity) {
      const baseline = Math.max(0, Number(box.uidNext || 1) - 1);
      await saveState(uidValidity, baseline);
      logger.info("correo", `buzón ${state ? "recreado" : "nuevo"}: se parte del UID ${baseline}`);
      return { created: 0, skipped: 0, baseline };
    }

    let lastUid = state.lastUid;
    let created = 0;
    let skipped = 0;
    for await (const message of client.fetch(`${lastUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
      const uid = Number(message.uid);
      // "n:*" devuelve el último mensaje aunque n sea mayor que todos.
      if (!Number.isFinite(uid) || uid <= lastUid) continue;

      let decision;
      try {
        decision = ticketFromParsedMail(await parse(message.source), { ownAddress });
      } catch (err) {
        logger.warn("correo", `UID ${uid} ilegible, se salta: ${err.message || err}`);
        decision = { ok: false, reason: "ilegible" };
      }

      if (decision.ok) {
        // Si la base falla, se corta SIN avanzar: el correo se reintenta.
        const id = await insertTicket(decision.ticket);
        logger.info("correo", `ticket #${id} desde ${decision.ticket.requesterEmail} (UID ${uid})`);
        created += 1;
      } else {
        skipped += 1;
      }
      lastUid = uid;
      await saveState(uidValidity, lastUid);
    }
    return { created, skipped };
  }

  return { processNew, loadState };
}

/**
 * Conexión que no se rinde: abre INBOX, procesa lo nuevo, escucha avisos y
 * revisa cada `pollMs` por si se pierde alguno; al cortarse, reconecta con
 * espera creciente (1 s, 2 s, 4 s… hasta `maxBackoffMs`).
 */
function createEmailListener({
  createClient,
  intake,
  logger = console,
  pollMs = 5 * 60 * 1000,
  maxBackoffMs = 60 * 1000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
}) {
  let stopped = false;
  let current = null;

  async function session(client) {
    await client.connect();
    await client.mailboxOpen(MAILBOX);
    logger.info("correo", "conectado a INBOX");

    // Una pasada a la vez: si llega un aviso durante una, se repite al final.
    let running = null;
    let again = false;
    const drain = () => {
      if (running) {
        again = true;
        return running;
      }
      running = (async () => {
        do {
          again = false;
          try {
            await intake.processNew(client);
          } catch (err) {
            logger.error("correo", err);
          }
        } while (again && !stopped);
        running = null;
      })();
      return running;
    };

    const closed = new Promise((resolve) => {
      client.once("close", resolve);
      client.on("error", (err) => logger.error("correo", err));
    });
    client.on("exists", () => drain());
    const poll = setInterval(() => drain(), pollMs);
    try {
      await drain();
      await closed;
    } finally {
      clearInterval(poll);
      if (running) await running.catch(() => {});
    }
  }

  async function run() {
    let attempt = 0;
    while (!stopped) {
      current = createClient();
      try {
        await session(current);
        attempt = 0;
      } catch (err) {
        logger.error("correo", err);
      }
      if (stopped) break;
      attempt += 1;
      const wait = Math.min(maxBackoffMs, 1000 * 2 ** (attempt - 1));
      logger.warn("correo", `conexión IMAP cerrada; reintento en ${Math.round(wait / 1000)} s`);
      await sleep(wait);
    }
  }

  async function stop() {
    stopped = true;
    if (current && typeof current.logout === "function") await current.logout().catch(() => {});
  }

  return { run, stop };
}

module.exports = { ticketFromParsedMail, createEmailIntake, createEmailListener };
