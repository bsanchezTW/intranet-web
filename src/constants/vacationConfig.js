/**
 * Configuración del módulo de vacaciones. Lee de .env con defaults sensatos.
 * Centraliza parámetros de negocio configurables (anticipación, fraccionamiento, email RRHH).
 */

const { getCountryConfig } = require("../config/country");

function intEnv(name, fallback) {
  const raw = process.env[name];
  const n = raw != null ? parseInt(String(raw).trim(), 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

const VACATION_CONFIG = {
  // Anticipación para solicitar. Chile: mínimo obligatorio (días hábiles).
  // Perú: recomendación en días hábiles; con menos solo se avisa.
  minNoticeDaysCL: intEnv("VACATION_MIN_NOTICE_DAYS_CL", 15),
  minNoticeDaysPE: intEnv("VACATION_MIN_NOTICE_DAYS_PE", 7),

  // Fraccionamiento
  minLongFractionCL: 10, // un tramo ≥ 10 hábiles por período (Código del Trabajo)
  /** Sugerencia interna PE — no bloquea solicitudes legales (art. 17.ii) */
  suggestedMinFractionDaysPE: intEnv("VACATION_SUGGESTED_MIN_FRACTION_DAYS_PE", 7),

  // Correo de RRHH para notificaciones de nuevas solicitudes.
  // Sin variable, el de la instancia: una solicitud de Perú no debe avisar a RRHH Chile.
  rrhhEmail: (
    process.env.VACATION_RRHH_EMAIL ||
    (process.env.COUNTRY ? getCountryConfig().hrEmail : "")
  ).trim(),

  // Acumulación máxima de períodos en Chile (alerta UI)
  maxAccumulatedPeriodsCL: 2,
};

module.exports = { VACATION_CONFIG };
