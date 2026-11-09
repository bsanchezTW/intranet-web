const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const express = require("express");

const { createStartupGate, RETRY_SECONDS } = require("../src/middlewares/startupGate");

/*
  Al arrancar, la app escucha antes de migrar (Passenger lo exige). Una
  petición de esos segundos llegaba a un esquema viejo: el login respondía
  "column u.active does not exist". La compuerta responde 503 hasta que
  termina el arranque de la base.
*/

describe("compuerta del arranque", () => {
  let server;
  let base;
  let gate;
  const avisos = [];

  before(async () => {
    gate = createStartupGate({ logger: { warn: (scope, msg) => avisos.push(`${scope}: ${msg}`) } });
    const app = express();
    app.get("/estatico.css", (req, res) => res.type("css").send("body{}"));
    app.use(gate.middleware);
    app.get("/login", (req, res) => res.send("formulario"));
    app.get("/api/datos", (req, res) => res.json({ ok: true }));
    await new Promise((resolve) => { server = app.listen(0, resolve); });
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  it("mientras arranca, las páginas responden 503 con una página que se recarga sola", async () => {
    const res = await fetch(`${base}/login`, { headers: { accept: "text/html" } });
    assert.equal(res.status, 503);
    assert.equal(res.headers.get("retry-after"), String(RETRY_SECONDS));
    assert.equal(res.headers.get("cache-control"), "no-store");
    const html = await res.text();
    assert.match(html, /La intranet se está actualizando/);
    assert.match(html, /http-equiv="refresh"/);
  });

  it("a un fetch le responde JSON", async () => {
    const res = await fetch(`${base}/api/datos`);
    assert.equal(res.status, 503);
    assert.match((await res.json()).error, /actualizando/);
  });

  it("lo que va antes de la compuerta (los estáticos) se sirve igual", async () => {
    const res = await fetch(`${base}/estatico.css`);
    assert.equal(res.status, 200);
  });

  it("al terminar el arranque atiende normal, sin avisos", async () => {
    gate.open();
    assert.equal(gate.isReady(), true);
    const res = await fetch(`${base}/login`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "formulario");
    assert.deepEqual(avisos, []);
  });
});

describe("compuerta del arranque — tope", () => {
  it("si el arranque no termina a tiempo, se abre igual y lo anota", async () => {
    const avisos = [];
    const gate = createStartupGate({ timeoutMs: 20, logger: { warn: (scope, msg) => avisos.push(`${scope}: ${msg}`) } });
    gate.arm();
    assert.equal(gate.isReady(), false);
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(gate.isReady(), true);
    assert.match(avisos[0], /sin terminar el arranque/);
  });

  it("abrirla dos veces no hace nada la segunda", () => {
    const avisos = [];
    const gate = createStartupGate({ logger: { warn: (s, m) => avisos.push(m) } });
    gate.open("el arranque de la base falló");
    gate.open();
    assert.equal(avisos.length, 1);
  });
});

describe("compuerta del arranque — en la app", () => {
  // Sin \r: en Windows con core.autocrlf la copia de trabajo queda en CRLF.
  const fuente = fs.readFileSync(path.join(__dirname, "..", "src", "app.js"), "utf8").replace(/\r\n/g, "\n");

  it("va después de los estáticos y antes de la sesión", () => {
    const estaticos = fuente.lastIndexOf("app.use(express.static(");
    const compuerta = fuente.indexOf("app.use(startupGate.middleware)");
    const sesion = fuente.indexOf("session({");
    assert.ok(estaticos > 0 && compuerta > estaticos, "después de los estáticos");
    assert.ok(sesion > compuerta, "antes de la sesión, que ya usa la base");
  });

  it("se abre al terminar las tareas de la base, también si fallan", () => {
    const tareas = fuente.slice(fuente.indexOf("async function runStartupDbTasks"), fuente.indexOf("function onHttpListening"));
    assert.ok(tareas.indexOf("startupGate.open()") > tareas.indexOf("for (const step of steps)"));
    assert.match(tareas, /startupGate\.arm\(\)/);
    assert.match(tareas, /\.catch\([\s\S]*startupGate\.open\(/);
  });
});
