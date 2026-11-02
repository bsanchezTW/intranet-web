const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const express = require("express");

const {
  crossOriginProtection,
  decideCrossOrigin,
  trustedHostsFrom,
} = require("../src/middlewares/crossOriginProtection");

/*
  CSRF: un formulario o un fetch de otro sitio no puede cambiar nada usando
  la sesión de quien visita esa página. Se decide con Sec-Fetch-Site y, si no
  viene, con Origin.
*/

const HOST = "intranet.transworld.cl";
const trusted = new Set([HOST]);

function decide(overrides) {
  return decideCrossOrigin({ method: "POST", host: HOST, trustedHosts: trusted, ...overrides }).allowed;
}

describe("decideCrossOrigin", () => {
  it("los métodos seguros pasan siempre", () => {
    for (const method of ["GET", "HEAD", "OPTIONS", "get"]) {
      assert.equal(decide({ method, secFetchSite: "cross-site", origin: "https://evil.com" }), true, method);
    }
  });

  it("Sec-Fetch-Site: pasa same-origin y none; no same-site ni cross-site", () => {
    assert.equal(decide({ secFetchSite: "same-origin" }), true);
    assert.equal(decide({ secFetchSite: "none" }), true);
    assert.equal(decide({ secFetchSite: "cross-site" }), false);
    assert.equal(decide({ secFetchSite: "same-site", origin: `https://otro.transworld.cl` }), false, "un subdominio no es la intranet");
  });

  it("Sec-Fetch-Site manda sobre Origin", () => {
    // Página con Referrer-Policy estricta: Origin null, pero el navegador
    // igual dice que es del mismo origen.
    assert.equal(decide({ secFetchSite: "same-origin", origin: "null" }), true);
    assert.equal(decide({ secFetchSite: "cross-site", origin: `https://${HOST}` }), false);
  });

  it("sin Sec-Fetch-Site, Origin debe ser la intranet", () => {
    assert.equal(decide({ origin: `https://${HOST}` }), true);
    assert.equal(decide({ origin: `http://${HOST}` }), true, "el esquema no importa, el host sí");
    assert.equal(decide({ origin: "https://evil.com" }), false);
    assert.equal(decide({ origin: `https://${HOST}.evil.com` }), false);
    assert.equal(decide({ origin: "null" }), false);
    assert.equal(decide({ origin: "file://" }), false);
  });

  it("acepta el Host de la petición aunque no esté en la lista", () => {
    assert.equal(
      decideCrossOrigin({ method: "POST", origin: "http://localhost:3000", host: "localhost:3000", trustedHosts: new Set() }).allowed,
      true,
    );
  });

  it("detrás de un proxy que reescribe Host vale el de APP_BASE_URL", () => {
    assert.equal(decide({ origin: `https://${HOST}`, host: "127.0.0.1:3000" }), true);
  });

  it("sin cabeceras de navegador pasa: no hay sesión de víctima", () => {
    assert.equal(decide({}), true);
  });

  it("toma los hosts de APP_BASE_URL y CSRF_TRUSTED_ORIGINS", () => {
    const hosts = trustedHostsFrom({
      APP_BASE_URL: "https://Intranet.Transworld.cl/",
      CSRF_TRUSTED_ORIGINS: "https://otra.transworld.cl, basura, ",
    });
    assert.deepEqual([...hosts].sort(), ["intranet.transworld.cl", "otra.transworld.cl"]);
  });
});

describe("crossOriginProtection en una app", () => {
  let server;
  let port;
  let handled;

  before(async () => {
    const app = express();
    app.use(crossOriginProtection({ trustedHosts: trusted, exempt: (req) => req.path === "/reporte" }));
    app.use(express.urlencoded({ extended: true }));
    app.post("/accion", (req, res) => {
      handled += 1;
      res.json({ ok: true });
    });
    app.post("/reporte", (req, res) => res.status(204).end());
    await new Promise((resolve) => {
      server = app.listen(0, resolve);
    });
    port = server.address().port;
  });

  after(() => server.close());

  function post(path, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { port, path, method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", ...headers } },
        (res) => {
          let body = "";
          res.on("data", (c) => { body += c; });
          res.on("end", () => resolve({ status: res.statusCode, body }));
        },
      );
      req.on("error", reject);
      req.end("a=1");
    });
  }

  it("un formulario de otro sitio no llega a la ruta", async () => {
    handled = 0;
    const res = await post("/accion", { "sec-fetch-site": "cross-site", origin: "https://evil.com" });
    assert.equal(res.status, 403);
    assert.match(res.body, /no viene de la intranet/);
    assert.equal(handled, 0);
  });

  it("responde JSON a un fetch rechazado", async () => {
    const res = await post("/accion", { origin: "https://evil.com", accept: "application/json" });
    assert.equal(res.status, 403);
    assert.ok(JSON.parse(res.body).error);
  });

  it("la intranet sí llega", async () => {
    handled = 0;
    const res = await post("/accion", { "sec-fetch-site": "same-origin", origin: `https://${HOST}` });
    assert.equal(res.status, 200);
    assert.equal(handled, 1);
  });

  it("una ruta exenta recibe de otro origen", async () => {
    const res = await post("/reporte", { "sec-fetch-site": "cross-site" });
    assert.equal(res.status, 204);
  });
});
