/**
 * Direcciones de un ticket.
 *
 * Un ticket se ve sólo en el modal de la lista de Soporte: su dirección es
 * /soporte?ticket=<id>, que abre ese modal. /soporte/tickets/<id> sólo
 * entrega el contenido del modal (?modal=true) y, abierta directamente,
 * redirige aquí.
 */

function ticketModalUrl(id) {
  return `/soporte?ticket=${encodeURIComponent(id)}`;
}

/** Listado canónico (/soporte) o una ruta operativa bajo /soporte/tickets. */
function isHelpdeskPath(destino) {
  if (/^\/soporte\/?(?:\?|$)/.test(destino)) return true;
  if (/^\/soporte\/tickets(\/|\?|$)/.test(destino)) return true;
  // Formularios abiertos antes del cambio de nombre.
  if (/^\/sistemas\/?(?:\?|$)/.test(destino)) return true;
  return /^\/sistemas\/tickets(\/|\?|$)/.test(destino);
}

/**
 * Destino seguro tras guardar un ticket.
 *
 * El formulario del modal viaja con el listado desde donde se abrió, para que
 * el gestor vuelva ahí. Como ese valor llega en el cuerpo del POST, se acepta
 * sólo si es una ruta interna de la mesa de ayuda: cualquier otra cosa cae al
 * ticket abierto en el modal.
 */
function safeTicketRedirect(target, id) {
  const destino = String(target ?? "");

  // "//host" y "/\host" son rutas absolutas de protocolo relativo: salen del sitio.
  if (/^\/[/\\]/.test(destino)) return ticketModalUrl(id);
  // Ni saltos de línea (inyección de cabeceras) ni rutas fuera del módulo.
  if (/[\r\n]/.test(destino)) return ticketModalUrl(id);
  if (!isHelpdeskPath(destino)) return ticketModalUrl(id);

  return destino;
}

module.exports = { ticketModalUrl, safeTicketRedirect };
