const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  exposeErrorDetails,
  isUserFacingError,
  publicErrorMessage,
  userError,
} = require("../src/utils/publicError");

/*
  Errores internos: el usuario ve un mensaje genérico salvo en desarrollo
  explícito. Antes el detalle salía siempre que NODE_ENV no fuera
  "production", también si el servidor no lo definía.
*/

const pgError = Object.assign(
  new Error('duplicate key value violates unique constraint "users_email_unique_idx"'),
  { code: "23505" },
);

describe("publicErrorMessage", () => {
  it("sin NODE_ENV no muestra el error de la base", () => {
    assert.equal(publicErrorMessage(pgError, "Error interno", {}), "Error interno");
  });

  it("tampoco en producción ni con un valor cualquiera", () => {
    for (const NODE_ENV of ["production", "staging", "dev", ""]) {
      assert.equal(publicErrorMessage(pgError, "Error interno", { NODE_ENV }), "Error interno", NODE_ENV);
    }
  });

  it("en desarrollo explícito agrega el detalle", () => {
    assert.match(
      publicErrorMessage(pgError, "Error interno", { NODE_ENV: "development" }),
      /^Error interno: duplicate key/,
    );
    assert.equal(exposeErrorDetails({ NODE_ENV: " Development " }), true);
  });

  it("un error pensado para el usuario se muestra siempre", () => {
    const err = userError("Completa la fecha y el nombre del feriado.");
    assert.equal(isUserFacingError(err), true);
    assert.equal(publicErrorMessage(err, "Error interno", {}), "Completa la fecha y el nombre del feriado.");
    // Errores 4xx de body-parser / http-errors.
    const parse = Object.assign(new Error("Unexpected token } in JSON"), { status: 400, expose: true });
    assert.equal(publicErrorMessage(parse, "Error interno", {}), "Unexpected token } in JSON");
  });

  it("un 5xx con statusCode no se muestra", () => {
    const err = Object.assign(new Error("fetch failed to storage.internal:5432"), { statusCode: 502 });
    assert.equal(isUserFacingError(err), false);
    assert.equal(publicErrorMessage(err, "Error al subir", {}), "Error al subir");
  });

  it("aguanta errores vacíos o que no son Error", () => {
    assert.equal(publicErrorMessage(null, "X", {}), "X");
    assert.equal(publicErrorMessage("texto", "X", { NODE_ENV: "development" }), "X");
  });
});

describe("feriados", () => {
  it("la validación de feriado llega al usuario como mensaje", async () => {
    const path = require("node:path");
    const dbId = require.resolve("../src/db");
    const prev = require.cache[dbId];
    require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: { query: async () => ({ rows: [] }) } };
    try {
      const holidayService = require(path.join(__dirname, "../src/services/vacations/holidayService"));
      await assert.rejects(
        holidayService.createHoliday({ countryCode: "CL", holidayDate: null, name: "" }),
        (err) => isUserFacingError(err),
      );
    } finally {
      if (prev) require.cache[dbId] = prev;
      else delete require.cache[dbId];
    }
  });
});
