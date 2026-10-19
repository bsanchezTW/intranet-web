module.exports = {
  module: "centros_costo",
  label: "Centros de costo",
  feature: "expenseCenter",
  permissions: [
    { key: "centros_costo.acceso", label: "Entrar a Centros de costo" },
    { key: "centros_costo.centro.ver", label: "Ver centros de costo y sus miembros" },
    { key: "centros_costo.centro.administrar", label: "Crear, editar, activar y eliminar centros de costo" },
    { key: "centros_costo.miembros.asignar", label: "Asignar personas a un centro de costo" },
    { key: "centros_costo.centro.campo.documento_identidad", label: "Ver el RUT de los miembros" },
  ],
};
