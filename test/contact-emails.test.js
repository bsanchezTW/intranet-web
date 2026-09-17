const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  accountUsesPersonalEmail,
  companyEmail,
} = require("../src/utils/contactEmails");

describe("contactEmails — correo de empresa vs. correo de la cuenta", () => {
  it("con correo de empresa, ese es el visible", () => {
    const row = { email: "ana@transworld.cl", personal_email: "ana@gmail.com" };
    assert.equal(companyEmail(row), "ana@transworld.cl");
    assert.equal(accountUsesPersonalEmail(row), false);
  });

  it("sin correo de empresa, la cuenta usa el personal y no hay correo visible", () => {
    const row = { email: "ana@gmail.com", personal_email: " Ana@Gmail.com " };
    assert.equal(companyEmail(row), null);
    assert.equal(accountUsesPersonalEmail(row), true);
  });

  it("sin ningún correo no hay cuenta ni correo visible", () => {
    assert.equal(companyEmail({ email: null, personal_email: null }), null);
    assert.equal(accountUsesPersonalEmail({ email: null, personal_email: null }), false);
  });
});

describe("datos personales enmascarados en listados", () => {
  const { maskEmail } = require("../src/utils/contactEmails");
  const { maskPhone } = require("../src/utils/phone");
  const { getCountryConfig } = require("../src/config/country");

  it("el correo muestra el inicio y el dominio", () => {
    assert.equal(maskEmail("tian.a.sanchez@icloud.com"), "ti***@icloud.com");
    assert.equal(maskEmail("ana@gmail.com"), "a***@gmail.com");
    assert.equal(maskEmail(null), null);
  });

  it("el teléfono sólo deja ver los últimos 4 dígitos", () => {
    assert.equal(maskPhone("56974391435", getCountryConfig("CL").phone), "+56 * **** 1435");
    assert.equal(maskPhone("51987654321", getCountryConfig("PE").phone), "+51 *** **4 321");
    assert.equal(maskPhone(null, getCountryConfig("CL").phone), null);
  });
});
