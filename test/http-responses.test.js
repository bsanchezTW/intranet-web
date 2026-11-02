const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const {
  wantsJson,
  denyUnauthenticated,
  denyForbidden,
  respondNotFound,
} = require("../src/utils/httpResponses");

/*
  Una sola forma de responder 401/403/404 en todos los middlewares: antes
  había 10 copias de wantsJsonResponse con criterios distintos.
*/

function req({ url = "/x", method = "GET", headers = {}, xhr = false } = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    method,
    originalUrl: url,
    url,
    xhr,
    headers: lower,
    session: {},
    get: (name) => lower[name.toLowerCase()],
  };
}

function res() {
  const out = { statusCode: 200, body: null, redirectTo: null, view: null };
  out.status = (code) => { out.statusCode = code; return out; };
  out.json = (body) => { out.body = body; return out; };
  out.redirect = (to) => { out.statusCode = 302; out.redirectTo = to; return out; };
  out.render = (view, locals) => { out.view = view; out.locals = locals; return out; };
  return out;
}

describe("wantsJson", () => {
  it("reconoce fetch, Accept/Content-Type JSON y rutas de API o subida", () => {
    for (const r of [
      req({ xhr: true }),
      req({ headers: { "X-Requested-With": "fetch" } }),
      req({ headers: { Accept: "application/json" } }),
      req({ method: "POST", headers: { "Content-Type": "application/json" } }),
      req({ url: "/vacaciones/api/saldo" }),
      req({ url: "/marketing/eventos/x/fotos/upload" }),
      req({ url: "/gastos/adjuntos/upload?x=1" }),
      req({ url: "/gastos/adjuntos/descartar" }),
    ]) {
      assert.equal(wantsJson(r), true, r.originalUrl);
    }
  });

  it("una navegación normal pide HTML", () => {
    assert.equal(wantsJson(req({ url: "/RRHH/personal", headers: { Accept: "text/html" } })), false);
    assert.equal(wantsJson(req({ url: "/uploads-viejos/x" })), false, "no basta con contener 'upload'");
  });
});

describe("respuestas", () => {
  it("sin sesión: 401 JSON a un fetch, login a una página (recordando a dónde volver)", () => {
    const api = res();
    denyUnauthenticated(req({ url: "/api/x" }), api);
    assert.equal(api.statusCode, 401);
    assert.match(api.body.error, /Sesión expirada/);

    const pagina = req({ url: "/RRHH/personal" });
    const html = res();
    denyUnauthenticated(pagina, html);
    assert.equal(html.redirectTo, "/login");
    assert.equal(pagina.session.returnTo, "/RRHH/personal");
  });

  it("sin permiso: 403 con el mensaje del módulo o la página de acceso no permitido", () => {
    const api = res();
    denyForbidden(req({ xhr: true }), api, "Sólo Finanzas.");
    assert.deepEqual([api.statusCode, api.body], [403, { error: "Sólo Finanzas." }]);
    const html = res();
    denyForbidden(req(), html);
    assert.deepEqual([html.statusCode, html.view], [403, "acceso_no_permitido"]);
  });

  it("no existe: 404 JSON o la página 404", () => {
    const api = res();
    respondNotFound(req({ url: "/api/x" }), api);
    assert.deepEqual([api.statusCode, api.body], [404, { error: "No encontrado" }]);
    const html = res();
    respondNotFound(req(), html);
    assert.equal(html.view, "404");
  });
});

describe("los middlewares responden igual", () => {
  it("un fetch a /upload recibe JSON de requireRole y de requireRrhhManager (antes no)", async () => {
    const requireRole = require(path.join(__dirname, "../src/middlewares/requireRole"));
    const staffId = require.resolve(path.join(__dirname, "../src/services/access/staffAccess"));
    const prev = require.cache[staffId];
    require.cache[staffId] = { id: staffId, filename: staffId, loaded: true, exports: { canManageRrhh: async () => false } };
    const rrhhId = require.resolve(path.join(__dirname, "../src/middlewares/requireRrhhManager"));
    delete require.cache[rrhhId];
    try {
      const requireRrhhManager = require(rrhhId);
      const fetchUpload = () => {
        const r = req({ url: "/RRHH/vacaciones/gestion/5/historial/upload", method: "POST" });
        r.session.user = { id: 5, role: "Usuario" };
        return r;
      };
      const a = res();
      requireRole("admin")(fetchUpload(), a, () => {});
      const b = res();
      await requireRrhhManager()(fetchUpload(), b, () => {});
      assert.equal(a.statusCode, 403);
      assert.equal(b.statusCode, 403);
      assert.ok(a.body && b.body, "los dos respondieron JSON");
    } finally {
      if (prev) require.cache[staffId] = prev;
      else delete require.cache[staffId];
      delete require.cache[rrhhId];
    }
  });
});
