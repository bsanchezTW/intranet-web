const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const express = require("express");
const session = require("express-session");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  Escalada RRHH: el correo es la llave de la cuenta (login y «Olvidé mi
  contraseña»). Quien edita fichas no puede cambiar el correo de alguien con
  permisos que él no tiene (o de un superadmin) por uno propio y quedarse con
  esa cuenta. Además, el interruptor «Cuenta de intranet» reemplaza al rol.
  La BD es una tabla `users` en memoria y los permisos de cada persona salen
  de su campo `permisos`.
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
    if (/^UPDATE users SET first_name=\$1/.test(q)) {
      updates.push({ email: params[6], active: params[2], id: params[params.length - 1] });
      return { rows: [], rowCount: 1 };
    }
    // Lo que sigue al guardado (centros de costo, historial…) no importa aquí.
    return { rows: [], rowCount: 0 };
  },
};
fakePool.queryRetryIdCollision = fakePool.query;

let server;
let baseUrl;

// Lo que tiene quien gestiona RRHH en estas pruebas: personas y organigrama.
const CLAVES_RRHH = (catalog) => [...catalog.byKey.keys()].filter((k) => /^(rrhh|organigrama)\./.test(k));

before(async () => {
  stubModule("db.js", fakePool);
  stubModule("services/mailer.js", { sendMail: async () => {} });

  const { emptyPermissions, computePermissions } = require(path.join(SRC, "services/permissions/resolver"));
  const { getCatalog } = require(path.join(SRC, "services/permissions/catalog"));

  function conClaves(userId, keys) {
    const catalog = getCatalog();
    const assignments = keys.map((key, i) => {
      const p = catalog.byKey.get(key);
      return {
        id: i + 1, principal_type: "user", user_id: userId, permission_key: key,
        scope: p.scopes ? (p.scopes.includes("todo") ? "todo" : p.scopes[0]) : null,
        scope_area_ids: [], effect: "concede",
      };
    });
    const people = new Map([[userId, { id: userId, active: true, work_area_id: 3 }]]);
    return computePermissions({ users: people, areas: [], sets: new Map(), assignments }, { id: userId }, { catalog });
  }

  // Los permisos de la persona editada (RRHH.js los pide para el correo).
  stubModule("services/permissions/permissionService.js", {
    invalidatePermissions: () => {},
    async resolve({ id }) {
      const u = users.get(Number(id));
      const p = conClaves(Number(id), (u && u.permisos) || []);
      if (u && u.is_superadmin) p.superadmin = true;
      return p;
    },
  });

  const rrhhRoutes = require(path.join(SRC, "routes/RRHH"));

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: "test", resave: false, saveUninitialized: true }));
  app.post("/__test/login", (req, res) => {
    req.session.user = {
      id: Number(req.body.id),
      rrhh: req.body.rrhh === "1",
      superadmin: req.body.superadmin === "1",
    };
    res.end();
  });
  app.use((req, res, next) => {
    const user = req.session && req.session.user;
    if (!user) return next();
    req.perms = user.rrhh ? conClaves(user.id, CLAVES_RRHH(getCatalog())) : emptyPermissions(getCatalog(), user.id);
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
    active: true,
    email_confirmed: true,
    work_area_id: 3,
    birth_date: null,
    hire_date: null,
    national_id: null,
    phone: null,
    personal_email: null,
    work_phone: null,
    is_superadmin: false,
    permisos: [],
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
    work_area_id: String(user.work_area_id),
    ...cambios,
  };
}

const RRHH = { id: "40", rrhh: "1" };

beforeEach(() => {
  users.clear();
  updates.length = 0;
});

describe("RRHH · correo de cuentas con más permisos", () => {
  it("RRHH no cambia el correo de alguien con permisos que RRHH no tiene", async () => {
    const editora = seed({ permisos: ["noticias.acceso", "noticias.noticia.crear"] });
    const post = await as(RRHH);
    const res = await post("/RRHH/editar/5", fichaDe(editora, { email: "atacante@gmail.com" }));
    assert.equal(res.status, 302);
    assert.match(
      decodeURIComponent(res.headers.get("location")),
      /Sólo el superadmin puede cambiar el correo de alguien con permisos que tú no tienes/,
    );
    assert.equal(updates.length, 0, "la ficha no se guardó");
  });

  it("tampoco el de un superadmin", async () => {
    const jefe = seed({ is_superadmin: true });
    const post = await as(RRHH);
    const res = await post("/RRHH/editar/5", fichaDe(jefe, { email: "atacante@gmail.com" }));
    assert.match(decodeURIComponent(res.headers.get("location")), /Sólo el superadmin/);
    assert.equal(updates.length, 0);
  });

  it("cambiar sólo mayúsculas o espacios no cuenta como cambio de correo", async () => {
    const editora = seed({ permisos: ["noticias.acceso", "noticias.noticia.crear"] });
    const post = await as(RRHH);
    await post("/RRHH/editar/5", fichaDe(editora, { email: " ANA@transworld.cl " }));
    assert.equal(updates.length, 1);
  });

  it("RRHH sí corrige el correo de quien no tiene más permisos", async () => {
    const usuario = seed({ permisos: ["rrhh.acceso", "rrhh.directorio.ver"] });
    const post = await as(RRHH);
    await post("/RRHH/editar/5", fichaDe(usuario, { email: "ana.perez@transworld.cl" }));
    assert.deepEqual(updates.map((u) => [u.email, u.id]), [["ana.perez@transworld.cl", "5"]]);
  });

  it("el superadmin sí cambia el correo de cualquiera", async () => {
    const editora = seed({ permisos: ["noticias.acceso", "noticias.noticia.crear"] });
    const post = await as({ ...RRHH, superadmin: "1" });
    await post("/RRHH/editar/5", fichaDe(editora, { email: "ana.perez@transworld.cl" }));
    assert.deepEqual(updates.map((u) => [u.email, u.id]), [["ana.perez@transworld.cl", "5"]]);
  });
});

describe("RRHH · interruptor de la cuenta", () => {
  it("desactiva con el interruptor apagado", async () => {
    const usuario = seed({});
    const post = await as(RRHH);
    await post("/RRHH/editar/5", fichaDe(usuario, { estado_cuenta: "1" }));
    assert.deepEqual(updates.map((u) => u.active), [false]);
  });

  it("activa con el interruptor encendido", async () => {
    const usuario = seed({ active: false });
    const post = await as(RRHH);
    await post("/RRHH/editar/5", fichaDe(usuario, { estado_cuenta: "1", active: "1" }));
    assert.deepEqual(updates.map((u) => u.active), [true]);
  });

  it("sin el interruptor en el formulario la cuenta queda como estaba", async () => {
    const usuario = seed({});
    const post = await as(RRHH);
    await post("/RRHH/editar/5", fichaDe(usuario, { first_name: "Anita" }));
    assert.deepEqual(updates.map((u) => u.active), [true]);
  });

  it("sin correo verificado no se puede activar", async () => {
    const usuario = seed({ active: false, email_confirmed: false });
    const post = await as(RRHH);
    await post("/RRHH/editar/5", fichaDe(usuario, { estado_cuenta: "1", active: "1" }));
    assert.deepEqual(updates.map((u) => u.active), [false]);
  });

  it("RRHH no desactiva a un superadmin", async () => {
    const jefe = seed({ is_superadmin: true });
    const post = await as(RRHH);
    const res = await post("/RRHH/editar/5", fichaDe(jefe, { estado_cuenta: "1" }));
    assert.equal(res.status, 403);
    assert.equal(updates.length, 0);
  });

  it("nadie se desactiva a sí mismo", async () => {
    const yo = seed({ id: 40 });
    const post = await as(RRHH);
    const res = await post("/RRHH/editar/40", fichaDe(yo, { estado_cuenta: "1" }));
    assert.equal(res.status, 403);
    assert.equal(updates.length, 0);
  });
});
