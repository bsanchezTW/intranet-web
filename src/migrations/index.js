/**
 * Migraciones en orden (services/schema/migrator.js). Una nueva va al final
 * con el siguiente número; una ya publicada no se edita: se agrega otra.
 */
module.exports = [
  require("./001_users_auth_columns"),
  require("./002_users_home_quick_access"),
  require("./003_news_featured"),
  require("./004_applications_columns"),
  require("./005_users_email_unique_index"),
  require("./006_users_active"),
  require("./007_route_sheet_view_scope"),
];
