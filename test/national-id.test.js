const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const { getCountryConfig } = require("../src/config/country");
const {
  cleanInput,
  rutCheckDigit,
  parseRut,
  parseDni,
  toStorageNationalId,
  formatNationalId,
  isValidNationalId,
  validateNationalId,
  nationalIdClientConfig,
} = require("../src/utils/nationalId");

const CL = getCountryConfig("CL").document;
const PE = getCountryConfig("PE").document;

describe("nationalId — configuración por país", () => {
  it("Chile pide RUT y Perú DNI", () => {
    assert.equal(CL.kind, "rut");
    assert.equal(CL.label, "RUT");
    assert.equal(PE.kind, "dni");
    assert.equal(PE.label, "DNI");
  });

  it("la config de cliente lleva lo que el formulario necesita", () => {
    const cfg = nationalIdClientConfig(CL);
    assert.equal(cfg.kind, "rut");
    assert.equal(cfg.maxLength, 12);
    assert.match(cfg.errorMessage, /RUT/);
  });
});

describe("nationalId — dígito verificador (módulo 11)", () => {
  it("calcula el DV de RUTs conocidos", () => {
    assert.equal(rutCheckDigit("12345678"), "5");
    assert.equal(rutCheckDigit("11111111"), "1");
    assert.equal(rutCheckDigit("5126663"), "3");
  });

  it("resuelve los dos casos especiales: 11 → 0 y 10 → K", () => {
    // Se buscan cuerpos reales en vez de fijar uno: el caso importa, no el número.
    let conCero = null;
    let conK = null;
    for (let i = 1000000; i < 1000100 && (!conCero || !conK); i += 1) {
      const dv = rutCheckDigit(String(i));
      if (dv === "0" && !conCero) conCero = String(i);
      if (dv === "K" && !conK) conK = String(i);
    }
    assert.ok(conCero, "debería existir un cuerpo con DV 0");
    assert.ok(conK, "debería existir un cuerpo con DV K");
    assert.equal(isValidNationalId(`${conCero}-0`, CL), true);
    assert.equal(isValidNationalId(`${conK}-K`, CL), true);
    // Y el DV equivocado se rechaza en ambos casos.
    assert.equal(isValidNationalId(`${conCero}-K`, CL), false);
    assert.equal(isValidNationalId(`${conK}-0`, CL), false);
  });
});

describe("nationalId — RUT chileno", () => {
  it("acepta el mismo RUT escrito de varias formas", () => {
    for (const entrada of ["12.345.678-5", "12345678-5", "123456785", "12.345.678 - 5"]) {
      assert.equal(toStorageNationalId(entrada, CL), "12345678-5", entrada);
    }
  });

  it("acepta la K en minúscula y la guarda en mayúscula", () => {
    const cuerpo = "1000005"; // DV = K
    assert.equal(rutCheckDigit(cuerpo), "K");
    assert.equal(toStorageNationalId(`${cuerpo}-k`, CL), `${cuerpo}-K`);
  });

  it("rechaza el dígito verificador equivocado", () => {
    assert.equal(isValidNationalId("12.345.678-9", CL), false);
    assert.equal(isValidNationalId("11.111.111-2", CL), false);
  });

  it("rechaza cuerpos fuera de rango o mal formados", () => {
    assert.equal(isValidNationalId("999.999-6", CL), false, "menos de un millón");
    assert.equal(isValidNationalId("123456789012-5", CL), false, "demasiado largo");
    assert.equal(isValidNationalId("1234567A-5", CL), false, "letra en el cuerpo");
    assert.equal(isValidNationalId("12345678-Z", CL), false, "DV inválido");
    assert.equal(isValidNationalId("no-es-un-rut", CL), false);
  });

  it("formatea con puntos sólo para pantalla", () => {
    assert.equal(formatNationalId("12345678-5", CL), "12.345.678-5");
    assert.equal(formatNationalId("1000005-K", CL), "1.000.005-K");
    assert.equal(formatNationalId(null, CL), null);
    assert.equal(formatNationalId("", CL), null);
  });

  it("un valor guardado que ya no valida se muestra tal cual", () => {
    // Por ejemplo un DNI peruano si la ficha se migró entre instancias: es
    // preferible mostrarlo raro a que desaparezca de la pantalla.
    assert.equal(formatNationalId("87654321", CL), "87654321");
  });
});

describe("nationalId — DNI peruano", () => {
  it("exige exactamente ocho dígitos", () => {
    assert.equal(parseDni("87654321"), "87654321");
    assert.equal(parseDni("8765432"), null);
    assert.equal(parseDni("876543219"), null);
    assert.equal(parseDni("8765432A"), null);
  });

  it("tolera espacios al capturar", () => {
    assert.equal(toStorageNationalId("8765 4321", PE), "87654321");
  });

  it("no acepta un RUT chileno", () => {
    assert.equal(isValidNationalId("12.345.678-5", PE), false);
  });
});

describe("nationalId — validateNationalId", () => {
  it("vacío es válido cuando es opcional", () => {
    const r = validateNationalId("", {}, CL);
    assert.equal(r.valid, true);
    assert.equal(r.storageValue, null);
    assert.equal(r.error, null);
  });

  it("vacío falla cuando es obligatorio, con el nombre del país", () => {
    assert.equal(validateNationalId("", { required: true }, CL).error, "RUT requerido");
    assert.equal(validateNationalId("", { required: true }, PE).error, "DNI requerido");
  });

  it("devuelve por separado lo que se guarda y lo que se muestra", () => {
    const r = validateNationalId("12.345.678-5", {}, CL);
    assert.equal(r.valid, true);
    assert.equal(r.storageValue, "12345678-5", "sin puntos en la base");
    assert.equal(r.value, "12.345.678-5", "con puntos en pantalla");
  });

  it("un valor inválido no deja pasar nada", () => {
    const r = validateNationalId("12.345.678-9", {}, CL);
    assert.equal(r.valid, false);
    assert.equal(r.storageValue, null);
    assert.equal(r.error, "RUT incorrecto");
  });

  it("el aviso es corto y nombra el documento del país", () => {
    // Mismo tono que el resto de los campos del formulario: qué está mal, no
    // cómo se escribe (eso ya está en el placeholder).
    assert.equal(validateNationalId("12.345.678-9", {}, PE).error, "DNI incorrecto");
    assert.equal(validateNationalId("", { required: true }, PE).error, "DNI requerido");
  });

  it("cleanInput quita separadores y sube la K", () => {
    assert.equal(cleanInput(" 12.345.678-k "), "12345678K");
    assert.equal(cleanInput(null), "");
  });

  it("parseRut separa cuerpo y dígito verificador", () => {
    assert.deepEqual(parseRut("12.345.678-5"), { body: "12345678", dv: "5" });
    assert.equal(parseRut("12.345.678-4"), null);
  });
});
