/**
 * El correo identifica al usuario: índice único sin mayúsculas ni espacios.
 * Va al final: si la base tiene correos repetidos, falla (hay que depurarlos
 * a mano) y no frena a las anteriores.
 */
module.exports = {
  id: "005_users_email_unique_index",
  async up(client) {
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique_idx
        ON users (LOWER(TRIM(email)))
       WHERE email IS NOT NULL AND TRIM(email) <> ''
    `);
  },
};
