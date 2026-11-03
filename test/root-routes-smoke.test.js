const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const express = require("express");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  routes/index.js se partió en home, perfil, cursos y apps. Este test recorre
  todas sus rutas con un superadmin y la base vacía, y falla si alguna lanza
  un ReferenceError: lo que se rompe al mover código y no se ve hasta que
  alguien entra a esa página. No prueba lo que cada ruta hace.
*/

const SRC = path.join(__dirname, "..", "src");
const stubbed = [];
const errores = [];

function stubModule(rel, exports) {
  const id = require.resolve(path.join(SRC, rel));
  stubbed.push([id, require.cache[id]]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

function capturar(...args) {
  const texto = args.map((a) => (a && a.stack) || String(a)).join(" ");
  if (/ReferenceError|is not defined|is not a function/.test(texto)) errores.push(texto.split("\n")[0]);
}

let server;
let base;
let router;
const originalError = console.error;

before(async () => {
  console.error = capturar;
  const db = { query: async () => ({ rows: [], rowCount: 0 }), warmPool: async () => {} };
  db.queryRetryIdCollision = db.query;
  db.getClient = async () => ({ query: db.query, release() {} });
  stubModule("db.js", db);
  stubModule("services/mailer.js", { sendMail: async () => {}, resolveMailFrom: () => "x@y" });
  const logger = require(path.join(SRC, "utils/logger"));
  for (const level of ["error", "warn"]) {
    const original = logger[level];
    logger[level] = (tag, err) => {
      capturar(err);
      return original === logger[level] ? undefined : undefined;
    };
  }

  router = require(path.join(SRC, "routes/index"));
  const { EffectivePermissions } = require(path.join(SRC, "services/permissions/resolver"));
  const { getCatalog } = require(path.join(SRC, "services/permissions/catalog"));
  const { legacyContext } = require(path.join(SRC, "services/permissions/legacyRules"));

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use((req, res, next) => {
    req.session = { user: { id: 1, role: "Administrador", email: "a@transworld.cl", nombre: "A" }, save: (cb) => cb && cb() };
    req.perms = new EffectivePermissions({ userId: 1, superadmin: true, catalog: getCatalog() });
    req.permLegacy = legacyContext(req.session.user, { rrhhManager: true, workAreaId: 1 });
    res.locals.can = Object.assign(() => true, { field: () => true });
    // Las vistas necesitan más locals de los que hay aquí: no se renderiza.
    res.render = (_view, _locals, cb) => (typeof cb === "function" ? cb(null, "") : res.status(200).end("vista"));
    next();
  });
  app.use(router);
  app.use((err, req, res, _next) => {
    capturar(err);
    res.status(500).end();
  });
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  console.error = originalError;
  if (server) server.close();
  for (const [id, prev] of stubbed) {
    if (prev) require.cache[id] = prev;
    else delete require.cache[id];
  }
});

function rutas(stack) {
  const out = [];
  for (const layer of stack) {
    if (layer.route) {
      for (const method of Object.keys(layer.route.methods)) out.push([method.toUpperCase(), layer.route.path]);
    } else if (layer.handle && layer.handle.stack) {
      out.push(...rutas(layer.handle.stack));
    }
  }
  return out;
}

describe("rutas de la raíz tras partir routes/index.js", () => {
  it("son las mismas 33 de antes", () => {
    const lista = rutas(router.stack).map(([m, p]) => `${m} ${p}`);
    assert.equal(lista.length, 33);
    for (const esperada of ["GET /", "GET /perfil", "GET /cursos/evaluacion/:id", "GET /kpi-cursos", "POST /apps/nueva", "GET /auth/linkedin/renovar"]) {
      assert.ok(lista.includes(esperada), esperada);
    }
  });

  it("ninguna lanza un ReferenceError", async () => {
    for (const [method, ruta] of rutas(router.stack)) {
      const url = ruta.replace(/:id\b/g, "1");
      await fetch(base + url, {
        method,
        redirect: "manual",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: method === "GET" ? undefined : JSON.stringify({ curso_id: 1, segundos_vistos: 1, ids: [] }),
      }).then((r) => r.arrayBuffer());
    }
    assert.deepEqual(errores, []);
  });
});
