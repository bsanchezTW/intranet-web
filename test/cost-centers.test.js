const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const {
  MAX_COST_CENTERS_PER_USER,
  DDL_STATEMENTS,
} = require("../src/services/costCenters/costCenterSchema");
const {
  parseCode,
  parseName,
} = require("../src/services/costCenters/costCenterService");
const { elegirCentro } = require("../src/services/expenses/expenseRequestService");

describe("costCenters — tope por colaborador", () => {
  it("son dos, y el resto del código lo lee de aquí", () => {
    assert.equal(MAX_COST_CENTERS_PER_USER, 2);
  });
});

describe("costCenters — normalización de código y nombre", () => {
  it("el código va en mayúsculas y sin espacios de más", () => {
    assert.equal(parseCode("  cc-100  "), "CC-100");
    assert.equal(parseCode("cc  100"), "CC 100");
  });

  it("rechaza código vacío o demasiado largo", () => {
    assert.equal(parseCode(""), null);
    assert.equal(parseCode("   "), null);
    assert.equal(parseCode(null), null);
    assert.equal(parseCode("X".repeat(31)), null);
    assert.equal(parseCode("X".repeat(30)), "X".repeat(30));
  });

  it("el nombre conserva mayúsculas pero colapsa espacios", () => {
    assert.equal(parseName("  Operaciones   Santiago "), "Operaciones Santiago");
    assert.equal(parseName(""), null);
    assert.equal(parseName("N".repeat(151)), null);
  });
});

describe("costCenters — schema", () => {
  it("crea las dos tablas y las columnas heredadas de la solicitud", () => {
    const sql = DDL_STATEMENTS.join("\n");
    assert.match(sql, /CREATE TABLE IF NOT EXISTS cost_centers/);
    assert.match(sql, /CREATE TABLE IF NOT EXISTS user_cost_centers/);
    assert.match(sql, /ALTER TABLE users ADD COLUMN IF NOT EXISTS national_id/);
    for (const col of [
      "requester_name",
      "requester_national_id",
      "requester_email",
      "requester_area_name",
      "cost_center_id",
      "cost_center_code",
      "cost_center_name",
    ]) {
      assert.match(sql, new RegExp(col), col);
    }
  });

  it("el documento es único sólo entre los que lo tienen", () => {
    const sql = DDL_STATEMENTS.join("\n");
    assert.match(
      sql,
      /users_national_id_unique_idx[\s\S]*WHERE national_id IS NOT NULL/,
    );
  });

  it("el par colaborador-centro no se puede duplicar", () => {
    const sql = DDL_STATEMENTS.join("\n");
    assert.match(sql, /PRIMARY KEY \(user_id, cost_center_id\)/);
  });
});

describe("expenseRequestService — elección del centro de costo", () => {
  const dos = [
    { id: 7, code: "CC-100", name: "Operaciones" },
    { id: 9, code: "CC-200", name: "Proyectos" },
  ];
  const uno = [dos[0]];

  it("con un solo centro no hace falta elegir", () => {
    assert.equal(elegirCentro(uno, undefined).id, 7);
    assert.equal(elegirCentro(uno, null).id, 7);
    assert.equal(elegirCentro(uno, "").id, 7);
  });

  it("con un solo centro también se puede nombrar explícitamente", () => {
    assert.equal(elegirCentro(uno, 7).id, 7);
    assert.equal(elegirCentro(uno, "7").id, 7);
  });

  it("con dos centros hay que elegir uno", () => {
    assert.equal(elegirCentro(dos, undefined), null);
    assert.equal(elegirCentro(dos, "9").code, "CC-200");
  });

  it("nunca acepta un centro que no sea del colaborador", () => {
    // Un POST a mano podría mandar cualquier id: el formulario no es la defensa.
    assert.equal(elegirCentro(dos, 999), null);
    assert.equal(elegirCentro(uno, 999), null);
  });

  it("sin centros asignados no hay nada que elegir", () => {
    assert.equal(elegirCentro([], undefined), null);
    assert.equal(elegirCentro([], 7), null);
  });
});
