const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");
const session = require("express-session");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  Bugs funcionales de la auditoría:
    - un agente de soporte con rol Usuario recibía 403 en el detalle de un
      ticket y sólo veía los suyos en la lista;
    - el dueño de un ticket con su correo en otras mayúsculas no lo veía;
    - un curso sin preguntas daba NaN y un 500 al evaluarse;
    - un "%" suelto en el aviso de /gastos tiraba la página.
*/

const SRC = path.join(__dirname, "..", "src");
const { sameEmail } = require(path.join(SRC, "utils/email"));
const { gradeEvaluation, attachOptions } = require(path.join(SRC, "services/courses/evaluation"));

describe("sameEmail", () => {
  it("compara sin mayúsculas ni espacios y nunca iguala vacíos", () => {
    assert.equal(sameEmail("Ana@Transworld.cl ", "ana@transworld.cl"), true);
    assert.equal(sameEmail("ana@transworld.cl", "beto@transworld.cl"), false);
    assert.equal(sameEmail("", ""), false);
    assert.equal(sameEmail(null, undefined), false);
  });
});

describe("evaluación de un curso", () => {
  const correctas = [
    { pregunta_id: "10", alternativa_id: "100" },
    { pregunta_id: "11", alternativa_id: "111" },
  ];

  it("sin preguntas no hay nota (antes NaN y 500)", () => {
    const r = gradeEvaluation([], { preg_1: "1" });
    assert.equal(r.ok, false);
    assert.match(r.error, /no tiene una evaluación/);
  });

  it("corrige comparando como texto (los ids bigint llegan como string)", () => {
    const r = gradeEvaluation(correctas, { preg_10: 100, preg_11: "999" });
    assert.equal(r.porcentaje, 50);
    assert.equal(r.mostrarFeedback, false);
    assert.equal(gradeEvaluation(correctas, { preg_10: "100", preg_11: "111" }).mostrarFeedback, true);
    assert.equal(gradeEvaluation(correctas, null).porcentaje, 0);
  });

  it("reparte las alternativas de una sola consulta entre sus preguntas", () => {
    const preguntas = attachOptions(
      [{ id: "10", question_text: "a" }, { id: "11", question_text: "b" }, { id: "12", question_text: "c" }],
      [
        { id: "100", question_id: "10", text: "x" },
        { id: "111", question_id: "11", text: "y" },
        { id: "101", question_id: "10", text: "z" },
        { id: "999", question_id: "77", text: "huérfana" },
      ],
    );
    assert.deepEqual(preguntas.map((p) => p.alternativas.map((a) => a.id)), [["100", "101"], ["111"], []]);
  });
});

describe("avisos de /gastos", () => {
  it("un % suelto o una lista no rompen la página", () => {
    const dbId = require.resolve(path.join(SRC, "db.js"));
    const prev = require.cache[dbId];
    require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { query: async () => ({ rows: [] }) } };
    try {
      const { flashFrom } = require(path.join(SRC, "routes/gastos"));
      assert.deepEqual(flashFrom({ query: { ok: "1", msg: "Ahorro del 50%" } }), {
        success: "Ahorro del 50%",
        error: null,
      });
      assert.deepEqual(flashFrom({ query: { error: "100%" } }), { success: null, error: "100%" });
      assert.deepEqual(flashFrom({ query: { error: ["a", "b"] } }), { success: null, error: null });
      assert.deepEqual(flashFrom({ query: { ok: "1" } }), { success: "Operación exitosa", error: null });
    } finally {
      if (prev) require.cache[dbId] = prev;
      else delete require.cache[dbId];
    }
  });
});

describe("tickets: agentes con rol Usuario y dueños en otras mayúsculas", () => {
  const stubbed = [];
  let server;
  let base;
  const AGENTE = { id: 20, role: "Usuario", email: "soporte@transworld.cl", nombre: "Sofía Soporte" };
  const DUENA = { id: 5, role: "Usuario", email: "ana@transworld.cl", nombre: "Ana" };
  const OTRO = { id: 6, role: "Usuario", email: "beto@transworld.cl", nombre: "Beto" };
  const TICKETS = [
    { id: 9, title: "Impresora", requester_email: "Ana@Transworld.cl", requester_name: "Ana" },
    { id: 10, title: "VPN", requester_email: "beto@transworld.cl", requester_name: "Beto" },
  ];

  function stubModule(rel, exports) {
    const id = require.resolve(path.join(SRC, rel));
    stubbed.push([id, require.cache[id]]);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  }

  function fila(t) {
    return {
      ...t,
      description: "No funciona",
      category: "hardware",
      priority: "medium",
      status: "open",
      attachments: "[]",
      read_by_admin: false,
      read_by_user: true,
      assigned_to: null,
      auto_closed: false,
      created_at: new Date(),
    };
  }

  before(async () => {
    stubModule("db.js", {
      async query(sql, params = []) {
        const q = sql.replace(/\s+/g, " ").trim();
        if (/FROM support_tickets WHERE id = \$1/.test(q)) {
          const t = TICKETS.find((x) => String(x.id) === String(params[0]));
          return { rows: t ? [fila(t)] : [] };
        }
        if (/FROM ticket_replies/.test(q) || /^UPDATE support_tickets/.test(q)) return { rows: [] };
        if (/FROM support_tickets t/.test(q)) {
          const propios = params.length
            ? TICKETS.filter((t) => sameEmail(t.requester_email, params[0]))
            : TICKETS;
          return { rows: propios.map(fila) };
        }
        return { rows: [] };
      },
    });
    stubModule("services/tickets/supportTeam.js", {
      isSupportAgent: async (user) => Boolean(user && user.id === AGENTE.id),
      listSupportAgents: async () => [{ id: AGENTE.id, name: AGENTE.nombre, email: AGENTE.email }],
      getAgentById: async () => null,
      supportAgentEmails: async () => [AGENTE.email],
      invalidateSupportTeam: () => {},
    });
    stubModule("services/vacations/holidayService.js", { getHolidaySet: async () => new Set(), listHolidays: async () => [] });

    const ticketsRoutes = require(path.join(SRC, "routes/tickets"));
    const app = express();
    app.use(express.urlencoded({ extended: true }));
    app.use(session({ secret: "t", resave: false, saveUninitialized: true }));
    app.set("views", path.join(SRC, "views"));
    app.set("view engine", "ejs");
    const { TICKET_CATEGORIES, ticketCategoryLabel } = require(path.join(SRC, "constants/ticketCategories"));
    Object.assign(app.locals, {
      ticketCategories: TICKET_CATEGORIES,
      ticketCategoryLabel,
      formatPageTitle: require(path.join(SRC, "utils/pageTitle")).formatPageTitle,
      getMonogram: require(path.join(SRC, "utils/monogram")).getMonogram,
      maxTicketAttachmentMb: 10,
    });
    app.post("/__login/:id", (req, res) => {
      req.session.user = [AGENTE, DUENA, OTRO].find((u) => String(u.id) === req.params.id);
      res.end();
    });
    // Permisos como los deja el arranque: la mesa de ayuda ve y gestiona
    // todo; el resto (Básico) ve y responde lo propio.
    const { computePermissions } = require(path.join(SRC, "services/permissions/resolver"));
    const { getCatalog } = require(path.join(SRC, "services/permissions/catalog"));
    const asig = (id, userId, key, scope = null) => ({
      id, principal_type: "user", user_id: userId, permission_key: key, scope, scope_area_ids: [], effect: "concede",
    });
    let n = 0;
    const assignments = [];
    for (const u of [AGENTE, DUENA, OTRO]) {
      assignments.push(asig(++n, u.id, "soporte.acceso"), asig(++n, u.id, "soporte.ticket.crear"));
      if (u === AGENTE) {
        assignments.push(asig(++n, u.id, "soporte.ticket.ver", "todo"), asig(++n, u.id, "soporte.ticket.responder", "todo"), asig(++n, u.id, "soporte.ticket.gestionar"));
      } else {
        assignments.push(asig(++n, u.id, "soporte.ticket.ver", "propio"), asig(++n, u.id, "soporte.ticket.responder", "propio"));
      }
    }
    const snapshot = {
      users: new Map([AGENTE, DUENA, OTRO].map((u) => [u.id, { id: u.id, role: "Usuario", work_area_id: null }])),
      areas: [],
      assignments,
    };
    app.use((req, res, next) => {
      res.locals.countryConfig = require(path.join(SRC, "config/country")).getCountryConfig();
      res.locals.usuario = req.session.user || null;
      if (req.session.user) req.perms = computePermissions(snapshot, req.session.user, { catalog: getCatalog() });
      next();
    });
    app.use("/soporte", ticketsRoutes);
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => {
    server.close();
    for (const [id, prev] of stubbed) {
      if (prev) require.cache[id] = prev;
      else delete require.cache[id];
    }
  });

  async function as(user) {
    const login = await fetch(`${base}/__login/${user.id}`, { method: "POST" });
    const cookie = login.headers.get("set-cookie").split(";")[0];
    return (url) => fetch(base + url, { headers: { cookie }, redirect: "manual" });
  }

  it("la mesa de ayuda (rol Usuario) abre el detalle de un ticket ajeno", async () => {
    const get = await as(AGENTE);
    const res = await get("/soporte/tickets/9?modal=true");
    assert.equal(res.status, 200);
    assert.match(await res.text(), /Impresora/);
  });

  it("la dueña lo abre aunque su correo esté guardado con otras mayúsculas", async () => {
    const get = await as(DUENA);
    assert.equal((await get("/soporte/tickets/9?modal=true")).status, 200);
  });

  it("otra persona sigue sin poder abrirlo", async () => {
    const get = await as(OTRO);
    assert.equal((await get("/soporte/tickets/9?modal=true")).status, 403);
  });
});
