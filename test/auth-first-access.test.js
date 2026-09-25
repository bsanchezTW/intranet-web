const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  Primer acceso con clave temporal: el login, el código de verificación y la
  nueva contraseña terminan con la sesión abierta, sin volver al login. Y el
  botón «Enviar contraseña temporal» de RR.HH. deja la cuenta lista para ese
  flujo. La BD es una tabla `users` en memoria y el correo no sale.
*/

const SRC = path.join(__dirname, "..", "src");
const stubbed = [];

function stubModule(relPath, exports) {
  const id = require.resolve(path.join(SRC, relPath));
  stubbed.push([id, require.cache[id]]);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}

function pbkdf2Hash(password, saltHex) {
  return crypto
    .pbkdf2Sync(String(password), Buffer.from(saltHex, "hex"), 120000, 32, "sha256")
    .toString("hex");
}

const users = new Map();
const mails = [];

const fakePool = {
  async query(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (/^SELECT .* FROM users u( LEFT JOIN work_areas at .*)? WHERE u\.(email|id) = \$1/.test(q)) {
      const byEmail = /WHERE u\.email = \$1/.test(q);
      const row = [...users.values()].find((u) =>
        byEmail ? u.email === params[0] : String(u.id) === String(params[0]),
      );
      return { rows: row ? [{ ...row, area_name: "TI", area_color: null }] : [] };
    }
    if (/^SELECT .* FROM users WHERE (email|id) = \$1/.test(q)) {
      const byEmail = /WHERE email = \$1/.test(q);
      const row = [...users.values()].find((u) =>
        byEmail ? u.email === params[0] : String(u.id) === String(params[0]),
      );
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/^UPDATE users SET confirm_token = \$1, confirm_expires = \$2 WHERE id = \$3/.test(q)) {
      Object.assign(users.get(params[2]), { confirm_token: params[0], confirm_expires: params[1] });
      return { rows: [] };
    }
    if (/^UPDATE users SET email_confirmed = TRUE/.test(q)) {
      Object.assign(users.get(params[0]), {
        email_confirmed: true,
        confirm_token: null,
        confirm_expires: null,
        role: params[1],
        is_intranet_user: params[2],
      });
      return { rows: [] };
    }
    if (/^UPDATE users SET password_hash = \$1, password_salt = \$2, must_change_password = FALSE WHERE id = \$3/.test(q)) {
      Object.assign(users.get(Number(params[2])), {
        password_hash: params[0],
        password_salt: params[1],
        must_change_password: false,
      });
      return { rows: [] };
    }
    if (/^UPDATE users SET password_hash = \$1, password_salt = \$2, email_confirmed = FALSE, must_change_password = TRUE/.test(q)) {
      Object.assign(users.get(Number(params[2])), {
        password_hash: params[0],
        password_salt: params[1],
        email_confirmed: false,
        must_change_password: true,
        is_intranet_user: true,
        confirm_token: null,
        confirm_expires: null,
      });
      return { rows: [] };
    }
    throw new Error(`Consulta no simulada: ${q}`);
  },
};
fakePool.queryRetryIdCollision = fakePool.query;

let server;
let baseUrl;

before(async () => {
  process.env.AUTH_USER = "";
  process.env.AUTH_PASS = "";
  stubModule("db.js", fakePool);
  stubModule("services/mailer.js", {
    sendMail: async (msg) => {
      mails.push(msg);
    },
  });
  stubModule("services/access/staffAccess.js", {
    canManageRrhh: async (user) => user && user.role === "Administrador",
  });

  const authRoutes = require(path.join(SRC, "routes/auth"));
  const rrhhRoutes = require(path.join(SRC, "routes/RRHH"));

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: "test", resave: false, saveUninitialized: true }));
  app.set("views", path.join(SRC, "views"));
  app.set("view engine", "ejs");
  app.use((req, res, next) => {
    res.locals.countryConfig = { name: "Chile" };
    next();
  });
  app.post("/__test/as-admin", (req, res) => {
    req.session.user = { id: 99, role: "Administrador" };
    res.end();
  });
  app.use("/", authRoutes);
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

/** Navegador mínimo: guarda la cookie de sesión y no sigue redirecciones. */
function browser() {
  let cookie = "";
  return async function request(method, url, form) {
    const res = await fetch(baseUrl + url, {
      method,
      redirect: "manual",
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
        ...(method === "POST" && url.startsWith("/RRHH/enviar-clave")
          ? { "X-Requested-With": "fetch" }
          : {}),
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  };
}

function seedUser(overrides = {}) {
  const salt = crypto.randomBytes(16).toString("hex");
  const user = {
    id: 5,
    first_name: "Ana",
    last_name: "Pérez",
    email: "ana@transworld.cl",
    role: "Deshabilitado",
    email_confirmed: false,
    password_salt: salt,
    password_hash: pbkdf2Hash("temporal1", salt),
    photo: null,
    must_change_password: true,
    confirm_token: null,
    confirm_expires: null,
    home_tutorial_seen: false,
    last_login_at: null,
    work_area_id: 3,
    ...overrides,
  };
  users.set(user.id, user);
  return user;
}

beforeEach(() => {
  users.clear();
  mails.length = 0;
});

describe("primer acceso con contraseña temporal", () => {
  it("tras crear la nueva contraseña entra directo a la intranet", async () => {
    seedUser();
    const request = browser();

    let res = await request("POST", "/login", {
      username: "ana",
      domain: "transworld.cl",
      password: "temporal1",
    });
    assert.equal(res.status, 302);
    assert.match(res.headers.get("location"), /^\/verify-email/);

    const code = users.get(5).confirm_token;
    assert.match(code, /^\d{6}$/);

    res = await request("POST", "/verify-email", { code });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/reset-password?confirmed=1");
    assert.equal(users.get(5).role, "Usuario");

    res = await request("POST", "/reset-password", {
      new_password: "NuevaClave#2026",
      confirm_password: "NuevaClave#2026",
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/?changed=1");
    assert.equal(users.get(5).must_change_password, false);

    // La sesión quedó abierta: el login ya no se muestra, redirige adentro.
    res = await request("GET", "/login");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/");
  });

  it("sin verificación pendiente en la sesión no cambia ninguna clave", async () => {
    const { password_hash: original } = seedUser();
    const request = browser();
    const res = await request("POST", "/reset-password", {
      new_password: "NuevaClave#2026",
      confirm_password: "NuevaClave#2026",
    });
    assert.equal(res.headers.get("location"), "/login");
    assert.equal(users.get(5).password_hash, original);
  });
});

describe("RRHH · enviar contraseña temporal", () => {
  it("deja al deshabilitado listo para el primer acceso y le manda el correo", async () => {
    const { password_hash: original } = seedUser({
      email_confirmed: true,
      must_change_password: false,
    });
    const request = browser();
    await request("POST", "/__test/as-admin");

    const res = await request("POST", "/RRHH/enviar-clave/5");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);

    const after = users.get(5);
    assert.notEqual(after.password_hash, original);
    assert.equal(after.email_confirmed, false);
    assert.equal(after.must_change_password, true);
    assert.equal(mails.length, 1);
    assert.equal(mails[0].to, "ana@transworld.cl");

    // La clave del correo sirve para iniciar el flujo de primer acceso.
    const temporal = mails[0].text.match(/contraseña temporal es: (\w+)/)[1];
    const user = browser();
    const login = await user("POST", "/login", {
      username: "ana",
      domain: "transworld.cl",
      password: temporal,
    });
    assert.match(login.headers.get("location"), /^\/verify-email/);
  });

  it("no envía a usuarios habilitados ni sin correo", async () => {
    const request = browser();
    await request("POST", "/__test/as-admin");

    seedUser({ role: "Usuario", email_confirmed: true });
    let res = await request("POST", "/RRHH/enviar-clave/5");
    assert.equal(res.status, 400);

    seedUser({ id: 6, email: null });
    res = await request("POST", "/RRHH/enviar-clave/6");
    assert.equal(res.status, 400);
    assert.equal(mails.length, 0);
  });
});
