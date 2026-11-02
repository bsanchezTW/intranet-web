const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { runMigrations, validateMigrations } = require("../src/services/schema/migrator");
const migrations = require("../src/migrations");

/*
  Migraciones versionadas: cada una en su transacción, con search_path local
  y bajo un lock, anotada en <schema>.schema_migrations.
*/

/** Cliente de pg en memoria: registra sentencias y simula la tabla. */
function fakeClient({ applied = [], failOn = null } = {}) {
  const done = new Set(applied);
  const pending = [];
  const log = [];
  let inTx = false;
  return {
    log,
    done,
    released: false,
    async query(sql, params = []) {
      const q = sql.replace(/\s+/g, " ").trim();
      log.push(q);
      if (q === "BEGIN") { inTx = true; pending.length = 0; return { rows: [] }; }
      if (q === "COMMIT") { inTx = false; pending.forEach((id) => done.add(id)); return { rows: [] }; }
      if (q === "ROLLBACK") { inTx = false; pending.length = 0; return { rows: [] }; }
      if (/^SELECT 1 FROM \w+\.schema_migrations WHERE id = \$1/.test(q)) {
        return { rows: done.has(params[0]) ? [{ "?column?": 1 }] : [] };
      }
      if (/^INSERT INTO \w+\.schema_migrations/.test(q)) { pending.push(params[0]); return { rows: [] }; }
      if (failOn && q.includes(failOn)) throw new Error("permiso denegado");
      if (/^(SET LOCAL|LOCK TABLE)/.test(q)) assert.ok(inTx, `${q} fuera de una transacción`);
      return { rows: [] };
    },
    release() { this.released = true; },
  };
}

const silent = { info() {} };
const m = (id, sql = `-- ${id}`) => ({ id, up: (client) => client.query(sql) });

describe("runMigrations", () => {
  it("aplica las pendientes en orden, cada una con search_path local y lock", async () => {
    const client = fakeClient({ applied: ["001_a"] });
    const r = await runMigrations({
      connect: async () => client,
      schema: "chile",
      migrations: [m("001_a"), m("002_b"), m("003_c")],
      logger: silent,
    });
    assert.deepEqual(r, { applied: ["002_b", "003_c"], skipped: ["001_a"] });
    const segunda = client.log.slice(client.log.indexOf("-- 002_b") - 4, client.log.indexOf("-- 002_b") + 3);
    assert.deepEqual(segunda.map((q) => q.split(" ").slice(0, 2).join(" ")), [
      "BEGIN",
      "SET LOCAL",
      "LOCK TABLE",
      "SELECT 1",
      "-- 002_b",
      "INSERT INTO",
      "COMMIT",
    ]);
    assert.ok(client.log.includes("SET LOCAL search_path TO chile"));
    assert.ok(client.released);
  });

  it("si una falla, la revierte, no sigue y avisa cuál fue", async () => {
    const client = fakeClient({ failOn: "ALTER malo" });
    await assert.rejects(
      runMigrations({
        connect: async () => client,
        schema: "chile",
        migrations: [m("001_a"), m("002_b", "ALTER malo"), m("003_c")],
        logger: silent,
      }),
      (err) => err.migrationId === "002_b" && /permiso denegado/.test(err.message),
    );
    assert.deepEqual([...client.done], ["001_a"]);
    assert.ok(!client.log.includes("-- 003_c"));
    assert.ok(client.released, "el cliente vuelve al pool aunque falle");
  });

  it("una segunda corrida no aplica nada", async () => {
    const client = fakeClient();
    const lista = [m("001_a"), m("002_b")];
    await runMigrations({ connect: async () => client, schema: "chile", migrations: lista, logger: silent });
    const r = await runMigrations({ connect: async () => client, schema: "chile", migrations: lista, logger: silent });
    assert.deepEqual(r.applied, []);
  });

  it("rechaza un schema inválido", async () => {
    await assert.rejects(runMigrations({ connect: async () => fakeClient(), schema: "x;y", migrations: [] }), /schema inválido/);
  });
});

describe("las migraciones de la intranet", () => {
  it("tienen ids únicos, con número y en orden", () => {
    assert.doesNotThrow(() => validateMigrations(migrations));
    assert.throws(() => validateMigrations([m("002_b"), m("001_a")]), /fuera de orden/);
    assert.throws(() => validateMigrations([m("001_a"), m("001_a")]), /repetida/);
    assert.throws(() => validateMigrations([{ id: "sin_numero", up() {} }]), /inválida/);
  });

  it("no califican tablas con un schema: corren con el search_path del país", async () => {
    const client = fakeClient();
    await runMigrations({ connect: async () => client, schema: "peru", migrations, logger: silent });
    const ddl = client.log.filter((q) => /^(ALTER|CREATE (UNIQUE )?INDEX|DO)/.test(q));
    assert.ok(ddl.length >= 5);
    assert.ok(ddl.every((q) => !/\b(chile|peru)\./.test(q)), "ninguna nombra un schema");
  });
});
