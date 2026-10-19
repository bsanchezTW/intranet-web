module.exports = {
  module: "organigrama",
  label: "Organigrama",
  permissions: [
    { key: "organigrama.acceso", label: "Ver el organigrama" },
    { key: "organigrama.area.crear", label: "Crear áreas" },
    { key: "organigrama.area.editar", label: "Editar áreas (nombre, color, área superior, orden)" },
    { key: "organigrama.area.eliminar", label: "Eliminar áreas" },
    { key: "organigrama.area.designar_jefe", label: "Designar el jefe de un área" },
    { key: "organigrama.area.editar_miembros", label: "Agregar, quitar y mover personas entre áreas" },
  ],
};
