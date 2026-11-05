const { normalizeRole } = require("../../constants/roles");

/**
 * Lo que guarda la sesión de una persona, a partir de su fila de `users`
 * (con `area_name` y `area_color` de su área). Lo usan el login y la
 * suplantación, así quien entra «como» otro ve exactamente lo mismo.
 */
function buildSessionUser(u) {
  const isFirstLogin = u.last_login_at == null;
  const showHomeTutorial = isFirstLogin || u.home_tutorial_seen === false;
  const user = {
    id: u.id,
    username: u.email,
    email: u.email,
    role: normalizeRole(u.role),
    nombre: u.first_name + (u.last_name ? " " + u.last_name : ""),
    first_name: u.first_name,
    last_name: u.last_name,
    foto: u.photo || null,
    photo: u.photo || null,
    work_area_id: u.work_area_id || null,
    area: u.area_name || null,
    must_change_password: u.must_change_password,
    home_tutorial_seen: u.home_tutorial_seen !== false,
    show_home_tutorial: showHomeTutorial,
  };
  // El SELECT de respaldo (esquema viejo) no trae color: dejar `undefined`
  // para que el middleware hidrate el área en el siguiente request.
  if ("area_color" in u) user.area_color = u.area_color ?? null;
  return user;
}

module.exports = { buildSessionUser };
