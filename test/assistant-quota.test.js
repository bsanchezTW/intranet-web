const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const express = require("express");
const session = require("express-session");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  Asistente: la respuesta llega en streaming (no al final) y cada persona
  tiene un cupo por día y por minuto, reservado en la base antes de gastar.
*/

const SRC = path.join(__dirname, "..", "src");
const { httpCompression, shouldCompress } = require(path.join(SRC, "utils/httpCompression"));
const { createAssistantQuota, quotaLimits } = require(path.join(SRC, "services/assistant/assistantQuota"));

/** Base en memoria que imita el INSERT … ON CONFLICT … WHERE del cupo. */
function quotaDb({ failWith = null } = {}) {
  const rows = new Map();
  const log = [];
  return {
    rows,
    log,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, " ").trim();
      log.push(q);
      if (failWith) throw failWith;
      if (/^SELECT pg_advisory_xact_lock\(hashtext\('\w+\.assistant_usage'\)\); CREATE TABLE IF NOT EXISTS \w+\.assistant_usage/.test(q)) return { rows: [] };
      if (/^INSERT INTO \w+\.assistant_usage/.test(q)) {
        const [userId, , limit] = params;
        const key = `${userId}|hoy`;
        const row = rows.get(key);
        if (!row) {
          rows.set(key, { turns: 1, input_tokens: 0, output_tokens: 0 });
          return { rows: [{ turns: 1 }] };
        }
        if (row.turns >= limit) return { rows: [] };
        row.turns += 1;
        return { rows: [{ turns: row.turns }] };
      }
      if (/^UPDATE \w+\.assistant_usage SET input_tokens/.test(q)) {
        const row = rows.get(`${params[0]}|hoy`);
        if (row) {
          row.input_tokens += params[2];
          row.output_tokens += params[3];
        }
        return { rows: [] };
      }
      throw new Error(`Consulta no simulada: ${q}`);
    },
  };
}

function quota(db, limits = { daily: 3, perMinute: 100 }, now) {
  return createAssistantQuota({ db, schema: "chile", timezone: "America/Santiago", limits, now });
}

describe("compresión y SSE", () => {
  it("no comprime text/event-stream y sí el resto", () => {
    const req = { headers: { "accept-encoding": "gzip" } };
    const res = (type) => ({ getHeader: (h) => (h.toLowerCase() === "content-type" ? type : undefined) });
    assert.equal(shouldCompress(req, res("text/event-stream; charset=utf-8")), false);
    assert.equal(shouldCompress(req, res("text/html; charset=utf-8")), true);
  });

  it("los eventos llegan uno a uno aunque el navegador acepte gzip", async () => {
    const app = express();
    app.use(httpCompression());
    app.get("/sse", (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8" });
      let i = 0;
      const timer = setInterval(() => {
        res.write(`data: ${i}\n\n`);
        i += 1;
        if (i === 4) {
          clearInterval(timer);
          res.end();
        }
      }, 80);
    });
    const server = await new Promise((resolve) => {
      const s = app.listen(0, () => resolve(s));
    });
    try {
      const chunks = await new Promise((resolve, reject) => {
        const recibidos = [];
        http
          .get({ port: server.address().port, path: "/sse", headers: { "accept-encoding": "gzip" } }, (res) => {
            assert.equal(res.headers["content-encoding"], undefined);
            res.on("data", (c) => recibidos.push(c.toString()));
            res.on("end", () => resolve(recibidos));
          })
          .on("error", reject);
      });
      assert.ok(chunks.length >= 4, `llegaron ${chunks.length} trozos: ${JSON.stringify(chunks)}`);
      assert.match(chunks[0], /^data: 0/);
    } finally {
      server.close();
    }
  });
});

describe("cupo del asistente", () => {
  it("toma los topes del entorno, con valores por omisión", () => {
    assert.deepEqual(quotaLimits({}), { daily: 50, perMinute: 6 });
    assert.deepEqual(quotaLimits({ ASSISTANT_DAILY_TURNS: "10", ASSISTANT_TURNS_PER_MINUTE: "x" }), { daily: 10, perMinute: 6 });
  });

  it("deja usar hasta el tope diario y después niega", async () => {
    const q = quota(quotaDb());
    for (let i = 1; i <= 3; i += 1) assert.deepEqual(await q.reserve(7), { ok: true, used: i });
    const cuarta = await q.reserve(7);
    assert.equal(cuarta.ok, false);
    assert.equal(cuarta.reason, "dia");
    assert.match(cuarta.error, /límite de 3 consultas diarias/);
    assert.equal((await q.reserve(8)).ok, true, "el cupo es por persona");
  });

  it("pedidos en paralelo no pasan el tope", async () => {
    const db = quotaDb();
    const q = quota(db, { daily: 5, perMinute: 100 });
    const resultados = await Promise.all(Array.from({ length: 20 }, () => q.reserve(7)));
    assert.equal(resultados.filter((r) => r.ok).length, 5);
    assert.equal(db.rows.get("7|hoy").turns, 5);
  });

  it("frena ráfagas por minuto", async () => {
    let t = 0;
    const q = quota(quotaDb(), { daily: 100, perMinute: 2 }, () => t);
    assert.equal((await q.reserve(7)).ok, true);
    assert.equal((await q.reserve(7)).ok, true);
    const tercera = await q.reserve(7);
    assert.equal(tercera.reason, "minuto");
    t += 60 * 1000;
    assert.equal((await q.reserve(7)).ok, true);
  });

  it("si la base falla, niega el turno", async () => {
    const q = quota(quotaDb({ failWith: new Error("pooler caído") }));
    const r = await q.reserve(7);
    assert.equal(r.ok, false);
    assert.equal(r.reason, "base");
  });

  it("anota los tokens del turno y usa la tabla del país", async () => {
    const db = quotaDb();
    const q = quota(db);
    await q.reserve(7);
    await q.record(7, { input_tokens: 100, cache_read_input_tokens: 50, output_tokens: 30 });
    assert.deepEqual(db.rows.get("7|hoy"), { turns: 1, input_tokens: 150, output_tokens: 30 });
    assert.ok(db.log.every((sql) => sql.includes("chile.assistant_usage")));
  });

  it("rechaza un schema que no sea un identificador", () => {
    assert.throws(() => createAssistantQuota({ db: quotaDb(), schema: "x;drop", timezone: "UTC" }), /schema inválido/);
  });
});

describe("POST /claude/api/chat con cupo", () => {
  const stubbed = [];
  let server;
  let llamadasApi = 0;
  const db = quotaDb();

  function stubModule(rel, exports) {
    const id = require.resolve(path.join(SRC, rel));
    stubbed.push([id, require.cache[id]]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }

  before(async () => {
    process.env.ASSISTANT_DAILY_TURNS = "2";
    stubModule("db.js", db);
    stubModule("services/claudeService.js", {
      buildSystemPrompt: () => "sistema",
      runAssistantTurn: async (_messages, { onEvent }) => {
        llamadasApi += 1;
        onEvent({ type: "text", text: "hola" });
        return { text: "hola", usage: { input_tokens: 10, output_tokens: 2 }, rounds: 1 };
      },
    });
    stubModule("services/access/staffAccess.js", { canManageRrhh: async () => false });
    const claudeRoutes = require(path.join(SRC, "routes/claude"));
    const app = express();
    app.use(express.json());
    app.use(session({ secret: "t", resave: false, saveUninitialized: true }));
    app.use((req, res, next) => {
      req.session.user = { id: 7, role: "Usuario", email: "ana@transworld.cl" };
      res.locals.features = { supportTickets: false, expenseRequests: false };
      next();
    });
    app.use("/claude", claudeRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
  });

  after(() => {
    delete process.env.ASSISTANT_DAILY_TURNS;
    server.close();
    for (const [id, prev] of stubbed) {
      if (prev) require.cache[id] = prev;
      else delete require.cache[id];
    }
  });

  const chat = () =>
    fetch(`http://127.0.0.1:${server.address().port}/claude/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "¿cómo pido vacaciones?" }),
    });

  it("sin cupo responde 429 y no llama a la API", async () => {
    assert.equal((await chat()).status, 200);
    assert.equal((await chat()).status, 200);
    const res = await chat();
    assert.equal(res.status, 429);
    assert.match((await res.json()).error, /límite de 2 consultas/);
    assert.equal(llamadasApi, 2);
    assert.equal(db.rows.get("7|hoy").input_tokens, 20, "se anotaron los tokens de los dos turnos");
  });
});
