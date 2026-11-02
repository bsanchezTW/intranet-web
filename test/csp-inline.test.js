const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const ejs = require("ejs");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { securityHeaders, strictCsp, enforceStrictCsp } = require("../src/middlewares/securityHeaders");

/*
  CSP estricta posible: sin onclick/onerror inline, sin javascript: y con
  nonce en cada <script> inline de las vistas.
*/

const VIEWS = path.join(__dirname, "..", "src", "views");

function viewFiles(dir = VIEWS) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "emails" ? [] : viewFiles(full);
    return entry.name.endsWith(".ejs") ? [full] : [];
  });
}

function hallazgos(regex) {
  const out = [];
  for (const file of viewFiles()) {
    const source = fs.readFileSync(file, "utf8");
    for (const m of source.matchAll(regex)) {
      out.push(`${path.relative(VIEWS, file)}:${source.slice(0, m.index).split("\n").length}`);
    }
  }
  return out;
}

describe("vistas sin JavaScript inline fuera de <script> con nonce", () => {
  it("no hay atributos on*= (onclick, onerror…)", () => {
    assert.deepEqual(hallazgos(/<[a-z][^>]*\son[a-z]+\s*=/gi), []);
  });

  it("no hay enlaces javascript:", () => {
    assert.deepEqual(hallazgos(/(href|src|action)\s*=\s*["']\s*javascript:/gi), []);
  });

  it("cada <script> inline lleva el nonce de la petición", () => {
    assert.deepEqual(
      hallazgos(/<script(?![^>]*\bsrc=)(?![^>]*\bnonce=)(?![^>]*type="application\/json")[^>]*>/gi),
      [],
    );
  });
});

describe("datos de las acciones", () => {
  it("un nombre de app con comillas viaja como JSON y no se ejecuta", async () => {
    const malicioso = "x');alert(1);//";
    const html = await ejs.renderFile(path.join(VIEWS, "partials/app-card.ejs"), {
      app: { id: 7, name: malicioso, description: "línea 1\nlínea 2", url_apk: "https://x/app.apk", url_ios: "/content/ios.pdf", notified: false },
      index: 0,
      allowNotify: true,
      can: () => true,
    }).catch((err) => {
      // La tarjeta necesita más locals de la vista; si falla por eso, el
      // test no prueba nada: que lo diga.
      throw new Error(`no se pudo renderizar app-card: ${err.message}`);
    });
    assert.doesNotMatch(html, /onclick/);
    const editar = html.match(/data-accion="abrirModalEditar" data-args="([^"]*)"/);
    assert.ok(editar, "la acción de editar está");
    const args = JSON.parse(editar[1].replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">"));
    assert.equal(args[0], "7");
    assert.equal(args[1], malicioso, "el nombre llega tal cual, como dato");
    assert.equal(args[2], "línea 1 línea 2");
  });
});

describe("cabeceras CSP con nonce", () => {
  function correr(enforce) {
    const headers = {};
    const res = { locals: {}, set: (k, v) => { headers[k.toLowerCase()] = v; } };
    securityHeaders({ enforce })({ secure: false }, res, () => {});
    return { headers, nonce: res.locals.cspNonce };
  }

  it("cada petición tiene su nonce, y va en la política", () => {
    const a = correr(false);
    const b = correr(false);
    assert.match(a.nonce, /^[A-Za-z0-9+/]{22}==$/);
    assert.notEqual(a.nonce, b.nonce);
    assert.ok(a.headers["content-security-policy-report-only"].includes(`'nonce-${a.nonce}'`));
    assert.doesNotMatch(a.headers["content-security-policy"], /script-src/);
  });

  it("con CSP_ENFORCE=true la estricta se aplica", () => {
    const { headers, nonce } = correr(true);
    assert.equal(headers["content-security-policy"], strictCsp(nonce));
    assert.equal(headers["content-security-policy-report-only"], undefined);
    assert.equal(enforceStrictCsp({ CSP_ENFORCE: "true" }), true);
    assert.equal(enforceStrictCsp({}), false);
  });

  it("la estricta no admite 'unsafe-inline' ni 'unsafe-eval' en scripts", () => {
    const script = strictCsp("n").split(";").find((d) => d.trim().startsWith("script-src"));
    assert.doesNotMatch(script, /unsafe-inline|unsafe-eval/);
  });
});
