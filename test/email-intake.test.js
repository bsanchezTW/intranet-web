const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { simpleParser } = require("mailparser");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const {
  ticketFromParsedMail,
  createEmailIntake,
  createEmailListener,
} = require("../src/services/tickets/emailIntake");

/*
  Buzón de soporte → tickets. Antes se leía sólo el último correo de cada
  aviso (dos juntos → uno perdido) y un corte de IMAP dejaba el listener
  sordo para siempre.
*/

const silent = { info() {}, warn() {}, error() {} };

function raw({ from = "Ana Pérez <Ana@Transworld.cl>", subject = "Impresora", body = "No imprime", headers = "" } = {}) {
  return Buffer.from(
    `From: ${from}\r\nTo: soporte@transworld.cl\r\nSubject: ${subject}\r\n${headers}Content-Type: text/plain; charset=utf-8\r\n\r\n${body}\r\n`,
  );
}

/** ImapFlow mínimo: buzón con UIDs y fetch "n:*" como el real. */
function fakeImap({ uidValidity = 1n, messages = [] } = {}) {
  const client = new EventEmitter();
  client.messages = messages;
  client.mailbox = { uidValidity, uidNext: (messages.at(-1)?.uid || 0) + 1 };
  client.connect = async () => {};
  client.mailboxOpen = async () => client.mailbox;
  client.logout = async () => client.emit("close");
  client.add = (uid, source) => {
    client.messages.push({ uid, source });
    client.mailbox.uidNext = uid + 1;
  };
  client.fetch = async function* fetch(range) {
    const start = Number(range.split(":")[0]);
    const nuevos = client.messages.filter((m) => m.uid >= start);
    // Como IMAP: "n:*" con n mayor que todos devuelve igual el último.
    const lista = nuevos.length ? nuevos : client.messages.slice(-1);
    for (const m of lista) yield m;
  };
  return client;
}

function fakeDb({ failInsertOnce = false } = {}) {
  const state = new Map();
  const tickets = [];
  let fallar = failInsertOnce;
  return {
    state,
    tickets,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, " ").trim();
      if (/^SELECT pg_advisory_xact_lock\(hashtext\('\w+\.email_intake_state'\)\); CREATE TABLE IF NOT EXISTS \w+\.email_intake_state/.test(q)) return { rows: [] };
      if (/^SELECT uid_validity, last_uid FROM \w+\.email_intake_state/.test(q)) {
        const s = state.get(params[0]);
        return { rows: s ? [{ uid_validity: s.uid_validity, last_uid: String(s.last_uid) }] : [] };
      }
      if (/^INSERT INTO \w+\.email_intake_state/.test(q)) {
        state.set(params[0], { uid_validity: params[1], last_uid: params[2] });
        return { rows: [] };
      }
      if (/^INSERT INTO support_tickets/.test(q)) {
        if (fallar) {
          fallar = false;
          throw new Error("pooler caído");
        }
        tickets.push({ title: params[0], description: params[1], requester_name: params[3], requester_email: params[4] });
        return { rows: [{ id: tickets.length }] };
      }
      throw new Error(`Consulta no simulada: ${q}`);
    },
  };
}

function intakeWith(db, extra = {}) {
  return createEmailIntake({ db, schema: "chile", parse: simpleParser, logger: silent, ...extra });
}

describe("qué correo es un ticket", () => {
  it("toma remitente (en minúsculas), asunto y texto", async () => {
    const r = ticketFromParsedMail(await simpleParser(raw()));
    assert.equal(r.ok, true);
    assert.deepEqual(r.ticket, {
      title: "Impresora",
      description: "No imprime",
      requesterName: "Ana Pérez",
      requesterEmail: "ana@transworld.cl",
    });
  });

  it("descarta respuestas automáticas, rebotes y los correos de la propia casilla", async () => {
    const auto = await simpleParser(raw({ headers: "Auto-Submitted: auto-replied\r\n" }));
    assert.equal(ticketFromParsedMail(auto).reason, "automatico");
    const bulk = await simpleParser(raw({ headers: "Precedence: bulk\r\n" }));
    assert.equal(ticketFromParsedMail(bulk).reason, "automatico");
    const rebote = await simpleParser(raw({ from: "MAILER-DAEMON@outlook.com" }));
    assert.equal(ticketFromParsedMail(rebote).reason, "rebote");
    const propio = await simpleParser(raw({ from: "Soporte <SOPORTE@transworld.cl>" }));
    assert.equal(ticketFromParsedMail(propio, { ownAddress: "soporte@transworld.cl" }).reason, "propio");
  });

  it("un correo sólo HTML se guarda como texto, sin etiquetas", async () => {
    const parsed = await simpleParser(
      Buffer.from(
        "From: a@transworld.cl\r\nSubject: x\r\nContent-Type: text/html\r\n\r\n<p>Hola <b>equipo</b></p><script>alert(1)</script>\r\n",
      ),
    );
    const r = ticketFromParsedMail(parsed);
    assert.doesNotMatch(r.ticket.description, /<|script|alert/);
    assert.match(r.ticket.description, /Hola equipo/);
  });
});

describe("pasada sobre el buzón", () => {
  it("la primera vez parte del final y no importa el historial", async () => {
    const db = fakeDb();
    const client = fakeImap({ messages: [{ uid: 1, source: raw() }, { uid: 2, source: raw() }] });
    const r = await intakeWith(db).processNew(client);
    assert.deepEqual(r, { created: 0, skipped: 0, baseline: 2 });
    assert.equal(db.tickets.length, 0);
  });

  it("dos correos que llegan juntos crean dos tickets (antes se perdía uno)", async () => {
    const db = fakeDb();
    const client = fakeImap({ messages: [{ uid: 1, source: raw() }] });
    const intake = intakeWith(db);
    await intake.processNew(client);
    client.add(2, raw({ subject: "VPN" }));
    client.add(3, raw({ subject: "Correo" }));
    const r = await intake.processNew(client);
    assert.equal(r.created, 2);
    assert.deepEqual(db.tickets.map((t) => t.title), ["VPN", "Correo"]);
    // Una pasada más sin correos nuevos no repite el último.
    assert.equal((await intake.processNew(client)).created, 0);
    assert.equal(db.tickets.length, 2);
  });

  it("si la base falla, no avanza y el correo se reintenta", async () => {
    const db = fakeDb({ failInsertOnce: true });
    const client = fakeImap({ messages: [{ uid: 1, source: raw() }] });
    const intake = intakeWith(db);
    await intake.processNew(client);
    client.add(2, raw({ subject: "VPN" }));
    await assert.rejects(intake.processNew(client), /pooler caído/);
    assert.equal(db.state.get("INBOX").last_uid, 1);
    await intake.processNew(client);
    assert.deepEqual(db.tickets.map((t) => t.title), ["VPN"]);
  });

  it("un correo ilegible se salta sin trabar la cola", async () => {
    const db = fakeDb();
    const client = fakeImap({ messages: [{ uid: 1, source: raw() }] });
    let primero = true;
    const intake = intakeWith(db, {
      parse: async (src) => {
        if (primero) {
          primero = false;
          throw new Error("MIME roto");
        }
        return simpleParser(src);
      },
    });
    await intake.processNew(client);
    client.add(2, raw({ subject: "roto" }));
    client.add(3, raw({ subject: "bueno" }));
    const r = await intake.processNew(client);
    assert.deepEqual(r, { created: 1, skipped: 1 });
    assert.deepEqual(db.tickets.map((t) => t.title), ["bueno"]);
  });

  it("si el buzón se recreó (otro UIDVALIDITY) vuelve a partir del final", async () => {
    const db = fakeDb();
    const intake = intakeWith(db);
    await intake.processNew(fakeImap({ uidValidity: 1n, messages: [{ uid: 5, source: raw() }] }));
    const r = await intake.processNew(fakeImap({ uidValidity: 2n, messages: [{ uid: 1, source: raw() }] }));
    assert.equal(r.baseline, 1);
    assert.equal(db.tickets.length, 0);
  });
});

describe("conexión", () => {
  it("procesa al conectar y con cada aviso; reconecta con espera creciente si falla", async () => {
    const clients = [];
    const waits = [];
    const pasadas = [];
    const intake = {
      async processNew(client) {
        pasadas.push(clients.indexOf(client));
      },
    };
    let listener;
    listener = createEmailListener({
      createClient: () => {
        const c = fakeImap();
        // Sólo el primero conecta; los siguientes fallan (servidor caído).
        if (clients.length > 0) c.connect = async () => { throw new Error("ECONNREFUSED"); };
        clients.push(c);
        return c;
      },
      intake,
      logger: silent,
      pollMs: 60 * 60 * 1000,
      sleep: async (ms) => {
        waits.push(ms);
        if (waits.length >= 3) await listener.stop();
      },
    });
    const corriendo = listener.run();
    const tick = () => new Promise((r) => setImmediate(r));
    await tick();
    clients[0].emit("exists");
    await tick();
    clients[0].emit("close");
    await corriendo;

    assert.deepEqual(pasadas, [0, 0], "al conectar y con el aviso");
    assert.equal(clients.length, 3, "siguió intentando reconectar");
    assert.deepEqual(waits, [1000, 2000, 4000], "1 s tras un corte, y crece mientras falla");
  });
});
