/**
 * Lista de tickets de la zona de Soporte: búsqueda, filtro por estado, orden y
 * apertura del detalle en modal.
 *
 * La lista es un <ul> de filas, no una tabla ancha: el filtrado se hace sobre
 * los data-* de cada <li> y nada obliga a scroll horizontal.
 */
(function () {
  const PESO_PRIORIDAD = { high: 3, medium: 2, low: 1 };

  let filtroEstado = 'activos';
  let textoBusqueda = '';

  function coincideEstado(item) {
    const estado = item.dataset.estado;
    if (filtroEstado === 'todos') return true;
    if (filtroEstado === 'activos') return estado !== 'closed';
    return estado === filtroEstado;
  }

  function coincideBusqueda(item) {
    if (!textoBusqueda) return true;
    return (item.dataset.buscar || '').includes(textoBusqueda);
  }

  function aplicarFiltros(lista, vacio) {
    let visibles = 0;
    lista.querySelectorAll('.ticket-item').forEach((item) => {
      const visible = coincideEstado(item) && coincideBusqueda(item);
      item.hidden = !visible;
      if (visible) visibles++;
    });

    if (vacio) vacio.hidden = visibles > 0 || lista.children.length === 0;
  }

  function ordenar(lista, criterio) {
    const items = Array.from(lista.querySelectorAll('.ticket-item'));

    items.sort((a, b) => {
      switch (criterio) {
        case 'antiguos':
          return Number(a.dataset.creado) - Number(b.dataset.creado);
        case 'prioridad': {
          const diff = (PESO_PRIORIDAD[b.dataset.prioridad] || 0) - (PESO_PRIORIDAD[a.dataset.prioridad] || 0);
          return diff !== 0 ? diff : Number(b.dataset.creado) - Number(a.dataset.creado);
        }
        case 'respuesta':
          return Number(b.dataset.respuesta) - Number(a.dataset.respuesta);
        default:
          return Number(b.dataset.creado) - Number(a.dataset.creado);
      }
    });

    items.forEach((item) => lista.appendChild(item));
  }

  async function abrirDetalle(href, modalBody, modalId) {
    if (!href || !modalBody) return;

    modalBody.innerHTML = '<div class="ticket-modal-state">Cargando detalles del ticket...</div>';
    window.IntranetModal?.open(modalId);

    try {
      // `volver` deja al gestor de vuelta en el listado tras guardar, en vez de
      // caer en la página suelta del ticket.
      const volver = encodeURIComponent(window.location.pathname);
      const res = await fetch(`${href}?modal=true&volver=${volver}`);
      if (!res.ok) throw new Error('Error al obtener el ticket');
      modalBody.innerHTML = await res.text();
      window.TicketDetail?.init(modalBody);

      modalBody.querySelectorAll('script').forEach((oldScript) => {
        const newScript = document.createElement('script');
        Array.from(oldScript.attributes).forEach((attr) => newScript.setAttribute(attr.name, attr.value));
        newScript.appendChild(document.createTextNode(oldScript.innerHTML));
        oldScript.parentNode.replaceChild(newScript, oldScript);
      });
    } catch (err) {
      console.error(err);
      modalBody.innerHTML = '<div class="ticket-modal-state ticket-modal-state--error">Hubo un error al cargar el ticket.</div>';
    }
  }

  /**
   * /soporte?ticket=ID es la dirección de un ticket (crear, confirmar
   * o el asistente llevan aquí): se abre en el modal y se limpia la URL.
   */
  function abrirDesdeUrl(modalBody, modalId) {
    const params = new URLSearchParams(window.location.search);
    const ticketId = params.get('ticket');
    if (!ticketId || !/^\d+$/.test(ticketId)) return;

    params.delete('ticket');
    const qs = params.toString();
    window.history.replaceState({}, document.title, window.location.pathname + (qs ? `?${qs}` : ''));
    abrirDetalle(`/soporte/tickets/${ticketId}`, modalBody, modalId);
  }

  function init() {
    const modalId = 'modalVerTicketDetalle';
    const modalBody = document.getElementById('modalVerTicketDetalleBody');
    abrirDesdeUrl(modalBody, modalId);

    const lista = document.getElementById('ticketsLista');
    if (!lista) return;

    const vacio = document.getElementById('ticketsVacio');
    const buscador = document.getElementById('ticketsBuscar');
    const selectOrden = document.getElementById('ticketsOrden');
    const chips = document.querySelectorAll('[data-filtro-estado]');

    lista.addEventListener('click', (e) => {
      const item = e.target.closest('.ticket-item');
      if (!item) return;
      e.preventDefault();
      abrirDetalle(item.getAttribute('data-href'), modalBody, modalId);
    });

    chips.forEach((chip) => {
      chip.addEventListener('click', () => {
        filtroEstado = chip.dataset.filtroEstado;
        chips.forEach((c) => c.classList.toggle('is-active', c === chip));
        aplicarFiltros(lista, vacio);
      });
    });

    buscador?.addEventListener('input', () => {
      textoBusqueda = buscador.value.trim().toLowerCase();
      aplicarFiltros(lista, vacio);
    });

    selectOrden?.addEventListener('change', () => ordenar(lista, selectOrden.value));

    // Los usuarios ven pocos tickets propios; el admin arranca sin los cerrados.
    if (document.querySelector('[data-ticket-list-admin="true"]')) {
      filtroEstado = 'activos';
    } else {
      filtroEstado = 'todos';
      chips.forEach((c) => c.classList.toggle('is-active', c.dataset.filtroEstado === 'todos'));
    }

    ordenar(lista, 'recientes');
    aplicarFiltros(lista, vacio);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
