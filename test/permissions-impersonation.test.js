const { describe, it, beforeEach, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  «Iniciar sesión como» (Gestión de Permisos): el superadmin navega con la
  identidad de otra persona. La BD es una tabla `users` en memoria y la
  auditoría se junta en un arreglo.
*/

const SRC = path.join(__dirname, "..", "src");
const dbId = require.resolve(path.join(SRC, "db"));
const prevDb = require.cache[dbId];

const users = new Map();
let auditRows = [];
let auditFails = false;

require.cache[dbId] = {
  id: dbId,
  filename: dbId,
  loaded: true,
  exports: {
    async query(sql, params) {
      if (/INSERT INTO perm_audit/.test(sql)) {
        if (auditFails) throw new Error("sin base");
        auditRows.push({ actor: params[0], action: params[1], target: params[2], note: params[4] });
        return { rows: [] };
      }
      if (/FROM users/.test(sql)) {
        const u = users.get(Number(params[0]));
        return { rows: u ? [{ ...u }] : [] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    },
  },
};

const imp = require("../src/services/permissions/impersonation");

after(() => {
  if (prevDb) require.cache[dbId] = prevDb;
  else delete require.cache[dbId];
});

const BASTIAN = { id: 1, first_name: "Bastián", last_name: "Sánchez", email: "b@t.cl", active: true, is_superadmin: true };
const ANA = { id: 5, first_name: "Ana", last_name: "Pérez", email: "a@t.cl", active: true, is_superadmin: false, work_area_id: 3, area_name: "Finanzas", area_color: "#0f0", last_login_at: null };
const OTRO_SA = { id: 6, first_name: "Otro", last_name: "Admin", email: "o@t.cl", active: true, is_superadmin: true };
const DESHABILITADA = { id: 7, first_name: "Luz", last_name: "", email: "l@t.cl", active: false, is_superadmin: false };

function sessionFor(user) {
  return { user: { id: user.id, nombre: `${user.first_name} ${user.last_name}`.trim(), role: user.role }, ticketNotifications: { count: 3 } };
}

function fakeReq({ session, method = "GET", path: p = "/", superadmin = true }) {
  return {
    session: Object.assign(session, {
      destroy(cb) {
        this.destroyed = true;
        cb();
      },
    }),
    method,
    path: p,
    originalUrl: p,
    headers: {},
    get: () => "",
    perms: { superadmin },
  };
}

function fakeRes() {
  return {
    locals: {},
    statusCode: 200,
    status(c) {
      this.statusCode = c;
      return this;
    },
    type() {
      return this;
    },
    send(b) {
      this.body = b;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
    redirect(to) {
      this.redirectedTo = to;
      return this;
    },
    clearCookie(name) {
      this.cleared = name;
    },
  };
}

async function runGuard(req) {
  const res = fakeRes();
  let nextCalled = false;
  await imp.impersonationGuard({ cookieName: "sid" })(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

beforeEach(() => {
  users.clear();
  [BASTIAN, ANA, OTRO_SA, DESHABILITADA].forEach((u) => users.set(u.id, { ...u }));
  auditRows = [];
  auditFails = false;
});

describe("impersonationRefusal", () => {
  const base = { actor: { id: 1 }, actorIsSuperadmin: true, alreadyImpersonating: false };
  it("permite a un superadmin entrar como una cuenta activa", () => {
    assert.equal(imp.impersonationRefusal({ ...base, target: ANA }), null);
  });
  it("rechaza a quien no es superadmin", () => {
    assert.match(imp.impersonationRefusal({ ...base, actorIsSuperadmin: false, target: ANA }), /superadmin/);
  });
  it("rechaza a otro superadmin, a sí mismo, a deshabilitados y encadenar", () => {
    assert.match(imp.impersonationRefusal({ ...base, target: OTRO_SA }), /otro superadmin/);
    assert.match(imp.impersonationRefusal({ ...base, target: BASTIAN }), /propia cuenta/);
    assert.match(imp.impersonationRefusal({ ...base, target: DESHABILITADA }), /deshabilitada/);
    assert.match(imp.impersonationRefusal({ ...base, alreadyImpersonating: true, target: ANA }), /vuelve a tu cuenta/);
    assert.match(imp.impersonationRefusal({ ...base, target: null }), /ya no existe/);
  });
});

describe("startImpersonation / endImpersonation", () => {
  it("cambia la sesión a la persona, guarda al superadmin y lo registra", async () => {
    const req = fakeReq({ session: sessionFor(BASTIAN) });
    const persona = await imp.startImpersonation(req, "5");
    assert.equal(persona.id, 5);
    assert.equal(req.session.user.id, 5);
    assert.equal(req.session.user.area, "Finanzas");
    // El tutorial y el cambio obligatorio de clave son de Ana, no del superadmin.
    assert.equal(req.session.user.show_home_tutorial, false);
    assert.equal(req.session.user.must_change_password, false);
    assert.equal(req.session.suplantacion.original.id, 1);
    assert.equal(req.session.ticketNotifications, undefined);
    assert.deepEqual(auditRows.map((r) => [r.actor, r.action, r.target]), [[1, "suplantacion.iniciar", 5]]);

    const targetId = await imp.endImpersonation(req);
    assert.equal(targetId, 5);
    assert.equal(req.session.user.id, 1);
    assert.equal(req.session.suplantacion, undefined);
    assert.equal(auditRows[1].action, "suplantacion.terminar");
    assert.equal(auditRows[1].actor, 1);
  });

  it("no empieza si la regla lo impide, sin tocar la sesión", async () => {
    const req = fakeReq({ session: sessionFor(BASTIAN) });
    await assert.rejects(imp.startImpersonation(req, "6"), imp.ImpersonationError);
    await assert.rejects(imp.startImpersonation(req, "abc"), imp.ImpersonationError);
    assert.equal(req.session.user.id, 1);
    assert.equal(auditRows.length, 0);
  });

  it("no encadena suplantaciones", async () => {
    const req = fakeReq({ session: sessionFor(BASTIAN) });
    await imp.startImpersonation(req, 5);
    await assert.rejects(imp.startImpersonation(req, 7), /vuelve a tu cuenta/);
  });
});

describe("impersonationGuard", () => {
  async function impersonating(opts = {}) {
    const req = fakeReq({ session: sessionFor(BASTIAN) });
    await imp.startImpersonation(req, 5);
    auditRows = [];
    return fakeReq({ session: req.session, superadmin: false, ...opts });
  }

  it("sin suplantación no hace nada", async () => {
    const { res, nextCalled } = await runGuard(fakeReq({ session: sessionFor(ANA), method: "POST" }));
    assert.equal(nextCalled, true);
    assert.equal(res.locals.suplantacion, null);
    assert.equal(auditRows.length, 0);
  });

  it("deja navegar y publica el aviso para la barra", async () => {
    const { res, nextCalled } = await runGuard(await impersonating({ path: "/RRHH" }));
    assert.equal(nextCalled, true);
    assert.equal(res.locals.suplantacion.persona.id, 5);
    assert.equal(res.locals.suplantacion.original.id, 1);
    assert.equal(auditRows.length, 0, "un GET no se registra");
  });

  it("registra cada escritura a nombre del superadmin, con método y ruta", async () => {
    const { nextCalled } = await runGuard(await impersonating({ method: "POST", path: "/vacaciones/12/aprobar" }));
    assert.equal(nextCalled, true);
    assert.equal(auditRows.length, 1);
    assert.deepEqual([auditRows[0].actor, auditRows[0].action, auditRows[0].target], [1, "suplantacion.accion", 5]);
    assert.match(auditRows[0].note, /POST \/vacaciones\/12\/aprobar/);
  });

  it("si no puede registrar la acción, no la deja pasar", async () => {
    const req = await impersonating({ method: "POST", path: "/perfil" });
    auditFails = true;
    const { res, nextCalled } = await runGuard(req);
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 503);
  });

  it("nunca cambia la contraseña de la persona suplantada", async () => {
    for (const p of ["/change-password", "/reset-password"]) {
      const { res, nextCalled } = await runGuard(await impersonating({ method: "POST", path: p }));
      assert.equal(nextCalled, false, p);
      assert.equal(res.statusCode, 403, p);
    }
  });

  it("«Cerrar sesión» vuelve a la cuenta propia", async () => {
    const req = await impersonating({ path: "/logout" });
    const { res, nextCalled } = await runGuard(req);
    assert.equal(nextCalled, false);
    assert.equal(res.redirectedTo, "/permisos/usuarios/5");
    assert.equal(req.session.user.id, 1);
    assert.equal(req.session.destroyed, undefined);
  });

  it("deja pasar «Volver a mi cuenta» sin registrarlo como acción", async () => {
    const { nextCalled } = await runGuard(await impersonating({ method: "POST", path: imp.END_PATH }));
    assert.equal(nextCalled, true);
    assert.equal(auditRows.length, 0);
  });

  it("si al superadmin le quitan la marca, cierra la sesión entera", async () => {
    const req = await impersonating({ path: "/" });
    users.get(1).is_superadmin = false;
    const { res, nextCalled } = await runGuard(req);
    assert.equal(nextCalled, false);
    assert.equal(req.session.destroyed, true);
    assert.equal(res.redirectedTo, "/login");
  });
});
