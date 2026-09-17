const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { getCountryConfig } = require("../src/config/country");
const {
  toStoragePhone,
  formatPhoneForDisplay,
  isValidMobilePhone,
  validateMobilePhone,
  validateWorkPhone,
  toTelHref,
  localMaxLength,
} = require("../src/utils/phone");

const CL = getCountryConfig("CL").phone;
const PE = getCountryConfig("PE").phone;

describe("phone — Chile (regresión: formato previo intacto)", () => {
  it("PH-CL-01: acepta el formato local 9 1234 5678", () => {
    assert.ok(isValidMobilePhone("9 1234 5678", CL));
  });

  it("PH-CL-02: acepta el formato completo +56 9 1234 5678", () => {
    assert.ok(isValidMobilePhone("+56 9 1234 5678", CL));
  });

  it("PH-CL-03: almacena 11 dígitos 569XXXXXXXX (igual que antes)", () => {
    assert.equal(toStoragePhone("9 1234 5678", CL), "56912345678");
    assert.equal(toStoragePhone("+56 9 1234 5678", CL), "56912345678");
  });

  it("PH-CL-04: muestra +56 9 1234 5678 desde lo almacenado", () => {
    assert.equal(formatPhoneForDisplay("56912345678", CL), "+56 9 1234 5678");
  });

  it("PH-CL-05: rechaza fijos y longitudes incorrectas", () => {
    assert.ok(!isValidMobilePhone("2 2345 6789", CL)); // no empieza en 9
    assert.ok(!isValidMobilePhone("9 1234 567", CL)); // 8 dígitos
    assert.ok(!isValidMobilePhone("9 1234 56789", CL)); // 10 dígitos
  });

  it("PH-CL-06: tel: href sin espacios", () => {
    assert.equal(toTelHref("9 1234 5678", CL), "tel:+56912345678");
  });
});

describe("phone — Perú", () => {
  it("PH-PE-01: acepta el formato local 987 654 321", () => {
    assert.ok(isValidMobilePhone("987 654 321", PE));
  });

  it("PH-PE-02: acepta el formato completo +51 987 654 321", () => {
    assert.ok(isValidMobilePhone("+51 987 654 321", PE));
  });

  it("PH-PE-03: almacena 51 + 9 dígitos", () => {
    assert.equal(toStoragePhone("987 654 321", PE), "51987654321");
  });

  it("PH-PE-04: muestra agrupado de a 3", () => {
    assert.equal(formatPhoneForDisplay("51987654321", PE), "+51 987 654 321");
  });

  it("PH-PE-05: rechaza números que no empiezan en 9", () => {
    assert.ok(!isValidMobilePhone("187 654 321", PE));
  });

  it("PH-PE-06: un celular peruano ya NO es rechazado (bug corregido)", () => {
    const r = validateMobilePhone("987654321", {}, PE);
    assert.equal(r.valid, true);
    assert.equal(r.storageValue, "51987654321");
    assert.equal(r.error, null);
  });
});

describe("phone — aislamiento entre países", () => {
  it("PH-X-01: un número chileno no valida con reglas peruanas", () => {
    // 9 dígitos que empiezan en 9 valen en ambos, pero el almacenamiento
    // lleva el código de país correcto según la instancia.
    assert.equal(toStoragePhone("912345678", CL), "56912345678");
    assert.equal(toStoragePhone("912345678", PE), "51912345678");
  });

  it("PH-X-02: el prefijo del otro país no se acepta", () => {
    assert.ok(!isValidMobilePhone("+51 987 654 321", CL));
    assert.ok(!isValidMobilePhone("+56 9 1234 5678", PE));
  });

  it("PH-X-03: maxlength del campo local coincide en ambos (9 dígitos + separadores)", () => {
    assert.equal(localMaxLength(CL), 11);
    assert.equal(localMaxLength(PE), 11);
  });

  it("PH-X-04: opcional vacío es válido; requerido vacío no", () => {
    assert.equal(validateMobilePhone("", {}, PE).valid, true);
    assert.equal(validateMobilePhone("", { required: true }, PE).valid, false);
  });

  it("PH-X-05: el aviso es corto e igual en los dos países", () => {
    // El formato esperado se enseña en el placeholder del campo; repetirlo en
    // el error lo alarga y lo vuelve dependiente del país sin necesidad.
    assert.equal(validateMobilePhone("abc", {}, CL).error, "Teléfono incorrecto");
    assert.equal(validateMobilePhone("abc", {}, PE).error, "Teléfono incorrecto");
  });

  it("PH-X-06: faltar y estar mal escrito son avisos distintos", () => {
    assert.equal(validateMobilePhone("", { required: true }, CL).error, "Teléfono requerido");
    assert.equal(validateMobilePhone("123", { required: true }, CL).error, "Teléfono incorrecto");
  });
});

describe("phone — teléfono de empresa (celular o fijo)", () => {
  it("PH-W-01: Chile acepta un fijo de Santiago y lo guarda con código de país", () => {
    const check = validateWorkPhone("2 7439 1435", CL);
    assert.equal(check.valid, true);
    assert.equal(check.storageValue, "56274391435");
    assert.equal(formatPhoneForDisplay(check.storageValue, CL), "+56 2 7439 1435");
    assert.equal(toTelHref(check.storageValue, CL), "tel:+56274391435");
  });

  it("PH-W-02: también acepta celulares y rechaza números imposibles", () => {
    assert.equal(validateWorkPhone("9 1234 5678", CL).storageValue, "56912345678");
    assert.equal(validateWorkPhone("1 2345 6789", CL).valid, false);
    assert.equal(validateWorkPhone("", CL).valid, true);
  });

  it("PH-W-03: Perú acepta un fijo de Lima de 8 dígitos", () => {
    assert.equal(validateWorkPhone("1 234 5678", PE).storageValue, "5112345678");
  });

  it("PH-W-04: el celular personal sigue sin aceptar fijos", () => {
    assert.equal(validateMobilePhone("2 7439 1435", {}, CL).valid, false);
  });
});
