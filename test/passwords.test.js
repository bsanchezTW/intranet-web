const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const { hashPassword, verifyPassword, isLegacyHash, CURRENT } = require("../src/services/auth/passwords");

/*
  Contraseñas: scrypt asíncrono con parámetros en el propio hash, y el
  PBKDF2 antiguo aceptado para migrarlo al iniciar sesión.
*/

function legacy(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, Buffer.from(salt, "hex"), 120000, 32, "sha256").toString("hex");
  return { password_hash: hash, password_salt: salt };
}

describe("hashPassword / verifyPassword", () => {
  it("el hash nuevo es scrypt con sus parámetros y sin columna de sal", async () => {
    const { hash, salt } = await hashPassword("Clave#2026");
    assert.match(hash, /^scrypt\$N=16384,r=8,p=5\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/);
    assert.equal(salt, null);
    assert.deepEqual(await verifyPassword("Clave#2026", { password_hash: hash }), { ok: true, needsRehash: false });
    assert.equal((await verifyPassword("clave#2026", { password_hash: hash })).ok, false);
  });

  it("dos hashes de la misma clave son distintos (sal aleatoria)", async () => {
    const [a, b] = await Promise.all([hashPassword("x"), hashPassword("x")]);
    assert.notEqual(a.hash, b.hash);
  });

  it("acepta el PBKDF2 antiguo y pide migrarlo", async () => {
    const guardado = legacy("Vieja#2026");
    assert.equal(isLegacyHash(guardado.password_hash), true);
    assert.deepEqual(await verifyPassword("Vieja#2026", guardado), { ok: true, needsRehash: true });
    assert.deepEqual(await verifyPassword("otra", guardado), { ok: false, needsRehash: false });
    assert.equal((await verifyPassword("Vieja#2026", { password_hash: guardado.password_hash })).ok, false, "sin sal no hay verificación");
  });

  it("un hash scrypt con parámetros viejos pide rehash", async () => {
    const salt = crypto.randomBytes(16);
    const derived = crypto.scryptSync("x", salt, 32, { N: 1024, r: 8, p: 1 });
    const viejo = `scrypt$N=1024,r=8,p=1$${salt.toString("base64url")}$${derived.toString("base64url")}`;
    assert.deepEqual(await verifyPassword("x", { password_hash: viejo }), { ok: true, needsRehash: true });
    assert.notEqual(CURRENT.N, 1024);
  });

  it("un hash alterado para pedir memoria enorme se rechaza sin calcular", async () => {
    for (const malo of [
      "scrypt$N=1073741824,r=8,p=5$AAAA$AAAA",
      "scrypt$N=1000,r=8,p=5$AAAA$AAAA",
      "scrypt$N=16384,r=999,p=5$AAAA$AAAA",
      "scrypt$N=16384$AAAA$AAAA",
      "scrypt$basura",
    ]) {
      assert.deepEqual(await verifyPassword("x", { password_hash: malo }), { ok: false, needsRehash: false }, malo);
    }
  });

  it("vacíos o tipos raros no verifican", async () => {
    assert.equal((await verifyPassword("x", {})).ok, false);
    assert.equal((await verifyPassword("x", { password_hash: null })).ok, false);
    assert.equal((await verifyPassword(undefined, legacy("x"))).ok, false);
  });

  it("no bloquea el event loop mientras calcula", async () => {
    let ticks = 0;
    const timer = setInterval(() => { ticks += 1; }, 1);
    await Promise.all([hashPassword("a"), hashPassword("b"), hashPassword("c")]);
    clearInterval(timer);
    assert.ok(ticks > 0, "el intervalo siguió corriendo durante el hash");
  });
});
