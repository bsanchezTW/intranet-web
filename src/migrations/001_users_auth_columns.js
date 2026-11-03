/**
 * Autenticación endurecida (routes/auth.js): intentos contra el código de
 * verificación y enlace de un solo uso de «Olvidé mi contraseña».
 */
module.exports = {
  id: "001_users_auth_columns",
  async up(client) {
    await client.query(`
      ALTER TABLE users
        ADD COLUMN IF NOT EXISTS confirm_attempts INTEGER NOT NULL DEFAULT 0,
        ADD COLUMN IF NOT EXISTS password_reset_token_hash VARCHAR(64),
        ADD COLUMN IF NOT EXISTS password_reset_expires TIMESTAMPTZ
    `);
  },
};
