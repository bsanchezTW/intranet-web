const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const express = require("express");
const session = require("express-session");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  Escalada RRHH → administrador: el correo es la llave de la cuenta (login y
  «Olvidé mi contraseña»). Quien edita fichas no puede cambiar el correo de
  un administrador o de un superadmin por uno propio y quedarse con la
  cuenta. La BD es una tabla `users` en memoria.
*/

const SRC = path.join(__dirname, "..", "src");
const stubbed = [];

function stubModule(relPath, exports) {
  const id = require.resolve(path.join(SRC, relPath));
  stubbed.push([id, require.cache[id]]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

const users = new Map();
const updates = [];

const fakePool = {
  async query(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (/^SELECT id FROM users WHERE (email|national_id) = \$1 AND id <> \$2/.test(q)) {
      const campo = q.includes("email") ? "email" : "national_id";
      const rows = [...users.values()]
        .filter((u) => u[campo] === params[0] && String(u.id) !== String(params[1]))
        .map((u) => ({ id: u.id }));
      return { rows };
    }
    if (/^SELECT photo AS foto, .* FROM users WHERE id = \$1/.test(q)) {
      const u = users.get(Number(params[0]));
      return { rows: u ? [{ ...u, foto: null }] : [] };
    }
    if (/^SELECT is_superadmin FROM users WHERE id = \$1/.test(q)) {
      const u = users.get(Number(params[0]));
      return { rows: u ? [{ is_superadmin: Boolean(u.is_superadmin) }] : [] };
    }
    if (/^UPDATE users SET first_name=\$1/.test(q)) {
      updates.push({ email: params[6], id: params[params.length - 1] });
      return { rows: [], rowCount: 1 };
    }
    // Lo que sigue al guardado (centros de costo, historial…) no importa aquí.
    return { rows: [], rowCount: 0 };
  },
};
fakePool.queryRetryIdCollision = fakePool.query;

let server;
let baseUrl;

before(async () => {
  stubModule("db.js", fakePool);
  stubModule("services/mailer.js", { sendMail: async () => {} });
  stubModule("services/access/staffAccess.js", {
    canManageRrhh: async (user) => Boolean(user && user.rrhh),
    invalidateStaffAccess: () => {},
  });

  const rrhhRoutes = require(path.join(SRC, "routes/RRHH"));
  const { emptyPermissions, computePermissions } = require(path.join(SRC, "services/permissions/resolver"));
  const { getCatalog } = require(path.join(SRC, "services/permissions/catalog"));

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: "test", resave: false, saveUninitialized: true }));
  app.post("/__test/login", (req, res) => {
    req.session.user = {
      id: Number(req.body.id),
      role: req.body.role,
      rrhh: req.body.rrhh === "1",
      superadmin: req.body.superadmin === "1",
    };
    res.end();
  });
  app.use((req, res, next) => {
    const user = req.session && req.session.user;
    if (!user) return next();
    // Todos los permisos del catálogo, sin ser superadmin (gestiona RRHH).
    const conTodo = (userId) => {
      const catalog = getCatalog();
      const assignments = [...catalog.byKey.values()].map((p, i) => ({
        id: i + 1, principal_type: "user", user_id: userId, permission_key: p.key,
        scope: p.scopes ? (p.scopes.includes("todo") ? "todo" : p.scopes[0]) : null,
        scope_area_ids: [], effect: "concede",
      }));
      const users = new Map([[userId, { id: userId, role: "Usuario", work_area_id: 3 }]]);
      return computePermissions({ users, areas: [], sets: new Map(), assignments }, { id: userId }, { catalog });
    };
    // Quien gestiona RRHH tiene sus permisos; el resto, ninguno.
    req.perms = user.rrhh ? conTodo(user.id) : emptyPermissions(getCatalog(), user.id);
    if (user.superadmin) req.perms.superadmin = true;
    next();
  });
  app.set("views", path.join(SRC, "views"));
  app.set("view engine", "ejs");
  app.use("/RRHH", rrhhRoutes);

  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  if (server) server.close();
  for (const [id, prev] of stubbed) {
    if (prev) require.cache[id] = prev;
    else delete require.cache[id];
  }
});

function seed(overrides) {
  const user = {
    id: 5,
    first_name: "Ana",
    last_name: "Pérez",
    email: "ana@transworld.cl",
    role: "Administrador",
    email_confirmed: true,
    work_area_id: 3,
    birth_date: null,
    hire_date: null,
    national_id: null,
    phone: null,
    personal_email: null,
    work_phone: null,
    is_superadmin: false,
    ...overrides,
  };
  users.set(user.id, user);
  return user;
}

async function as(actor) {
  let cookie = "";
  const login = await fetch(`${baseUrl}/__test/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(actor).toString(),
  });
  cookie = login.headers.get("set-cookie").split(";")[0];
  return (url, form) =>
    fetch(baseUrl + url, {
      method: "POST",
      redirect: "manual",
      headers: { cookie, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
    });
}

function fichaDe(user, cambios) {
  return {
    first_name: user.first_name,
    last_name: user.last_name,
    email: user.email,
    role: user.role,
    work_area_id: String(user.work_area_id),
    ...cambios,
  };
}

const RRHH = { id: "40", role: "Administrador", rrhh: "1" };

beforeEach(() => {
  users.clear();
  updates.length = 0;
});

describe("RRHH · correo de cuentas privilegiadas", () => {
  it("RRHH no puede cambiar el correo de un administrador", async () => {
    const admin = seed({ role: "Administrador" });
    const post = await as(RRHH);
    const res = await post("/RRHH/editar/5", fichaDe(admin, { email: "atacante@gmail.com" }));
    assert.equal(res.status, 302);
    assert.match(
      decodeURIComponent(res.headers.get("location")),
      /Sólo el superadmin puede cambiar el correo de un administrador/,
    );
    assert.equal(updates.length, 0, "la ficha no se guardó");
  });

  it("tampoco el de un superadmin con rol Usuario", async () => {
    const jefe = seed({ role: "Usuario", is_superadmin: true });
    const post = await as(RRHH);
    const res = await post("/RRHH/editar/5", fichaDe(jefe, { email: "atacante@gmail.com" }));
    assert.match(decodeURIComponent(res.headers.get("location")), /Sólo el superadmin/);
    assert.equal(updates.length, 0);
  });

  it("cambiar sólo mayúsculas o espacios no cuenta como cambio de correo", async () => {
    const admin = seed({ role: "Administrador" });
    const post = await as(RRHH);
    await post("/RRHH/editar/5", fichaDe(admin, { email: " ANA@transworld.cl " }));
    assert.equal(updates.length, 1);
  });

  it("RRHH sí corrige el correo de un usuario común", async () => {
    const usuario = seed({ role: "Usuario" });
    const post = await as(RRHH);
    await post("/RRHH/editar/5", fichaDe(usuario, { email: "ana.perez@transworld.cl" }));
    assert.deepEqual(updates, [{ email: "ana.perez@transworld.cl", id: "5" }]);
  });

  it("el superadmin sí cambia el correo de un administrador", async () => {
    const admin = seed({ role: "Administrador" });
    const post = await as({ ...RRHH, superadmin: "1" });
    await post("/RRHH/editar/5", fichaDe(admin, { email: "ana.perez@transworld.cl" }));
    assert.deepEqual(updates, [{ email: "ana.perez@transworld.cl", id: "5" }]);
  });
});
