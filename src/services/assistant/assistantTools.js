const {
  findEntryForPath,
  resolvePage,
  isSamePage,
  formatGuideForPrompt,
} = require("../../constants/intranetGuide");
const { TICKET_CATEGORIES, normalizeTicketCategory } = require("../../constants/ticketCategories");
const {
  TICKET_PRIORITIES,
  MAX_TITLE_CHARS,
  MAX_DESCRIPTION_CHARS,
} = require("../tickets/ticketRules");

/**
 * Tools del asistente de ayuda y el contexto que acompaña cada turno.
 *
 * Todo se valida en el servidor: `open_page` sólo acepta ids del catálogo ya
 * filtrado para el usuario, y la navegación no ocurre aquí — se devuelve en el
 * evento `done` para que el cliente cambie de página cuando el texto terminó.
 */

const STATUS_LABELS = Object.freeze({
  search_people: "Buscando personas…",
  search_documents: "Buscando documentos…",
  search_events: "Buscando eventos…",
  open_page: "Preparando el enlace…",
  get_page_help: "Revisando la guía…",
  offer_support_ticket: "Preparando opciones de ticket…",
  draft_support_ticket: "Armando el borrador del ticket…",
  my_tickets: "Revisando tus tickets…",
});

/** Respuesta de los tools de tickets donde no existe la ticketera. */
const TICKETS_UNAVAILABLE = Object.freeze({ content: "Soporte no está disponible en esta intranet.", isError: true });

/** Tools de Soporte: sólo donde existe la ticketera. */
function ticketToolDefinitions() {
  const categoryKeys = TICKET_CATEGORIES.map((category) => category.key);
  const categoryGuide = TICKET_CATEGORIES.map(
    (category) => `${category.key}: ${category.label} (${category.hint})`,
  ).join("; ");
  return [
    {
      name: "offer_support_ticket",
      description:
        "Muestra al usuario dos botones: abrir el formulario de ticket prellenado o pedirte que lo crees. " +
        "Úsalo cuando cuente un problema técnico y todavía no haya pedido que crees el ticket.",
      input_schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Resumen del problema en una línea (máx. 120 caracteres)." },
          category: { type: "string", enum: categoryKeys, description: "Categoría probable (las mismas de draft_support_ticket)." },
        },
        required: ["summary"],
      },
    },
    {
      name: "draft_support_ticket",
      description:
        "Arma un borrador de ticket de Soporte que el usuario revisa y confirma con el botón «Crear ticket». " +
        "No crea el ticket. Los archivos que el usuario adjuntó en el chat se suben solos al crearlo.",
      input_schema: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: `Resumen claro del problema (máx. ${MAX_TITLE_CHARS} caracteres, idealmente menos de 80).`,
          },
          description: {
            type: "string",
            description: `Qué pasa, desde cuándo, qué intentó y a quién afecta, con las palabras del usuario (máx. ${MAX_DESCRIPTION_CHARS} caracteres).`,
          },
          category: { type: "string", enum: categoryKeys, description: categoryGuide },
          priority: {
            type: "string",
            enum: [...TICKET_PRIORITIES],
            description: "high: no puede trabajar u operación detenida; medium: le dificulta el trabajo; low: no le impide trabajar.",
          },
        },
        required: ["title", "description", "category", "priority"],
      },
    },
    {
      name: "my_tickets",
      description: "Lista los tickets de Soporte abiertos del usuario con su estado y enlace.",
      input_schema: { type: "object", properties: {} },
    },
  ];
}

function buildToolDefinitions(entries, { supportTickets = false } = {}) {
  const pageIds = entries.filter((entry) => !entry.external && entry.href).map((entry) => entry.id);
  return [
    {
      name: "get_page_help",
      description:
        "Devuelve los pasos y notas de una página del catálogo. Úsalo antes de explicar cómo se usa algo.",
      input_schema: {
        type: "object",
        properties: {
          page_id: { type: "string", enum: pageIds, description: "id de la página en el catálogo." },
        },
        required: ["page_id"],
      },
    },
    {
      name: "search_people",
      description:
        "Busca colaboradores en el directorio de la intranet por nombre, apellido, correo o área. " +
        "Devuelve nombre, correo, teléfono y área. Úsalo cuando pregunten por una persona o por quién está en un área.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Nombre, apellido, correo o área a buscar." },
        },
        required: ["query"],
      },
    },
    {
      name: "search_documents",
      description:
        "Busca documentos de Procesos y Documentos (reglamento, procedimientos, protocolos, otros) por su nombre. " +
        "No lee el contenido de los archivos.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Palabras del nombre del documento." },
        },
        required: ["query"],
      },
    },
    {
      name: "search_events",
      description:
        "Busca eventos de la galería por su nombre y devuelve el enlace a sus fotos. " +
        "Úsalo cuando pregunten por un evento o una celebración en particular.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Palabras del nombre del evento." },
        },
        required: ["query"],
      },
    },
    {
      name: "open_page",
      description:
        "Lleva al usuario a una página interna del catálogo cuando termine tu respuesta. " +
        "Úsalo sólo si pregunta dónde está algo o pide ir a una página, y no si ya está en ella.",
      input_schema: {
        type: "object",
        properties: {
          page_id: { type: "string", enum: pageIds, description: "id de la página en el catálogo." },
        },
        required: ["page_id"],
      },
    },
    ...(supportTickets ? ticketToolDefinitions() : []),
  ];
}

/**
 * Ejecutor de tools para un turno. Las búsquedas se inyectan para poder
 * probarlo sin base de datos.
 */
function createToolExecutor({ entries, currentPath, searchPeople, searchDocuments, searchEvents, tickets = null }) {
  let navigation = null;
  // Tarjetas para el cliente al terminar el turno.
  let ticketOffer = null;
  let ticketDraft = null;

  async function runSearch(search, query, extra = {}) {
    const text = String(query || "").trim();
    if (!text) return { content: "Falta el texto a buscar.", isError: true };
    try {
      const resultados = await search(text);
      return { content: JSON.stringify({ total: resultados.length, resultados, ...extra }) };
    } catch (err) {
      console.error("[Asistente] Error en búsqueda:", err.message);
      return { content: "La búsqueda no está disponible en este momento.", isError: true };
    }
  }

  async function execute(name, input = {}) {
    switch (name) {
      case "search_people":
        return runSearch(searchPeople, input.query, {
          enlace_directorio: `/RRHH/personal?q=${encodeURIComponent(String(input.query || "").trim())}`,
        });
      case "search_documents":
        return runSearch(searchDocuments, input.query);
      case "search_events":
        return runSearch(searchEvents, input.query);
      case "get_page_help": {
        const entry = resolvePage(input.page_id, entries);
        if (!entry) return { content: "Esa página no está en el catálogo del usuario.", isError: true };
        return {
          content: JSON.stringify({
            titulo: entry.title,
            ruta: entry.href,
            descripcion: entry.summary,
            pasos: entry.steps,
            notas: entry.notes,
          }),
        };
      }
      case "open_page": {
        const entry = resolvePage(input.page_id, entries);
        if (!entry) {
          return {
            content: "Esa página no existe en el catálogo o el usuario no tiene acceso. No se navegará.",
            isError: true,
          };
        }
        if (isSamePage(entry.href, currentPath)) {
          return { content: `El usuario ya está en «${entry.title}». No se navegará.` };
        }
        navigation = { href: entry.href, label: entry.title };
        return { content: `Al terminar tu respuesta se llevará al usuario a «${entry.title}» (${entry.href}).` };
      }
      case "offer_support_ticket": {
        if (!tickets) return TICKETS_UNAVAILABLE;
        const summary = String(input.summary || "").trim().slice(0, 200);
        if (!summary) return { content: "Falta el resumen del problema.", isError: true };
        ticketOffer = { summary, category: normalizeTicketCategory(input.category) };
        return {
          content: "Al terminar tu respuesta el usuario verá los botones «Abrir formulario» y «Créalo por mí». No los repitas en el texto.",
        };
      }
      case "draft_support_ticket": {
        if (!tickets) return TICKETS_UNAVAILABLE;
        const saved = tickets.saveDraft(input);
        if (!saved.ok) return { content: saved.error, isError: true };
        ticketDraft = saved.draft;
        ticketOffer = null;
        return {
          content: JSON.stringify({
            estado: "borrador listo, el ticket AÚN NO está creado",
            adjuntos: tickets.attachmentCount || 0,
            siguiente_paso: "Pide al usuario revisar la tarjeta y pulsar «Crear ticket».",
          }),
        };
      }
      case "my_tickets": {
        if (!tickets) return TICKETS_UNAVAILABLE;
        try {
          const list = await tickets.listMine();
          return { content: JSON.stringify({ total: list.length, tickets: list }) };
        } catch (err) {
          console.error("[Asistente] Error listando tickets:", err.message);
          return { content: "No pude consultar tus tickets en este momento.", isError: true };
        }
      }
      default:
        return { content: `Tool desconocida: ${name}`, isError: true };
    }
  }

  return {
    execute,
    getNavigation: () => navigation,
    getActions: () => ({ ticketOffer, ticketDraft }),
  };
}

/** Página que reporta el cliente, acotada: sólo rutas internas y un título corto. */
function sanitizePage(raw) {
  const path = typeof raw?.path === "string" ? raw.path.trim().slice(0, 300) : "";
  const title = typeof raw?.title === "string" ? raw.title.trim().slice(0, 120) : "";
  return {
    path: path.startsWith("/") && !path.startsWith("//") ? path.split(/[?#]/)[0] : "/",
    title,
  };
}

const yesNo = (value) => (value ? "sí" : "no");

/** Bloque de sistema del turno: página actual y usuario. Cambia en cada turno, va fuera del caché. */
function buildContextPrompt({ entries, page, user = {}, isAdmin, isExpenseReviewer, features = {}, attachments = null }) {
  const current = findEntryForPath(page.path, entries);
  const pageLine = current
    ? `${current.title} (\`${current.id}\`)`
    : "no corresponde a ninguna página del catálogo";
  const name = user.nombre || [user.first_name, user.last_name].filter(Boolean).join(" ") || "sin nombre";

  const attachmentsLine = Array.isArray(attachments)
    ? `\n- Adjuntos del usuario en el chat (se suben al crear el ticket): ${
        attachments.length ? attachments.map((item) => item.nombre).join(", ") : "ninguno"
      }`
    : "";

  return `## CONTEXTO DE ESTE TURNO
- Página actual: ${page.title || "sin título"} — ruta ${page.path} — ${pageLine}
- Usuario: ${name}; área: ${user.area || "sin área asignada"}
- Administrador: ${yesNo(isAdmin)}; revisor de gastos: ${yesNo(isExpenseReviewer)}
- En esta intranet: Soporte ${yesNo(features.supportTickets)}; rendiciones y fondos ${yesNo(features.expenseRequests)}; portales RRHH de Chile ${yesNo(features.chileHrPortals)}; vacaciones en la intranet ${yesNo(features.vacations)} (si no, se solicitan en Rex+)${attachmentsLine}`;
}

/** Catálogo filtrado para este usuario: estable entre turnos, por eso va en el bloque cacheado. */
function buildCatalogPrompt(entries) {
  return `## CATÁLOGO DE LA INTRANET (sólo lo que este usuario puede ver)
${formatGuideForPrompt(entries)}`;
}

module.exports = {
  STATUS_LABELS,
  buildToolDefinitions,
  createToolExecutor,
  sanitizePage,
  buildContextPrompt,
  buildCatalogPrompt,
};
