const { SCOPE_SETS } = require("../scopes");

module.exports = {
  module: "rrhh",
  label: "Personas",
  permissions: [
    { key: "rrhh.acceso", label: "Entrar a RRHH" },
    { key: "rrhh.directorio.ver", label: "Ver el directorio de personas" },
    { key: "rrhh.directorio.campo.contacto_personal", label: "Ver el contacto personal en el directorio" },
    { key: "rrhh.colaborador.ver", label: "Ver la ficha completa", scopes: SCOPE_SETS.EQUIPO },
    { key: "rrhh.colaborador.crear", label: "Crear colaboradores" },
    { key: "rrhh.colaborador.editar", label: "Editar fichas", scopes: SCOPE_SETS.EQUIPO },
    { key: "rrhh.colaborador.eliminar", label: "Eliminar colaboradores", scopes: SCOPE_SETS.EQUIPO },
    { key: "rrhh.colaborador.activar", label: "Habilitar y deshabilitar cuentas", scopes: SCOPE_SETS.EQUIPO },
    { key: "rrhh.colaborador.enviar_clave", label: "Enviar contraseña temporal", scopes: SCOPE_SETS.EQUIPO },
    { key: "rrhh.colaborador.campo.documento_identidad", label: "Ver el RUT / DNI" },
    { key: "rrhh.colaborador.campo.datos_personales", label: "Ver datos personales (fecha de nacimiento, dirección, contacto)" },
    { key: "rrhh.portales.ver", label: "Ver los portales externos de RRHH", feature: "chileHrPortals" },
  ],
};
