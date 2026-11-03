const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const express = require("express");
const session = require("express-session");

const { saveSessionBeforeRedirect } = require("../src/middlewares/saveSessionBeforeRedirect");

/*
  Tras un POST que cambia la sesión, el 302 no sale hasta que está guardada. El
  store tarda a propósito, como Postgres por la red, y el cliente pide la página
  siguiente apenas llegan las cabeceras, igual que un navegador.
*/

const LATENCIA_MS = 80;

class SlowStore extends session.MemoryStore {
  constructor({ failSet = false } = {}) {
    super();
    this.writes = 0;
    this.failSet = failSet;
  }

  set(sid, data, callback) {
    this.writes += 1;
    if (this.failSet) return setTimeout(() => callback(new Error("base caída")), LATENCIA_MS);
    return setTimeout(() => super.set(sid, data, callback), LATENCIA_MS);
  }
}

async function levantar(store, { conMiddleware = true } = {}) {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(session({ secret: "prueba", store, resave: false, saveUninitialized: false, rolling: true }));
  if (conMiddleware) app.use(saveSessionBeforeRedirect);
  app.post("/entrar", (req, res, next) => {
    req.session.regenerate((err) => {
      if (err) return next(err);
      req.session.user = { id: 7 };
      return res.redirect("/yo");
    });
  });
  app.post("/pendiente", (req, res) => {
    req.session.pendingEmailVerification = "ana@transworld.cl";
    res.redirect(303, "/yo");
  });
  app.get("/yo", (req, res) => res.json({ user: req.session.user || null, pending: req.session.pendingEmailVerification || null }));
  app.get("/sigue", (req, res) => res.redirect("/yo"));
  app.get("/anonimo", (req, res) => res.redirect("/entrar"));
  app.post("/salir", (req, res, next) => {
    req.session.destroy((err) => (err ? next(err) : res.redirect("/yo")));
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, () => resolve(s));
  });
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

const cookieDe = (res) => {
  const [valor] = res.headers.getSetCookie();
  return valor ? valor.split(";")[0] : "";
};
const post = (base, ruta, cookie = "") =>
  fetch(base + ruta, { method: "POST", redirect: "manual", headers: cookie ? { cookie } : {} });

describe("guardar la sesión antes de redirigir", () => {
  let store;
  let app;

  before(async () => {
    store = new SlowStore();
    app = await levantar(store);
  });

  after(() => app.server.close());

  it("el login ya está guardado cuando llega la redirección", async () => {
    const res = await post(app.base, "/entrar");
    assert.equal(res.status, 302);
    const yo = await fetch(`${app.base}/yo`, { headers: { cookie: cookieDe(res) } });
    assert.deepEqual((await yo.json()).user, { id: 7 });
  });

  it("lo mismo con un dato suelto y una redirección con estado propio", async () => {
    const res = await post(app.base, "/pendiente");
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "/yo");
    const yo = await fetch(`${app.base}/yo`, { headers: { cookie: cookieDe(res) } });
    assert.equal((await yo.json()).pending, "ana@transworld.cl");
  });

  it("una visita anónima no crea filas", async () => {
    const antes = store.writes;
    const res = await fetch(`${app.base}/anonimo`, { redirect: "manual" });
    assert.equal(res.status, 302);
    await res.text();
    assert.equal(store.writes, antes);
  });

  it("una redirección que no cambió la sesión no escribe", async () => {
    const login = await post(app.base, "/entrar");
    await login.text();
    const antes = store.writes;
    const res = await fetch(`${app.base}/sigue`, { redirect: "manual", headers: { cookie: cookieDe(login) } });
    assert.equal(res.status, 302);
    await res.text();
    assert.equal(store.writes, antes);
  });

  it("cerrar sesión redirige sin intentar guardar", async () => {
    const login = await post(app.base, "/entrar");
    await login.text();
    const cookie = cookieDe(login);
    const antes = store.writes;
    const res = await post(app.base, "/salir", cookie);
    assert.equal(res.status, 302);
    await res.text();
    assert.equal(store.writes, antes);
    const yo = await fetch(`${app.base}/yo`, { headers: { cookie } });
    assert.equal((await yo.json()).user, null);
  });

  it("si el guardado falla, redirige igual en vez de dejar la petición colgada", async () => {
    const roto = await levantar(new SlowStore({ failSet: true }));
    try {
      const res = await post(roto.base, "/pendiente");
      assert.equal(res.status, 303);
    } finally {
      roto.server.close();
    }
  });

  it("la app lo monta justo después de la sesión", () => {
    const fuente = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8");
    const sesion = fuente.indexOf("session({");
    const middleware = fuente.indexOf("app.use(saveSessionBeforeRedirect)");
    const siguiente = fuente.indexOf("app.use(", fuente.indexOf("}),\n);", sesion));
    assert.ok(sesion > 0 && middleware > sesion, "va después de session()");
    assert.equal(middleware, siguiente, "es lo primero tras session()");
  });
});

describe("el problema que evita", () => {
  it("sin el middleware, la petición siguiente llega antes que la sesión", async () => {
    const app = await levantar(new SlowStore(), { conMiddleware: false });
    try {
      const res = await post(app.base, "/entrar");
      assert.equal(res.status, 302);
      const yo = await fetch(`${app.base}/yo`, { headers: { cookie: cookieDe(res) } });
      assert.equal((await yo.json()).user, null);
    } finally {
      app.server.close();
    }
  });
});
