// Permisos que ningún código revisa todavía: se muestran como «Aún sin efecto»
// en Gestión de Permisos. Al conectar uno, se le quita la marca (lo exige un test).
const SIN_EFECTO = "Centros de costo no muestra el RUT de nadie: este permiso no tiene nada que proteger.";

module.exports = {
  module: "centros_costo",
  label: "Centros de costo",
  feature: "expenseCenter",
  permissions: [
    { key: "centros_costo.acceso", label: "Entrar a Centros de costo" },
    { key: "centros_costo.centro.ver", label: "Ver centros de costo y sus miembros" },
    { key: "centros_costo.centro.administrar", label: "Crear, editar, activar y eliminar centros de costo" },
    { key: "centros_costo.miembros.asignar", label: "Asignar personas a un centro de costo" },
    { key: "centros_costo.centro.campo.documento_identidad", sinEfecto: SIN_EFECTO, label: "Ver el RUT de los miembros" },
  ],
};
