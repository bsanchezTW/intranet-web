const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const express = require("express");
const session = require("express-session");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  Autenticación endurecida:
    - el código de verificación admite 5 intentos (contados en la base) y
      después se invalida; los reenvíos tienen tope por cuenta;
    - el login frena las contraseñas erradas por cuenta y todo lo sin sesión
      tiene tope por IP;
    - «Olvidé mi contraseña» ya no pisa la clave: manda un enlace de un solo
      uso que vence.
  La BD es una tabla `users` en memoria que imita los WHERE reales.
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

function byEmail(email) {
  return [...users.values()].find((u) => u.email === email);
}

function byResetHash(hash) {
  return [...users.values()].find(
    (u) =>
      u.password_reset_token_hash === hash &&
      u.password_reset_expires instanceof Date &&
      u.password_reset_expires > new Date(),
  );
}

const fakePool = {
  async query(sql, params = []) {
    const q = sql.replace(/\s+/g, " ").trim();
    if (/^SELECT .* FROM users u( LEFT JOIN work_areas at .*)? WHERE u\.(email|id) = \$1/.test(q)) {
      const porCorreo = /WHERE u\.email = \$1/.test(q);
      const row = porCorreo ? byEmail(params[0]) : users.get(Number(params[0]));
      return { rows: row ? [{ ...row, area_name: "TI", area_color: null }] : [] };
    }
    if (/^SELECT .* FROM users WHERE email = \$1/.test(q)) {
      const row = byEmail(params[0]);
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/^UPDATE users SET confirm_token = \$1, confirm_expires = \$2, confirm_attempts = 0 WHERE id = \$3/.test(q)) {
      Object.assign(users.get(params[2]), {
        confirm_token: params[0],
        confirm_expires: params[1],
        confirm_attempts: 0,
      });
      return { rows: [] };
    }
    if (/^UPDATE users SET confirm_attempts = COALESCE\(confirm_attempts, 0\) \+ 1 WHERE id = \$1 AND confirm_token IS NOT NULL RETURNING/.test(q)) {
      const u = users.get(Number(params[0]));
      if (!u || u.confirm_token == null) return { rows: [] };
      u.confirm_attempts = (u.confirm_attempts || 0) + 1;
      return { rows: [{ confirm_attempts: u.confirm_attempts, confirm_token: u.confirm_token }] };
    }
    if (/^UPDATE users SET confirm_token = NULL, confirm_expires = NULL WHERE id = \$1$/.test(q)) {
      Object.assign(users.get(Number(params[0])), { confirm_token: null, confirm_expires: null });
      return { rows: [] };
    }
    if (/^UPDATE users SET email_confirmed = TRUE/.test(q)) {
      Object.assign(users.get(params[0]), {
        email_confirmed: true,
        confirm_token: null,
        confirm_expires: null,
        confirm_attempts: 0,
        role: params[1],
      });
      return { rows: [] };
    }
    if (/^UPDATE users SET password_reset_token_hash = \$1, password_reset_expires = NOW\(\) \+ \$2::interval WHERE id = \$3/.test(q)) {
      const minutes = Number(String(params[1]).split(" ")[0]);
      Object.assign(users.get(Number(params[2])), {
        password_reset_token_hash: params[0],
        password_reset_expires: new Date(Date.now() + minutes * 60000),
      });
      return { rows: [] };
    }
    if (/^SELECT id FROM users WHERE password_reset_token_hash = \$1 AND password_reset_expires > NOW\(\)/.test(q)) {
      const row = byResetHash(params[0]);
      return { rows: row ? [{ id: row.id }] : [] };
    }
    if (/^UPDATE users SET password_hash = \$1, password_salt = \$2, must_change_password = FALSE, password_reset_token_hash = NULL, password_reset_expires = NULL WHERE password_reset_token_hash = \$3 AND password_reset_expires > NOW\(\) RETURNING id, email/.test(q)) {
      const row = byResetHash(params[2]);
      if (!row) return { rows: [] };
      Object.assign(row, {
        password_hash: params[0],
        password_salt: params[1],
        must_change_password: false,
        password_reset_token_hash: null,
        password_reset_expires: null,
      });
      return { rows: [{ id: row.id, email: row.email }] };
    }
    throw new Error(`Consulta no simulada: ${q}`);
  },
};
fakePool.queryRetryIdCollision = fakePool.query;

let server;
let baseUrl;
let throttle;

before(async () => {
  process.env.AUTH_USER = "";
  process.env.AUTH_PASS = "";
  stubModule("db.js", fakePool);
  stubModule("services/mailer.js", {
    sendMail: async (msg) => {
      mails.push(msg);
    },
  });

  throttle = require(path.join(SRC, "services/access/authThrottle"));
  const authRoutes = require(path.join(SRC, "routes/auth"));

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: "test", resave: false, saveUninitialized: true }));
  app.set("views", path.join(SRC, "views"));
  app.set("view engine", "ejs");
  app.locals.formatPageTitle = require(path.join(SRC, "utils/pageTitle")).formatPageTitle;
  app.locals.phoneClientConfig = require(path.join(SRC, "utils/phone")).phoneClientConfig;
  app.use((req, res, next) => {
    res.locals.countryConfig = require(path.join(SRC, "config/country")).getCountryConfig();
    res.locals.country = res.locals.countryConfig.code;
    res.locals.features = require(path.join(SRC, "config/features")).getFeatures();
    next();
  });
  app.use("/", authRoutes);

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
    role: "Usuario",
    email_confirmed: true,
    password_salt: salt,
    password_hash: pbkdf2Hash("Clave#Vieja2026", salt),
    photo: null,
    must_change_password: false,
    confirm_token: null,
    confirm_expires: null,
    confirm_attempts: 0,
    password_reset_token_hash: null,
    password_reset_expires: null,
    home_tutorial_seen: true,
    last_login_at: new Date(),
    work_area_id: 3,
    ...overrides,
  };
  users.set(user.id, user);
  return user;
}

/** Cuenta con código vigente, como queda tras registrarse. */
function seedPending(code = "123456") {
  return seedUser({
    role: "Deshabilitado",
    email_confirmed: false,
    must_change_password: true,
    confirm_token: code,
    confirm_expires: new Date(Date.now() + 15 * 60000),
  });
}

const LOGIN = { username: "ana", domain: "transworld.cl" };
const NUEVA = { new_password: "Clave#Nueva2026", confirm_password: "Clave#Nueva2026" };

function tokenFromMail(mail) {
  return mail.cta.href.match(/token=([A-Za-z0-9_-]+)/)[1];
}

beforeEach(() => {
  users.clear();
  mails.length = 0;
  throttle.resetAll();
});

describe("código de verificación", () => {
  it("se genera con el CSPRNG, no con Math.random", () => {
    const source = fs.readFileSync(path.join(SRC, "routes/auth.js"), "utf8");
    assert.doesNotMatch(source.replace(/\/\/.*$/gm, ""), /Math\.random/);
    assert.match(source, /crypto\.randomInt\(0, 1000000\)/);
  });

  it("acepta el código correcto antes de agotar los intentos", async () => {
    seedPending("123456");
    const request = browser();
    for (const code of ["000001", "000002"]) {
      const res = await request("POST", "/verify-email", { email: "ana@transworld.cl", code });
      assert.equal(res.status, 400);
    }
    const res = await request("POST", "/verify-email", { email: "ana@transworld.cl", code: "123456" });
    assert.equal(res.status, 302);
    assert.equal(users.get(5).email_confirmed, true);
    assert.equal(users.get(5).confirm_attempts, 0);
  });

  it("avisa cuántos intentos quedan", async () => {
    seedPending();
    const res = await browser()("POST", "/verify-email", { email: "ana@transworld.cl", code: "000000" });
    assert.match(await res.text(), /Te quedan 4 intentos/);
  });

  it("al quinto error invalida el código: ni el correcto sirve después", async () => {
    seedPending("123456");
    const request = browser();
    for (let i = 0; i < 4; i += 1) {
      await request("POST", "/verify-email", { email: "ana@transworld.cl", code: `00000${i}` });
    }
    const quinto = await request("POST", "/verify-email", { email: "ana@transworld.cl", code: "000009" });
    assert.equal(quinto.status, 429);
    assert.equal(users.get(5).confirm_token, null);

    const correcto = await request("POST", "/verify-email", { email: "ana@transworld.cl", code: "123456" });
    assert.equal(correcto.status, 400);
    assert.equal(users.get(5).email_confirmed, false);
  });

  it("muchos intentos en paralelo no comparan más de cinco veces", async () => {
    seedPending("123456");
    const request = browser();
    const intentos = Array.from({ length: 30 }, (_, i) =>
      request("POST", "/verify-email", {
        email: "ana@transworld.cl",
        code: String(100000 + i).padStart(6, "0"),
      }),
    );
    await Promise.all(intentos);
    assert.equal(users.get(5).confirm_token, null, "el código quedó invalidado");
    assert.equal(users.get(5).email_confirmed, false);
  });

  it("los reenvíos tienen tope por cuenta", async () => {
    seedPending();
    const request = browser();
    for (let i = 0; i < 3; i += 1) {
      const res = await request("POST", "/verify-email/resend", { email: "ana@transworld.cl" });
      assert.equal(res.status, 302);
    }
    const cuarto = await request("POST", "/verify-email/resend", { email: "ana@transworld.cl" });
    assert.equal(cuarto.status, 429);
    assert.match(await cuarto.text(), /Ya te enviamos varios códigos/);
    assert.equal(mails.length, 3);
  });

  it("un código nuevo trae sus cinco intentos", async () => {
    seedPending();
    users.get(5).confirm_attempts = 4;
    await browser()("POST", "/verify-email/resend", { email: "ana@transworld.cl" });
    assert.equal(users.get(5).confirm_attempts, 0);
    assert.match(users.get(5).confirm_token, /^\d{6}$/);
  });
});

describe("login", () => {
  it("tras cinco contraseñas erradas bloquea la cuenta un rato, aunque la sexta sea correcta", async () => {
    seedUser();
    const request = browser();
    for (let i = 0; i < 5; i += 1) {
      const res = await request("POST", "/login", { ...LOGIN, password: `mala${i}` });
      assert.equal(res.status, 401);
    }
    const res = await request("POST", "/login", { ...LOGIN, password: "Clave#Vieja2026" });
    assert.equal(res.status, 429);
    assert.match(await res.text(), /Demasiados intentos fallidos/);
  });

  it("el bloqueo es por cuenta: no afecta a otra persona", async () => {
    seedUser();
    seedUser({ id: 6, email: "beto@transworld.cl" });
    const request = browser();
    for (let i = 0; i < 5; i += 1) {
      await request("POST", "/login", { ...LOGIN, password: `mala${i}` });
    }
    const otra = await request("POST", "/login", {
      username: "beto",
      domain: "transworld.cl",
      password: "Clave#Vieja2026",
    });
    assert.equal(otra.status, 302);
  });

  it("un login correcto reinicia la cuenta de errores", async () => {
    seedUser();
    for (let i = 0; i < 4; i += 1) {
      await browser()("POST", "/login", { ...LOGIN, password: `mala${i}` });
    }
    assert.equal((await browser()("POST", "/login", { ...LOGIN, password: "Clave#Vieja2026" })).status, 302);
    for (let i = 0; i < 4; i += 1) {
      await browser()("POST", "/login", { ...LOGIN, password: `mala${i}` });
    }
    assert.equal((await browser()("POST", "/login", { ...LOGIN, password: "Clave#Vieja2026" })).status, 302);
  });

  it("tope por IP para todo lo que no tiene sesión", async () => {
    const tope = throttle.LIMITS.ip.max;
    const request = browser();
    // Usuarios distintos e inexistentes: sólo cuenta la IP.
    for (let i = 0; i < tope; i += 1) {
      await request("POST", "/login", { username: `nadie${i}`, domain: "transworld.cl", password: "x" });
    }
    const res = await request("POST", "/forgot-password", LOGIN);
    assert.equal(res.status, 429);
    assert.ok(Number(res.headers.get("retry-after")) > 0);
    assert.match(await res.text(), /Demasiadas solicitudes desde tu red/);
  });
});

describe("recuperar contraseña con enlace de un solo uso", () => {
  it("pedir el enlace no cambia la contraseña ni la expone", async () => {
    const { password_hash: original } = seedUser();
    const res = await browser()("POST", "/forgot-password", LOGIN);
    assert.equal(res.headers.get("location"), "/login?reset=1");
    assert.equal(users.get(5).password_hash, original);

    const token = tokenFromMail(mails[0]);
    assert.match(mails[0].text, new RegExp(`/reset-password\\?token=${token}`));
    // En la base queda sólo el hash.
    assert.notEqual(users.get(5).password_reset_token_hash, token);
    assert.equal(
      users.get(5).password_reset_token_hash,
      crypto.createHash("sha256").update(token).digest("hex"),
    );
  });

  it("el enlace abre el formulario y crea la contraseña una sola vez", async () => {
    seedUser();
    await browser()("POST", "/forgot-password", LOGIN);
    const token = tokenFromMail(mails[0]);
    const request = browser();

    const pagina = await request("GET", `/reset-password?token=${token}`);
    assert.equal(pagina.status, 200);
    assert.equal(pagina.headers.get("referrer-policy"), "same-origin");
    assert.match(pagina.headers.get("cache-control"), /no-store/);
    assert.match(await pagina.text(), new RegExp(`name="reset_token" value="${token}"`));

    const res = await request("POST", "/reset-password", { reset_token: token, ...NUEVA });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/login?changed=1");
    assert.equal(users.get(5).password_reset_token_hash, null);

    // La nueva sirve, la vieja no.
    assert.equal((await browser()("POST", "/login", { ...LOGIN, password: NUEVA.new_password })).status, 302);
    assert.equal((await browser()("POST", "/login", { ...LOGIN, password: "Clave#Vieja2026" })).status, 401);

    // Reusar el enlace no vuelve a cambiarla.
    const hashActual = users.get(5).password_hash;
    const reuso = await request("POST", "/reset-password", {
      reset_token: token,
      new_password: "Otra#Clave2026",
      confirm_password: "Otra#Clave2026",
    });
    assert.equal(reuso.status, 400);
    assert.match(await reuso.text(), /no es válido, ya se usó o venció/);
    assert.equal(users.get(5).password_hash, hashActual);
  });

  it("un enlace vencido no sirve", async () => {
    seedUser();
    await browser()("POST", "/forgot-password", LOGIN);
    const token = tokenFromMail(mails[0]);
    users.get(5).password_reset_expires = new Date(Date.now() - 1000);

    assert.equal((await browser()("GET", `/reset-password?token=${token}`)).status, 400);
    const res = await browser()("POST", "/reset-password", { reset_token: token, ...NUEVA });
    assert.equal(res.status, 400);
  });

  it("rechaza un token mal formado sin consultar la base", async () => {
    seedUser();
    for (const token of ["", "abc", "x".repeat(200), "<script>"]) {
      const res = await browser()("GET", `/reset-password?token=${encodeURIComponent(token)}`);
      assert.equal(res.status, 400, token);
    }
  });

  it("si las contraseñas no cumplen, conserva el enlace para reintentar", async () => {
    seedUser();
    await browser()("POST", "/forgot-password", LOGIN);
    const token = tokenFromMail(mails[0]);
    const res = await browser()("POST", "/reset-password", {
      reset_token: token,
      new_password: "corta",
      confirm_password: "corta",
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), new RegExp(`name="reset_token" value="${token}"`));
    assert.ok(users.get(5).password_reset_token_hash, "el enlace sigue vigente");
  });

  it("responde igual si la cuenta no existe, sin mandar correo", async () => {
    const res = await browser()("POST", "/forgot-password", { username: "nadie", domain: "transworld.cl" });
    assert.equal(res.headers.get("location"), "/login?reset=1");
    assert.equal(mails.length, 0);
  });

  it("tope de enlaces por cuenta, con la misma respuesta", async () => {
    seedUser();
    for (let i = 0; i < 4; i += 1) {
      const res = await browser()("POST", "/forgot-password", LOGIN);
      assert.equal(res.headers.get("location"), "/login?reset=1");
    }
    assert.equal(mails.length, 3);
  });

  it("pedir un enlace nuevo anula el anterior", async () => {
    seedUser();
    await browser()("POST", "/forgot-password", LOGIN);
    await browser()("POST", "/forgot-password", LOGIN);
    const [primero, segundo] = mails.map(tokenFromMail);
    assert.equal((await browser()("GET", `/reset-password?token=${primero}`)).status, 400);
    assert.equal((await browser()("GET", `/reset-password?token=${segundo}`)).status, 200);
  });
});
