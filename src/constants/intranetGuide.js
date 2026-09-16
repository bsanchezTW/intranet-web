/**
 * Catálogo de la intranet para el asistente de ayuda.
 *
 * Es la única fuente de verdad sobre "dónde está X": el modelo no conoce el
 * menú, así que todo lo que diga de rutas y funciones tiene que salir de aquí.
 * Refleja la navegación real (layout.ejs, nav-procesos.ejs, nav-rrhh.ejs) y
 * las guardas de cada ruta; si se agrega o mueve una página, se actualiza aquí.
 *
 * Cada entrada interna es además la allowlist de `open_page`: el asistente
 * sólo puede llevar al usuario a un `href` de este catálogo, ya filtrado por
 * features y permisos. Los portales externos sólo se enlazan.
 */

const ACCESS = Object.freeze({
  ALL: "all",
  ADMIN: "admin",
  // Jefes de área, aprobadores de Finanzas y administradores (requireExpenseReviewer).
  EXPENSE_REVIEWER: "expenseReviewer",
  // Administradores de RRHH o de Informática (services/access/staffAccess).
  RRHH_MANAGER: "rrhhManager",
});

function areaFolderHref(section) {
  return (ctx) =>
    !ctx.isAdmin && ctx.workAreaId
      ? `/procesos/${section}/${ctx.workAreaId}`
      : `/procesos/${section}`;
}

const GUIDE_ENTRIES = Object.freeze([
  {
    id: "inicio",
    title: "Inicio",
    href: "/",
    paths: [/^\/$/],
    summary:
      "Panel de inicio con indicadores financieros, clima y noticias recientes.",
    featureNotes: {
      lunchMenu: "Muestra el menú semanal del casino.",
      homeQuickAccess: "Tiene accesos rápidos a Academy, el sitio web y portales de RRHH.",
    },
  },
  {
    id: "noticias",
    title: "Noticias y comunicados",
    href: "/noticias",
    paths: [/^\/noticias(\/|$)/],
    summary: "Novedades y comunicados internos de Transworld. Se abre cada nota para leerla completa.",
  },
  {
    id: "procesos",
    title: "Procesos y Documentos",
    href: "/procesos",
    paths: [/^\/procesos\/?$/],
    summary:
      "Portada con la sección Finanzas (rendir gastos, solicitar fondos, mis solicitudes), " +
      "los documentos generales (reglamento interno y otros) y los procedimientos y protocolos por área.",
  },
  {
    id: "reglamento",
    title: "Reglamento interno",
    href: "/procesos/reglamento",
    paths: [/^\/procesos\/reglamento(\/|$)/],
    summary: "Normativa, políticas internas y reglas generales de la empresa.",
  },
  {
    id: "otros-documentos",
    title: "Otros documentos",
    href: "/procesos/otros",
    paths: [/^\/procesos\/otros(\/|$)/],
    summary: "Documentación adicional, plantillas e información importante.",
  },
  {
    id: "procedimientos",
    title: "Procedimientos",
    href: "/procesos/procedimientos",
    hrefFor: areaFolderHref("procedimientos"),
    paths: [/^\/procesos\/procedimientos(\/|$)/],
    summary: "Instructivos paso a paso para tareas operativas y recurrentes, organizados por área.",
  },
  {
    id: "protocolos",
    title: "Protocolos",
    href: "/procesos/protocolos",
    hrefFor: areaFolderHref("protocolos"),
    paths: [/^\/procesos\/protocolos(\/|$)/],
    summary: "Lineamientos formales para situaciones específicas y de seguridad, organizados por área.",
  },
  {
    id: "gastos-rendicion",
    title: "Rendir gastos",
    href: "/gastos/nueva/rendicion",
    feature: "expenseRequests",
    paths: [/^\/gastos\/nueva\/rendicion(\/|$)/],
    summary: "Declarar gastos o compras que ya pagaste de tu bolsillo, con sus comprobantes, para que te los reembolsen.",
    steps: [
      "Elige qué vas a rendir y revisa tus datos de solicitante.",
      "Agrega una línea por cada gasto en el desglose («+ Agregar línea»).",
      "Adjunta los comprobantes.",
      "Indica la cuenta de destino de la transferencia.",
      "Envía la solicitud, o «Guardar borrador» para terminarla después.",
    ],
    notes: [
      "La aprueba primero la jefatura de tu área y después Finanzas.",
      "No está disponible hasta que tu área tenga un jefe asignado.",
    ],
  },
  {
    id: "gastos-fondos",
    title: "Solicitar fondos",
    href: "/gastos/nueva/fondos",
    feature: "expenseRequests",
    paths: [/^\/gastos\/nueva\/fondos(\/|$)/],
    summary: "Pedir dinero por adelantado para una compra o gestión que todavía no realizas.",
    notes: [
      "Un fondo aprobado se rinde después: hay 1 día hábil de gracia tras el fin del viaje y luego 5 días hábiles para enviar la rendición.",
      "No está disponible hasta que tu área tenga un jefe asignado.",
    ],
  },
  {
    id: "gastos-mis-solicitudes",
    title: "Mis solicitudes de gastos",
    href: "/gastos",
    feature: "expenseRequests",
    paths: [/^\/gastos\/?$/, /^\/gastos\/\d+(\/|$)/],
    summary: "Estado e historial de tus rendiciones y solicitudes de fondos: en curso, borradores, aprobadas, rechazadas y anuladas.",
  },
  {
    id: "gastos-gestion",
    title: "Gestión de solicitudes de gastos",
    href: "/gastos/gestion",
    feature: "expenseRequests",
    access: ACCESS.EXPENSE_REVIEWER,
    paths: [/^\/gastos\/gestion(\/|$)/],
    summary: "Aprobar, rechazar y consultar el historial de las solicitudes que te corresponden revisar.",
  },
  {
    id: "rrhh",
    title: "Recursos Humanos",
    href: "/RRHH",
    paths: [/^\/RRHH\/?$/],
    summary: "Portada de RRHH: organigrama, directorio de colaboradores, vacaciones y portales de beneficios.",
  },
  {
    id: "personal",
    title: "Personal (directorio)",
    href: "/RRHH/personal",
    paths: [/^\/RRHH\/personal(\/|$)/],
    summary: "Directorio de colaboradores con correo, teléfono y área. Se busca por nombre y se filtra por área.",
  },
  {
    id: "organigrama",
    title: "Organigrama",
    href: "/RRHH/organigrama",
    paths: [/^\/RRHH\/organigrama(\/|$)/],
    summary: "Estructura general y departamentos de Transworld.",
  },
  {
    id: "areas",
    title: "Áreas de trabajo",
    href: "/RRHH/areas",
    access: ACCESS.RRHH_MANAGER,
    paths: [/^\/RRHH\/areas(\/|$)/],
    summary: "Áreas de trabajo de la empresa y quiénes pertenecen a cada una.",
  },
  {
    id: "centros-costo",
    title: "Centros de costo",
    href: "/RRHH/centros-costo",
    feature: "expenseCenter",
    access: ACCESS.RRHH_MANAGER,
    paths: [/^\/RRHH\/centros-costo(\/|$)/],
    summary: "Centros de costo de la empresa.",
  },
  {
    id: "vacaciones",
    title: "Vacaciones",
    href: "/RRHH/vacaciones",
    feature: "vacations",
    paths: [/^\/RRHH\/vacaciones\/?$/],
    summary: "Portada de vacaciones: consultar tu saldo, solicitar días y revisar tu historial.",
  },
  {
    id: "mis-vacaciones",
    title: "Mis vacaciones",
    href: "/RRHH/vacaciones/mis-vacaciones",
    feature: "vacations",
    paths: [/^\/RRHH\/vacaciones\/mis-vacaciones(\/|$)/],
    summary: "Tu saldo de vacaciones, el formulario para pedir días y el historial de tus solicitudes.",
    steps: [
      "En el panel «Solicitar vacaciones», elige las fechas «Desde» y «Hasta».",
      "Revisa el resumen de días que aparece y confirma los avisos si se muestran.",
      "Agrega un comentario si quieres y presiona «Enviar solicitud».",
    ],
    notes: ["El formulario sólo aparece si tu ficha tiene fecha de ingreso; si no, hay que pedirla a RRHH."],
  },
  {
    id: "vacaciones-calendario",
    title: "Calendario de vacaciones",
    href: "/RRHH/vacaciones/calendario",
    feature: "vacations",
    paths: [/^\/RRHH\/vacaciones\/calendario(\/|$)/],
    summary: "Calendario con las vacaciones del equipo.",
  },
  {
    id: "vacaciones-gestion",
    title: "Gestión de vacaciones",
    href: "/RRHH/vacaciones/gestion",
    feature: "vacations",
    access: ACCESS.RRHH_MANAGER,
    paths: [/^\/RRHH\/vacaciones\/gestion(\/|$)/],
    summary: "Aprobar o rechazar solicitudes de vacaciones y revisar los saldos del equipo.",
  },
  {
    id: "feriados",
    title: "Feriados",
    href: "/RRHH/feriados",
    access: ACCESS.RRHH_MANAGER,
    paths: [/^\/RRHH\/feriados(\/|$)/],
    summary: "Administración de los feriados del país: se usan para el horario hábil de Soporte y para las vacaciones.",
  },
  {
    id: "academy",
    title: "Academy (cursos)",
    href: "/cursos",
    paths: [/^\/cursos(\/|$)/],
    summary: "Cursos de capacitación (Equipamiento activo, Fibra óptica, Infraestructura y Safety Machine) con sus evaluaciones.",
  },
  {
    id: "kpi-cursos",
    title: "Dashboard de capacitaciones",
    href: "/kpi-cursos",
    paths: [/^\/kpi-cursos(\/|$)/],
    summary: "Ranking general, rendimiento por curso y seguimiento individual de las capacitaciones de Academy.",
  },
  {
    id: "apps",
    title: "Aplicaciones",
    href: "/apps",
    paths: [/^\/apps(\/|$)/],
    summary: "Descarga de las aplicaciones y herramientas corporativas oficiales.",
  },
  {
    id: "galeria",
    title: "Galería de eventos",
    href: "/marketing/eventos",
    paths: [/^\/marketing(\/|$)/],
    summary: "Eventos de la empresa y sus galerías de fotos.",
  },
  {
    id: "soporte",
    title: "Soporte TI",
    href: "/sistemas/tickets",
    feature: "supportTickets",
    paths: [/^\/sistemas\/?$/, /^\/sistemas\/tickets\/?$/, /^\/sistemas\/tickets\/\d+(\/|$)/],
    summary: "Herramientas de autoayuda para problemas comunes y tus tickets con el equipo de TI (abiertos, en curso y cerrados).",
  },
  {
    id: "nuevo-ticket",
    title: "Abrir un ticket de soporte",
    href: "/sistemas/tickets/nuevo",
    feature: "supportTickets",
    paths: [/^\/sistemas\/tickets\/nuevo(\/|$)/],
    summary: "Crear un caso para el equipo de TI. También se abre con el botón «Abrir Ticket» de la barra superior.",
  },
  {
    id: "perfil",
    title: "Mi perfil",
    href: "/perfil",
    paths: [/^\/perfil(\/|$)/],
    summary: "Tus datos de contacto, foto de perfil y contraseña. Algunos datos los administra RRHH.",
    steps: ["Haz clic en tu foto (arriba a la derecha) y elige «Mi Perfil»."],
  },
  {
    id: "rex",
    title: "Rex+",
    url: "https://transworld.mirexmas.com/",
    feature: "chileHrPortals",
    summary: "Portal externo de RRHH: liquidaciones y, en Chile, la solicitud de vacaciones.",
  },
  {
    id: "achs",
    title: "ACHS",
    url: "https://www.achs.cl/",
    feature: "chileHrPortals",
    summary: "Portal externo de salud y seguridad laboral.",
  },
  {
    id: "caja-los-andes",
    title: "Caja Los Andes",
    url: "https://www.cajalosandes.cl/",
    feature: "chileHrPortals",
    summary: "Portal externo de beneficios, convenios y ahorros.",
  },
  {
    id: "bci-seguros",
    title: "BCI Seguros",
    url: "https://clientes.bciseguros.cl/HomePrivado/LinkLogin",
    feature: "chileHrPortals",
    summary: "Portal externo de seguros.",
  },
  {
    id: "salesforce",
    title: "Salesforce",
    url: "https://login.salesforce.com/",
    summary: "CRM comercial (externo).",
  },
]);

function isEntryVisible(entry, ctx) {
  if (entry.feature && !(ctx.features && ctx.features[entry.feature])) return false;
  if (entry.access === ACCESS.ADMIN) return Boolean(ctx.isAdmin);
  if (entry.access === ACCESS.RRHH_MANAGER) return Boolean(ctx.canManageRrhh);
  if (entry.access === ACCESS.EXPENSE_REVIEWER) {
    return Boolean(ctx.isAdmin || ctx.isExpenseReviewer);
  }
  return true;
}

/**
 * Catálogo que corresponde a este usuario, con el href ya resuelto.
 * @param ctx { features, isAdmin, isExpenseReviewer, canManageRrhh, workAreaId }
 */
function guideForUser(ctx = {}) {
  return GUIDE_ENTRIES.filter((entry) => isEntryVisible(entry, ctx)).map((entry) => {
    const notes = [...(entry.notes || [])];
    for (const [feature, note] of Object.entries(entry.featureNotes || {})) {
      if (ctx.features && ctx.features[feature]) notes.push(note);
    }
    return {
      id: entry.id,
      title: entry.title,
      href: entry.hrefFor ? entry.hrefFor(ctx) : entry.href || null,
      url: entry.url || null,
      external: Boolean(entry.url),
      paths: entry.paths || [],
      summary: entry.summary,
      steps: entry.steps || [],
      notes,
    };
  });
}

/** Página del catálogo a la que corresponde un pathname (la coincidencia más específica). */
function findEntryForPath(pathname, entries) {
  const path = String(pathname || "");
  let best = null;
  let bestLength = -1;
  for (const entry of entries) {
    if (entry.external) continue;
    for (const pattern of entry.paths) {
      const match = pattern.exec(path);
      if (match && match[0].length > bestLength) {
        best = entry;
        bestLength = match[0].length;
      }
    }
  }
  return best;
}

/** Entrada interna navegable por id, o null si no existe o no está permitida. */
function resolvePage(pageId, entries) {
  const id = String(pageId || "").trim();
  return entries.find((entry) => entry.id === id && !entry.external && entry.href) || null;
}

function normalizePathname(pathname) {
  const path = String(pathname || "").split(/[?#]/)[0];
  return path.length > 1 ? path.replace(/\/+$/, "") : path;
}

function isSamePage(href, pathname) {
  return normalizePathname(href) === normalizePathname(pathname);
}

/**
 * Índice del catálogo para el system prompt: id, título, ruta y una línea.
 * Los pasos y notas no van aquí (se piden con get_page_help) para que cada
 * ronda del ciclo de tools cargue lo mínimo.
 */
function formatGuideForPrompt(entries) {
  const internal = entries.filter((entry) => !entry.external);
  const external = entries.filter((entry) => entry.external);
  const lines = ["### Páginas internas (id para open_page y get_page_help)"];
  for (const entry of internal) {
    lines.push(`- \`${entry.id}\` ${entry.title} — ${entry.href}: ${entry.summary}`);
  }
  if (external.length) {
    lines.push("", "### Portales externos (sólo enlace, nunca open_page)");
    for (const entry of external) {
      lines.push(`- ${entry.title} — ${entry.url}: ${entry.summary}`);
    }
  }
  return lines.join("\n");
}

module.exports = {
  ACCESS,
  GUIDE_ENTRIES,
  guideForUser,
  findEntryForPath,
  resolvePage,
  isSamePage,
  formatGuideForPrompt,
};
