const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  safeReturnTo,
  rememberReturnTo,
  consumeReturnTo,
} = require("../src/utils/returnTo");

describe("safeReturnTo", () => {
  it("acepta la ruta de una noticia", () => {
    assert.equal(safeReturnTo("/noticias/13"), "/noticias/13");
  });

  it("conserva query string interna", () => {
    assert.equal(
      safeReturnTo("/noticias/13?ok=correo_enviado"),
      "/noticias/13?ok=correo_enviado",
    );
  });

  it("rechaza redirects abiertos", () => {
    assert.equal(safeReturnTo("https://evil.example/"), "/");
    assert.equal(safeReturnTo("//evil.example"), "/");
    assert.equal(safeReturnTo("/\\evil.example"), "/");
  });

  it("no vuelve al login ni a otras pantallas de auth", () => {
    assert.equal(safeReturnTo("/login"), "/");
    assert.equal(safeReturnTo("/logout"), "/");
    assert.equal(safeReturnTo("/register"), "/");
    assert.equal(safeReturnTo("/reset-password"), "/");
  });
});

describe("rememberReturnTo / consumeReturnTo", () => {
  it("guarda un GET y lo consume una sola vez", () => {
    const req = { method: "GET", originalUrl: "/noticias/13", session: {} };
    rememberReturnTo(req);
    assert.equal(req.session.returnTo, "/noticias/13");
    assert.equal(consumeReturnTo(req.session), "/noticias/13");
    assert.equal(req.session.returnTo, undefined);
    assert.equal(consumeReturnTo(req.session), "/");
  });

  it("no guarda POST", () => {
    const req = { method: "POST", originalUrl: "/noticias/13", session: {} };
    rememberReturnTo(req);
    assert.equal(req.session.returnTo, undefined);
  });
});
