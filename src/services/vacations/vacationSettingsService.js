const db = require("../../db");
const { getCurrentCountry } = require("../../config/country");
const { toDateOnly } = require("../../utils/vacationDateUtils");

/**
 * Parámetros del módulo de vacaciones que RR.HH. edita desde la intranet.
 *
 * Hoy solo la fecha de corte del historial: el día hasta el cual las
 * vacaciones vivían en el Excel de RR.HH. y desde el cual las gestiona la
 * intranet. Es única para todo el país —no por trabajador— para que la regla
 * "antes del corte es historial, después es solicitud" se pueda explicar y
 * auditar en una frase.
 */

async function getSettings() {
  const country = getCurrentCountry();
  const { rows } = await db.query(
    `SELECT * FROM vacation_settings WHERE country_code = $1`,
    [country],
  );
  const row = rows[0] || null;
  return {
    countryCode: country,
    historyCutoffDate: row ? toDateOnly(row.history_cutoff_date) : null,
    updatedBy: row ? row.updated_by : null,
    updatedAt: row ? row.updated_at : null,
  };
}

/** Fecha de corte vigente, o null si RR.HH. todavía no la fijó. */
async function getCutoffDate() {
  return (await getSettings()).historyCutoffDate;
}

async function setCutoffDate({ cutoffDate, updatedBy }) {
  const country = getCurrentCountry();
  const value = toDateOnly(cutoffDate);
  if (!value) return { ok: false };

  await db.query(
    `INSERT INTO vacation_settings (country_code, history_cutoff_date, updated_by, updated_at)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (country_code) DO UPDATE SET
       history_cutoff_date = EXCLUDED.history_cutoff_date,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()`,
    [country, value, updatedBy || null],
  );
  return { ok: true, historyCutoffDate: value };
}

module.exports = {
  getSettings,
  getCutoffDate,
  setCutoffDate,
};
