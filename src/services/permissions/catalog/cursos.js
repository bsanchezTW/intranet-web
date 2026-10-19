const { SCOPE_SETS } = require("../scopes");

module.exports = {
  module: "cursos",
  label: "Cursos",
  permissions: [
    { key: "cursos.acceso", label: "Entrar a Cursos" },
    { key: "cursos.curso.ver", label: "Hacer cursos y evaluaciones" },
    { key: "cursos.material.crear", label: "Agregar material a los cursos" },
    { key: "cursos.material.editar", label: "Editar el material de los cursos" },
    { key: "cursos.material.eliminar", label: "Eliminar material de los cursos" },
    { key: "cursos.avance.ver", label: "Ver el avance de otros (KPI)", scopes: SCOPE_SETS.EQUIPO },
    { key: "cursos.avance.campo.email", label: "Ver el correo de cada persona en el KPI" },
  ],
};
