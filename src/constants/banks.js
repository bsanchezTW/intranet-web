/**
 * Catálogo de instituciones de destino para la transferencia de un reembolso.
 *
 * La clave es el código SBIF/CMF (`codigo_sbif`) y no un id autoincremental: es
 * el identificador que usan las nóminas de pago y los archivos que Finanzas
 * sube al banco, así que la tabla `banks` se siembra con él tal cual.
 *
 * El catálogo es por país. Perú no tiene todavía el suyo: con la lista vacía la
 * sección de datos bancarios no se muestra ni se exige en esa instancia.
 */

const BANK_ENTITY_TYPE = Object.freeze({
  TRADICIONAL: "Banco Tradicional",
  EMISOR_NO_BANCARIO: "Emisor No Bancario",
});

const { TRADICIONAL, EMISOR_NO_BANCARIO } = BANK_ENTITY_TYPE;

const BANKS_BY_COUNTRY = Object.freeze({
  CL: Object.freeze([
    { code: "001", name: "Banco de Chile", entityType: TRADICIONAL },
    { code: "009", name: "Banco Internacional", entityType: TRADICIONAL },
    { code: "012", name: "Banco Estado", entityType: TRADICIONAL },
    { code: "014", name: "Scotiabank Chile", entityType: TRADICIONAL },
    { code: "016", name: "Banco de Crédito e Inversiones (BCI)", entityType: TRADICIONAL },
    { code: "028", name: "Banco BICE", entityType: TRADICIONAL },
    { code: "031", name: "HSBC Bank Chile", entityType: TRADICIONAL },
    { code: "037", name: "Banco Santander-Chile", entityType: TRADICIONAL },
    { code: "039", name: "Itaú Chile", entityType: TRADICIONAL },
    { code: "051", name: "Banco Falabella", entityType: TRADICIONAL },
    { code: "053", name: "Banco Ripley", entityType: TRADICIONAL },
    { code: "055", name: "Banco Consorcio", entityType: TRADICIONAL },
    { code: "059", name: "Banco BTG Pactual Chile", entityType: TRADICIONAL },
    { code: "062", name: "Tanner Banco", entityType: TRADICIONAL },
    { code: "063", name: "Tenpo Banco", entityType: TRADICIONAL },
    { code: "729", name: "Los Héroes Prepago", entityType: EMISOR_NO_BANCARIO },
    { code: "732", name: "Caja Los Andes Prepago", entityType: EMISOR_NO_BANCARIO },
    { code: "875", name: "Mercado Pago", entityType: EMISOR_NO_BANCARIO },
  ]),
  PE: Object.freeze([]),
});

/**
 * Instituciones que salieron del catálogo: sucursales extranjeras (JP Morgan,
 * China Construction Bank, Bank of China) y Tenpo Payments. No se borran de la
 * tabla — las solicitudes ya emitidas las citan por FK —, se desactivan al
 * arrancar para que el formulario deje de ofrecerlas.
 */
const RETIRED_BANK_CODES = Object.freeze(["041", "060", "061", "730"]);

/** Banco Estado: el único donde existe la CuentaRUT. */
const BANCO_ESTADO_CODE = "012";

const BANK_ACCOUNT_TYPE = Object.freeze({
  CORRIENTE: "corriente",
  VISTA: "vista",
  RUT: "rut",
});

const BANK_ACCOUNT_TYPE_LABELS = Object.freeze({
  corriente: "Cuenta Corriente",
  vista: "Cuenta Vista",
  rut: "Cuenta RUT",
});

const ALL_BANK_ACCOUNT_TYPES = Object.freeze(Object.values(BANK_ACCOUNT_TYPE));

function isBankAccountType(value) {
  return ALL_BANK_ACCOUNT_TYPES.includes(value);
}

function bankAccountTypeLabel(value) {
  return BANK_ACCOUNT_TYPE_LABELS[value] || value || "—";
}

/** ¿Este tipo de cuenta existe en este banco? Hoy sólo la CuentaRUT restringe. */
function isAccountTypeAllowedForBank(accountType, bankCode) {
  if (accountType === BANK_ACCOUNT_TYPE.RUT) return bankCode === BANCO_ESTADO_CODE;
  return isBankAccountType(accountType);
}

function banksForCountry(countryCode) {
  return BANKS_BY_COUNTRY[String(countryCode || "").trim().toUpperCase()] || [];
}

module.exports = {
  BANK_ENTITY_TYPE,
  BANKS_BY_COUNTRY,
  RETIRED_BANK_CODES,
  BANCO_ESTADO_CODE,
  BANK_ACCOUNT_TYPE,
  BANK_ACCOUNT_TYPE_LABELS,
  ALL_BANK_ACCOUNT_TYPES,
  isBankAccountType,
  bankAccountTypeLabel,
  isAccountTypeAllowedForBank,
  banksForCountry,
};
