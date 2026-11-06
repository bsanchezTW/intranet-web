const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { markSuperadminByEmail } = require("../src/services/permissions/breakGlass");

/*
  Recuperación de acceso desde el servidor (scripts/superadmin.js), en
  reemplazo del login de emergencia por la web.
*/

function fakes(users) {
  const calls = [];
  return {
    calls,
    db: {
      async query(sql, params) {
        assert.match(sql, /LOWER\(TRIM\(email\)\) = \$1/);
        return { rows: users.filter((u) => u.email.trim().toLowerCase() === params[0]) };
      },
    },
    store: {
      async setSuperadmin(id, value, actorId) {
        calls.push({ id, value, actorId });
      },
    },
  };
}

const ANA = { id: 5, first_name: "Ana", last_name: "Pérez", email: "Ana@Transworld.cl", active: true };

describe("markSuperadminByEmail", () => {
  it("marca a la cuenta por correo, sin importar mayúsculas, con actor vacío (el servidor)", async () => {
    const { db, store, calls } = fakes([ANA]);
    const user = await markSuperadminByEmail({ db, store, email: " ana@transworld.cl " });
    assert.equal(user.id, 5);
    assert.deepEqual(calls, [{ id: 5, value: true, actorId: null }]);
  });

  it("--quitar desmarca", async () => {
    const { db, store, calls } = fakes([ANA]);
    await markSuperadminByEmail({ db, store, email: "ana@transworld.cl", remove: true });
    assert.deepEqual(calls, [{ id: 5, value: false, actorId: null }]);
  });

  it("no marca una cuenta deshabilitada ni una que no existe", async () => {
    const { db, store, calls } = fakes([{ ...ANA, active: false }]);
    await assert.rejects(markSuperadminByEmail({ db, store, email: "ana@transworld.cl" }), /deshabilitada/);
    await assert.rejects(markSuperadminByEmail({ db, store, email: "nadie@transworld.cl" }), /No hay una cuenta/);
    await assert.rejects(markSuperadminByEmail({ db, store, email: "" }), /Indica el correo/);
    assert.equal(calls.length, 0);
  });
});
