/**
 * Monograma de colaborador: dos iniciales (nombre + apellido) y el color
 * del área, para que lista, perfil y navbar pinten el mismo círculo.
 */

const {
  resolveAreaColor,
  hexToHsl,
} = require("../constants/workAreas");

function firstWord(value) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)[0] || "";
}

function letter(word) {
  return word ? word.charAt(0).toUpperCase() : "";
}

/**
 * "Babar Sanchez" → "BS". Usa el primer nombre y el primer apellido cuando
 * vienen separados; si sólo hay un string, primera y última palabra.
 */
function monogramInitials(person = {}) {
  const first = firstWord(person.first_name);
  const last = firstWord(person.last_name);
  if (first && last) return letter(first) + letter(last);
  if (first) return letter(first);
  if (last) return letter(last);

  const nombre = person.nombre || person.name || "";
  const parts = String(nombre)
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length >= 2) {
    return letter(parts[0]) + letter(parts[parts.length - 1]);
  }
  if (parts.length === 1) return letter(parts[0]);

  const user = person.username || person.email || "";
  const local = String(user).split("@")[0].trim();
  return local ? letter(local) : "?";
}

function monogramStyle(hex) {
  const { h, s } = hexToHsl(hex);
  return `--mono-h: ${h}; --mono-s: ${s}%;`;
}

function getMonogram(person = {}) {
  const hex = resolveAreaColor(
    person.area_color || person.color,
    person.area || person.area_name,
  );
  return {
    initials: monogramInitials(person),
    color: hex,
    style: monogramStyle(hex),
  };
}

/**
 * Copia en la sesión los campos que el monograma y el navbar necesitan.
 * `area_color: null` cuenta como hidratado: no volver a consultar.
 */
function applyIdentityToSession(sessionUser, row = {}) {
  if (!sessionUser) return sessionUser;
  if (row.first_name !== undefined) sessionUser.first_name = row.first_name;
  if (row.last_name !== undefined) sessionUser.last_name = row.last_name;
  const first = sessionUser.first_name;
  const last = sessionUser.last_name;
  if (first != null || last != null) {
    sessionUser.nombre = [first, last].filter(Boolean).join(" ");
  }
  if (row.photo !== undefined || row.foto !== undefined) {
    const photo = row.photo !== undefined ? row.photo : row.foto;
    sessionUser.photo = photo || null;
    sessionUser.foto = photo || null;
  }
  if (row.work_area_id !== undefined) {
    sessionUser.work_area_id = row.work_area_id;
  }
  if (row.area_name !== undefined || row.area !== undefined) {
    sessionUser.area =
      row.area_name !== undefined ? row.area_name : row.area;
  }
  if (row.area_color !== undefined || row.color !== undefined) {
    sessionUser.area_color =
      row.area_color !== undefined ? row.area_color : row.color;
  }
  return sessionUser;
}

module.exports = {
  monogramInitials,
  monogramStyle,
  getMonogram,
  applyIdentityToSession,
};
