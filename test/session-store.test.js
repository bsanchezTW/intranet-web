const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");

const { PgSessionStore } = require("../src/services/session/pgSessionStore");

/*
  Sesiones en Postgres: sobreviven a un reinicio, las comparten los procesos,
  vencen, no escriben en cada clic y cada país tiene su tabla. La base es un
  doble en memoria que entiende las sentencias del store y anota cada una.
*/

function fakeDb({ clock }) {
  const tables = new Map();
  const log = [];
  const table = (name) => {
    if (!tables.has(name)) throw Object.assign(new Error(`relation ${name} does not exist`), { code: "42P01" });
    return tables.get(name);
  };
  return {
    log,
    tables,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, " ").trim();
      log.push(q);
      let m;
      if ((m = /^CREATE TABLE IF NOT EXISTS (\w+\.sessions)/.exec(q))) {
        if (!tables.has(m[1])) tables.set(m[1], new Map());
        return { rows: [], rowCount: 0 };
      }
      if (/^CREATE INDEX IF NOT EXISTS/.test(q)) return { rows: [], rowCount: 0 };
      if ((m = /^SELECT sess, expire FROM (\w+\.sessions) WHERE sid = \$1 AND expire > NOW\(\)/.exec(q))) {
        const row = table(m[1]).get(params[0]);
        return { rows: row && row.expire > clock.now() ? [{ sess: JSON.parse(row.sess), expire: new Date(row.expire) }] : [] };
      }
      if ((m = /^INSERT INTO (\w+\.sessions) \(sid, sess, expire\)/.exec(q))) {
        table(m[1]).set(params[0], { sess: params[1], expire: params[2].getTime() });
        return { rows: [], rowCount: 1 };
      }
      if ((m = /^UPDATE (\w+\.sessions) SET expire = \$2 WHERE sid = \$1/.exec(q))) {
        const row = table(m[1]).get(params[0]);
        if (row) row.expire = params[1].getTime();
        return { rows: [], rowCount: row ? 1 : 0 };
      }
      if ((m = /^DELETE FROM (\w+\.sessions) WHERE sid = \$1/.exec(q))) {
        return { rows: [], rowCount: table(m[1]).delete(params[0]) ? 1 : 0 };
      }
      if ((m = /^DELETE FROM (\w+\.sessions) WHERE expire <= NOW\(\)/.exec(q))) {
        let n = 0;
        for (const [sid, row] of table(m[1])) {
          if (row.expire <= clock.now()) {
            table(m[1]).delete(sid);
            n += 1;
          }
        }
        return { rows: [], rowCount: n };
      }
      throw new Error(`Consulta no simulada: ${q}`);
    },
  };
}

function makeClock(start = Date.UTC(2026, 10, 2, 12)) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

function promisify(store, method, ...args) {
  return new Promise((resolve, reject) => {
    store[method](...args, (err, value) => (err ? reject(err) : resolve(value)));
  });
}

const HOUR = 60 * 60 * 1000;

function sessionData(clock, extra = {}) {
  return {
    cookie: { originalMaxAge: 4 * HOUR, expires: new Date(clock.now() + 4 * HOUR).toISOString(), httpOnly: true, path: "/" },
    ...extra,
  };
}

describe("PgSessionStore", () => {
  let clock;
  let db;
  beforeEach(() => {
    clock = makeClock();
    db = fakeDb({ clock });
  });

  it("guarda en la tabla del schema del país y la crea la primera vez", async () => {
    const store = new PgSessionStore({ db, schema: "chile", now: clock.now });
    await promisify(store, "set", "abc", sessionData(clock, { user: { id: 7 } }));
    assert.ok(db.tables.has("chile.sessions"));
    assert.equal(db.log.filter((q) => q.startsWith("CREATE TABLE")).length, 1);
    assert.ok(db.log.every((q) => !/ sessions\b/.test(q) || /chile\.sessions/.test(q)), "nunca usa la tabla sin schema");
  });

  it("una sesión sobrevive a un reinicio del proceso", async () => {
    const antes = new PgSessionStore({ db, schema: "chile", now: clock.now });
    await promisify(antes, "set", "abc", sessionData(clock, { user: { id: 7 } }));
    const despues = new PgSessionStore({ db, schema: "chile", now: clock.now });
    const sess = await promisify(despues, "get", "abc");
    assert.equal(sess.user.id, 7);
  });

  it("la cookie de un país no abre una sesión en el otro", async () => {
    const chile = new PgSessionStore({ db, schema: "chile", now: clock.now });
    const peru = new PgSessionStore({ db, schema: "peru", now: clock.now });
    await promisify(chile, "set", "abc", sessionData(clock, { user: { id: 7 } }));
    assert.equal(await promisify(peru, "get", "abc"), null);
  });

  it("una sesión vencida no se entrega y prune la borra", async () => {
    const store = new PgSessionStore({ db, schema: "chile", now: clock.now });
    await promisify(store, "set", "abc", sessionData(clock));
    clock.advance(4 * HOUR + 1);
    assert.equal(await promisify(store, "get", "abc"), null);
    assert.equal(await store.prune(), 1);
    assert.equal(db.tables.get("chile.sessions").size, 0);
  });

  it("touch sólo escribe cuando el vencimiento avanzó más que el intervalo", async () => {
    const store = new PgSessionStore({ db, schema: "chile", now: clock.now, touchIntervalMs: 5 * 60 * 1000 });
    await promisify(store, "set", "abc", sessionData(clock));
    const updates = () => db.log.filter((q) => q.startsWith("UPDATE")).length;

    clock.advance(60 * 1000);
    await promisify(store, "touch", "abc", sessionData(clock));
    assert.equal(updates(), 0, "un clic al minuto no escribe");

    clock.advance(5 * 60 * 1000);
    await promisify(store, "touch", "abc", sessionData(clock));
    assert.equal(updates(), 1);
    assert.equal(db.tables.get("chile.sessions").get("abc").expire, clock.now() + 4 * HOUR);
  });

  it("destroy la borra", async () => {
    const store = new PgSessionStore({ db, schema: "chile", now: clock.now });
    await promisify(store, "set", "abc", sessionData(clock));
    await promisify(store, "destroy", "abc");
    assert.equal(await promisify(store, "get", "abc"), null);
  });

  it("si crear la tabla falla, lo reintenta en el siguiente uso", async () => {
    let falla = true;
    const flaky = {
      query: (sql, params) => {
        if (falla && sql.includes("CREATE TABLE")) {
          falla = false;
          return Promise.reject(new Error("pooler caído"));
        }
        return db.query(sql, params);
      },
    };
    const store = new PgSessionStore({ db: flaky, schema: "chile", now: clock.now });
    await assert.rejects(promisify(store, "set", "abc", sessionData(clock)), /pooler caído/);
    await promisify(store, "set", "abc", sessionData(clock));
    assert.ok(await promisify(store, "get", "abc"));
  });

  it("rechaza un schema que no sea un identificador simple", () => {
    assert.throws(() => new PgSessionStore({ db, schema: "chile; DROP TABLE users" }), /schema inválido/);
    assert.throws(() => new PgSessionStore({ db, schema: "" }), /schema inválido/);
  });
});

describe("PgSessionStore con express-session", () => {
  it("el login persiste entre dos procesos que comparten la base", async () => {
    const clock = makeClock(Date.now());
    const db = fakeDb({ clock });

    function app() {
      const a = express();
      a.use(
        session({
          name: "sid",
          secret: "test",
          store: new PgSessionStore({ db, schema: "chile", now: clock.now }),
          resave: false,
          saveUninitialized: false,
          rolling: true,
          cookie: { maxAge: 4 * HOUR, httpOnly: true, sameSite: "lax", secure: "auto" },
        }),
      );
      a.post("/login", (req, res) => {
        req.session.user = { id: 7 };
        res.end("ok");
      });
      a.get("/yo", (req, res) => res.json({ user: req.session.user || null }));
      return a;
    }

    const listen = (a) => new Promise((resolve) => {
      const s = a.listen(0, () => resolve(s));
    });
    const [s1, s2] = await Promise.all([listen(app()), listen(app())]);
    try {
      const login = await fetch(`http://127.0.0.1:${s1.address().port}/login`, { method: "POST" });
      const setCookie = login.headers.get("set-cookie");
      assert.match(setCookie, /HttpOnly/i);
      assert.match(setCookie, /SameSite=Lax/i);
      // Por HTTP plano no se marca Secure (con "auto" sólo va por HTTPS).
      assert.doesNotMatch(setCookie, /;\s*Secure/i);

      const cookie = setCookie.split(";")[0];
      const res = await fetch(`http://127.0.0.1:${s2.address().port}/yo`, { headers: { cookie } });
      assert.deepEqual(await res.json(), { user: { id: 7 } });
    } finally {
      s1.close();
      s2.close();
    }
  });
});
