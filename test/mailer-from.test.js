const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { resolveMailFrom, normalizeEmailList } = require("../src/services/mailer");
const { MAIL_SENDERS, areaFromSender } = require("../src/constants/mailSenders");

function withCountry(code, fn) {
  const previous = process.env.COUNTRY;
  const previousMailFrom = process.env.MAIL_FROM;
  process.env.COUNTRY = code;
  try {
    return fn();
  } finally {
    if (previous === undefined) delete process.env.COUNTRY;
    else process.env.COUNTRY = previous;
    if (previousMailFrom === undefined) delete process.env.MAIL_FROM;
    else process.env.MAIL_FROM = previousMailFrom;
  }
}

describe("remitente de correo", () => {
  it("usa el noreply del país y ignora MAIL_FROM", () => {
    withCountry("CL", () => {
      process.env.MAIL_FROM = "otro@transworld.cl";
      assert.equal(resolveMailFrom(), "noreply@transworld.cl");
    });
    withCountry("PE", () => {
      process.env.MAIL_FROM = "otro@transworld.pe";
      assert.equal(resolveMailFrom(), "noreply@transworld.pe");
    });
  });

  it("el nombre visible identifica el área, no la casilla", () => {
    assert.equal(MAIL_SENDERS.support, "Soporte Transworld");
    assert.equal(MAIL_SENDERS.hr, "Recursos Humanos Transworld");
    assert.equal(MAIL_SENDERS.finance, "Finanzas Transworld");
    assert.equal(MAIL_SENDERS.news, "Noticias Transworld");
    assert.equal(areaFromSender(MAIL_SENDERS.support), "Soporte");
    assert.equal(areaFromSender(MAIL_SENDERS.hr), "Recursos Humanos");
  });

  it("normaliza destinatarios repetidos y vacíos", () => {
    assert.deepEqual(normalizeEmailList(["A@transworld.cl", "a@transworld.cl", ""]), [
      "a@transworld.cl",
    ]);
    assert.deepEqual(normalizeEmailList("Soporte@transworld.pe"), [
      "soporte@transworld.pe",
    ]);
  });
});
