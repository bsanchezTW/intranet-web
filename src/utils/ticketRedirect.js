/**
 * Destino seguro tras guardar un ticket.
 *
 * El formulario del modal viaja con el listado desde donde se abrió, para que
 * el gestor vuelva ahí en vez de caer en la página suelta del ticket. Como ese
 * valor llega en el cuerpo del POST, se acepta sólo si es una ruta interna de
 * la mesa de ayuda: cualquier otra cosa cae al detalle del ticket.
 */
function safeTicketRedirect(target, id) {
  const destino = String(target ?? "");

  // "//host" y "/\host" son rutas absolutas de protocolo relativo: salen del sitio.
  if (/^\/[/\\]/.test(destino)) return `/sistemas/tickets/${id}`;
  // Ni saltos de línea (inyección de cabeceras) ni rutas fuera del módulo.
  if (/[\r\n]/.test(destino)) return `/sistemas/tickets/${id}`;
  if (!/^\/sistemas\/tickets(\/|\?|$)/.test(destino)) {
    return `/sistemas/tickets/${id}`;
  }

  return destino;
}

module.exports = { safeTicketRedirect };
