const db = require("../../db");
const {
  BANCO_ESTADO_CODE,
  BANK_ACCOUNT_TYPE,
  isBankAccountType,
  isAccountTypeAllowedForBank,
} = require("../../constants/banks");
const { parseRut } = require("../../utils/nationalId");

/**
 * Cuenta de destino del reembolso o del adelanto.
 *
 * Sólo se admiten cuentas propias: el titular, su documento y su correo NO
 * viajan desde el cliente, se toman de la ficha del solicitante (los mismos
 * datos que ya se congelan en la solicitud). Del formulario llegan únicamente
 * banco, tipo y número.
 *
 * Las cuentas guardadas no tienen id propio: su clave es la cuenta misma
 * (usuario, banco, tipo, número). Guardar dos veces la misma es un no-op.
 */

/**
 * Número de la CuentaRUT: el RUT sin puntos ni dígito verificador.
 * @returns {string|null}
 */
function cuentaRutNumber(nationalId) {
  const parsed = parseRut(nationalId);
  return parsed ? parsed.body : null;
}

/**
 * Los bancos escriben el número con guiones o puntos ("00-123-45678-09"); lo
 * que identifica la cuenta son los dígitos.
 */
function parseAccountNumber(value) {
  const digits = String(value ?? "").replace(/[\s.\-]/g, "");
  if (!/^\d{4,20}$/.test(digits)) return null;
  return digits;
}

/**
 * Valida la cuenta contra el catálogo activo.
 *
 * @param raw        { bank_code, account_type, account_number } tal como llega
 * @param banks      catálogo activo ([{ code, name }])
 * @param nationalId documento normalizado del solicitante ("12345678-5")
 * @returns {{ ok: true, account } | { ok: false, error: string }}
 */
function normalizeBankAccount(raw, { banks, nationalId }) {
  const bankCode = String((raw && raw.bank_code) || "").trim();
  const bank = (banks || []).find((b) => b.code === bankCode);
  if (!bank) {
    return { ok: false, error: "Elige el banco de destino para la transferencia." };
  }

  const accountType = String((raw && raw.account_type) || "").trim();
  if (!isBankAccountType(accountType)) {
    return { ok: false, error: "Elige el tipo de cuenta." };
  }
  if (!isAccountTypeAllowedForBank(accountType, bank.code)) {
    return { ok: false, error: "La CuentaRUT sólo existe en Banco Estado." };
  }

  let accountNumber;
  if (bank.code === BANCO_ESTADO_CODE && accountType === BANK_ACCOUNT_TYPE.RUT) {
    // En la CuentaRUT el número ES el RUT del titular: se calcula aquí y se
    // ignora lo que haya mandado el cliente.
    accountNumber = cuentaRutNumber(nationalId);
    if (!accountNumber) {
      return {
        ok: false,
        error: "No se pudo derivar el número de tu CuentaRUT desde tu RUT. Revísalo en tu perfil.",
      };
    }
  } else {
    accountNumber = parseAccountNumber(raw && raw.account_number);
    if (!accountNumber) {
      return {
        ok: false,
        error: "El número de cuenta debe tener sólo dígitos (entre 4 y 20).",
      };
    }
  }

  return {
    ok: true,
    account: {
      bankCode: bank.code,
      bankName: bank.name,
      accountType,
      accountNumber,
    },
  };
}

/**
 * Cuenta de un borrador: si ya valida se guarda completa; si no, se conserva
 * lo que sirva (banco del catálogo, tipo conocido, dígitos) para que al
 * retomarlo el usuario no tenga que volver a elegir todo.
 * @returns {object|null}
 */
function normalizeDraftBankAccount(raw, { banks, nationalId }) {
  if (!raw) return null;
  const full = normalizeBankAccount(raw, { banks, nationalId });
  if (full.ok) return full.account;

  const bank = (banks || []).find((b) => b.code === String(raw.bank_code || "").trim());
  const accountType = String(raw.account_type || "").trim();
  const accountNumber = String(raw.account_number ?? "").replace(/\D/g, "").slice(0, 20);
  if (!bank && !accountNumber) return null;

  return {
    bankCode: bank ? bank.code : null,
    bankName: bank ? bank.name : null,
    accountType: isBankAccountType(accountType) ? accountType : null,
    accountNumber: accountNumber || null,
  };
}

async function listBanks() {
  const { rows } = await db.query(
    `SELECT code, name, entity_type
       FROM banks
      WHERE active = TRUE
      ORDER BY name ASC`,
  );
  return rows;
}

/** Cuentas guardadas del colaborador, la última usada primero. */
async function listUserAccounts(userId) {
  const { rows } = await db.query(
    `SELECT a.bank_code, b.name AS bank_name, a.account_type, a.account_number
       FROM user_bank_accounts a
       JOIN banks b ON b.code = a.bank_code
      WHERE a.user_id = $1 AND b.active = TRUE
      ORDER BY a.last_used_at DESC NULLS LAST, a.created_at DESC`,
    [userId],
  );
  return rows;
}

/**
 * Marca la cuenta como usada y, si el colaborador pidió guardarla, la crea.
 * Recibe un client porque corre dentro de la transacción de la solicitud.
 */
async function touchUserAccount(client, userId, account, { save }) {
  const params = [userId, account.bankCode, account.accountType, account.accountNumber];
  if (save) {
    await client.query(
      `INSERT INTO user_bank_accounts (user_id, bank_code, account_type, account_number, last_used_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id, bank_code, account_type, account_number)
       DO UPDATE SET last_used_at = NOW()`,
      params,
    );
    return;
  }
  // Sin guardar: si ya estaba guardada, sólo sube al primer lugar de la lista.
  await client.query(
    `UPDATE user_bank_accounts
        SET last_used_at = NOW()
      WHERE user_id = $1 AND bank_code = $2 AND account_type = $3 AND account_number = $4`,
    params,
  );
}

/**
 * Borra una cuenta guardada del propio colaborador. Las solicitudes que ya la
 * usaron no se ven afectadas: tienen la cuenta copiada.
 * @returns {Promise<boolean>} false si no existía (o no era suya).
 */
async function deleteUserAccount(userId, raw) {
  const field = (name) => String((raw && raw[name]) || "").trim();
  const { rowCount } = await db.query(
    `DELETE FROM user_bank_accounts
      WHERE user_id = $1 AND bank_code = $2 AND account_type = $3 AND account_number = $4`,
    [userId, field("bank_code"), field("account_type"), field("account_number")],
  );
  return rowCount > 0;
}

module.exports = {
  deleteUserAccount,
  cuentaRutNumber,
  parseAccountNumber,
  normalizeBankAccount,
  normalizeDraftBankAccount,
  listBanks,
  listUserAccounts,
  touchUserAccount,
};
