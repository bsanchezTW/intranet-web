module.exports = {
  module: "noticias",
  label: "Noticias",
  permissions: [
    { key: "noticias.acceso", label: "Entrar a Noticias" },
    { key: "noticias.noticia.ver", label: "Leer noticias" },
    { key: "noticias.noticia.crear", label: "Publicar noticias" },
    { key: "noticias.noticia.editar", label: "Editar noticias" },
    { key: "noticias.noticia.eliminar", label: "Eliminar noticias" },
    { key: "noticias.noticia.destacar", label: "Destacar noticias en el inicio" },
    { key: "noticias.noticia.enviar_correo", label: "Enviar una noticia por correo a todos" },
  ],
};
