const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { lockedDdl } = require("../src/services/schema/lockedDdl");

/*
  DDL de "crear si no existe" en una sola consulta con lock asesor de
  transacción: dos procesos que arrancan a la vez no chocan en los catálogos.
  La prueba contra Postgres real está en test/pg-integration.test.js.
*/

describe("lockedDdl", () => {
  it("pone el lock primero y une las sentencias en una sola consulta", () => {
    const sql = lockedDdl("chile.sessions", [
      "CREATE TABLE IF NOT EXISTS chile.sessions (sid text);",
      "CREATE INDEX IF NOT EXISTS sessions_idx ON chile.sessions (sid)",
    ]);
    assert.equal(
      sql,
      "SELECT pg_advisory_xact_lock(hashtext('chile.sessions'));\n" +
        "CREATE TABLE IF NOT EXISTS chile.sessions (sid text);\n" +
        "CREATE INDEX IF NOT EXISTS sessions_idx ON chile.sessions (sid);",
    );
  });

  it("es un lock de transacción, no de sesión (el pooler no conserva los de sesión)", () => {
    const sql = lockedDdl("chile.job_runs", "CREATE TABLE IF NOT EXISTS chile.job_runs (x int)");
    assert.match(sql, /pg_advisory_xact_lock/);
    assert.doesNotMatch(sql, /pg_advisory_lock\(/);
  });

  it("rechaza una clave que podría romper el literal SQL", () => {
    for (const malo of ["chile'; DROP TABLE users; --", "", "Chile.Sessions", null]) {
      assert.throws(() => lockedDdl(malo, ["SELECT 1"]), /clave de lock inválida/, String(malo));
    }
  });

  it("exige al menos una sentencia", () => {
    assert.throws(() => lockedDdl("chile.x", []), /faltan sentencias/);
    assert.throws(() => lockedDdl("chile.x", [" ; "]), /faltan sentencias/);
  });
});
