const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

const logger = require("../src/utils/logger");
const {
  securityHeaders,
  cspReportRouter,
  ENFORCED_CSP,
  REPORT_ONLY_CSP,
} = require("../src/middlewares/securityHeaders");

/*
  Cabeceras de seguridad en todas las respuestas y receptor de reportes CSP.
*/

let server;
let base;
const logged = [];
const originalWarn = logger.warn;

before(async () => {
  logger.warn = (tag, msg) => {
    if (tag === "csp") logged.push(msg);
  };
  const app = express();
  app.set("trust proxy", true);
  app.disable("x-powered-by");
  app.use(securityHeaders());
  app.use(cspReportRouter());
  app.get("/pagina", (req, res) => res.send("<p>hola</p>"));
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  logger.warn = originalWarn;
  server.close();
});

beforeEach(() => {
  logged.length = 0;
});

function directives(policy) {
  return new Map(
    policy.split(";").map((d) => d.trim().split(/\s+/)).map(([name, ...values]) => [name, values]),
  );
}

describe("cabeceras de seguridad", () => {
  it("van en cada respuesta", async () => {
    const res = await fetch(`${base}/pagina`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("x-frame-options"), "SAMEORIGIN");
    assert.equal(res.headers.get("referrer-policy"), "strict-origin-when-cross-origin");
    assert.match(res.headers.get("permissions-policy"), /camera=\(\)/);
    assert.equal(res.headers.get("content-security-policy"), ENFORCED_CSP);
    assert.equal(res.headers.get("content-security-policy-report-only"), REPORT_ONLY_CSP);
    assert.equal(res.headers.get("x-powered-by"), null);
  });

  it("HSTS sólo cuando la petición llegó por HTTPS", async () => {
    const http = await fetch(`${base}/pagina`);
    assert.equal(http.headers.get("strict-transport-security"), null);
    const https = await fetch(`${base}/pagina`, { headers: { "x-forwarded-proto": "https" } });
    assert.equal(https.headers.get("strict-transport-security"), "max-age=15552000");
  });

  it("la CSP aplicada impide enmarcar la intranet desde otro sitio, sin tocar scripts", () => {
    const csp = directives(ENFORCED_CSP);
    assert.deepEqual(csp.get("frame-ancestors"), ["'self'"]);
    assert.deepEqual(csp.get("object-src"), ["'none'"]);
    assert.ok(!csp.has("script-src"), "aplicar script-src hoy rompería los inline");
  });

  it("la CSP en reporte no permite scripts inline ni eval: es la meta", () => {
    const csp = directives(REPORT_ONLY_CSP);
    const scripts = csp.get("script-src");
    assert.ok(!scripts.includes("'unsafe-inline'"));
    assert.ok(!scripts.includes("'unsafe-eval'"));
    assert.deepEqual(csp.get("report-uri"), ["/csp-report"]);
  });
});

describe("/csp-report", () => {
  function report(body, type = "application/csp-report", headers = {}) {
    return fetch(`${base}/csp-report`, {
      method: "POST",
      headers: { "content-type": type, ...headers },
      body: JSON.stringify(body),
    });
  }

  const violacion = {
    "csp-report": {
      "document-uri": "https://intranet/perfil",
      "violated-directive": "script-src-elem",
      "blocked-uri": "inline",
      "source-file": "https://intranet/perfil",
      "line-number": 12,
    },
  };

  it("registra la violación y responde 204", async () => {
    const res = await report(violacion);
    assert.equal(res.status, 204);
    await new Promise((r) => setImmediate(r));
    assert.equal(logged.length, 1);
    assert.match(logged[0], /script-src-elem bloquearía inline en https:\/\/intranet\/perfil:12/);
  });

  it("el mismo reporte se registra una sola vez por hora", async () => {
    const otra = { "csp-report": { ...violacion["csp-report"], "line-number": 99 } };
    await report(otra);
    await report(otra);
    await new Promise((r) => setImmediate(r));
    assert.equal(logged.length, 1);
  });

  it("acepta el formato de la Reporting API", async () => {
    const res = await report(
      [{ type: "csp-violation", body: { effectiveDirective: "img-src", blockedURL: "http://x/y.png", documentURL: "https://intranet/" } }],
      "application/reports+json",
    );
    assert.equal(res.status, 204);
    await new Promise((r) => setImmediate(r));
    assert.match(logged[0], /img-src bloquearía http:\/\/x\/y\.png/);
  });

  it("rechaza cuerpos grandes sin registrar nada", async () => {
    const res = await report({ "csp-report": { "blocked-uri": "x".repeat(20000) } });
    assert.equal(res.status, 413);
    assert.equal(logged.length, 0);
  });

  it("tope por IP: no se puede inundar el log", async () => {
    for (let i = 0; i < 70; i += 1) {
      await report({ "csp-report": { "violated-directive": "img-src", "blocked-uri": `http://spam/${i}` } }, "application/csp-report", { "x-forwarded-for": "203.0.113.9" });
    }
    await new Promise((r) => setImmediate(r));
    assert.ok(logged.length <= 60, `se registraron ${logged.length}`);
  });
});
