const {
  findEntryForPath,
  resolvePage,
  isSamePage,
  formatGuideForPrompt,
} = require("../../constants/intranetGuide");

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
  open_page: "Preparando el enlace…",
});

function buildToolDefinitions(entries) {
  const pageIds = entries.filter((entry) => !entry.external && entry.href).map((entry) => entry.id);
  return [
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
  ];
}

/**
 * Ejecutor de tools para un turno. Las búsquedas se inyectan para poder
 * probarlo sin base de datos.
 */
function createToolExecutor({ entries, currentPath, searchPeople, searchDocuments }) {
  let navigation = null;

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
      default:
        return { content: `Tool desconocida: ${name}`, isError: true };
    }
  }

  return { execute, getNavigation: () => navigation };
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

/** Bloque de sistema del turno: página actual, usuario y catálogo filtrado. */
function buildContextPrompt({ entries, page, user = {}, isAdmin, isExpenseReviewer, features = {} }) {
  const current = findEntryForPath(page.path, entries);
  const pageLine = current
    ? `${current.title} (\`${current.id}\`)`
    : "no corresponde a ninguna página del catálogo";
  const name = user.nombre || [user.first_name, user.last_name].filter(Boolean).join(" ") || "sin nombre";

  return `## CONTEXTO DE ESTE TURNO
- Página actual: ${page.title || "sin título"} — ruta ${page.path} — ${pageLine}
- Usuario: ${name}; área: ${user.area || "sin área asignada"}
- Administrador: ${yesNo(isAdmin)}; revisor de gastos: ${yesNo(isExpenseReviewer)}
- En esta intranet: Soporte TI ${yesNo(features.supportTickets)}; rendiciones y fondos ${yesNo(features.expenseRequests)}; portales RRHH de Chile ${yesNo(features.chileHrPortals)}

## CATÁLOGO DE LA INTRANET (sólo lo que este usuario puede ver)
${formatGuideForPrompt(entries)}`;
}

module.exports = {
  STATUS_LABELS,
  buildToolDefinitions,
  createToolExecutor,
  sanitizePage,
  buildContextPrompt,
};
