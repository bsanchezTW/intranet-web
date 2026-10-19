module.exports = {
  module: "inicio",
  label: "Inicio",
  permissions: [
    { key: "inicio.acceso", label: "Entrar al inicio de la intranet" },
    {
      key: "inicio.accesos.personalizar",
      label: "Elegir sus accesos rápidos",
      feature: "homeQuickAccess",
    },
    { key: "inicio.indicador_uf.ver", label: "Ver el valor de la UF", feature: "chileUfIndicator" },
    { key: "inicio.linkedin.ver", label: "Ver las publicaciones de LinkedIn", feature: "linkedinFeed" },
    {
      key: "inicio.linkedin.configurar",
      label: "Conectar la cuenta de LinkedIn de la empresa",
      feature: "linkedinFeed",
    },
  ],
};
