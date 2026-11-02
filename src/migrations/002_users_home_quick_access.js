/** Preferencia de la banda del home. NULL conserva el orden del país. */
module.exports = {
  id: "002_users_home_quick_access",
  async up(client) {
    await client.query("ALTER TABLE users ADD COLUMN IF NOT EXISTS home_quick_access jsonb");
  },
};
