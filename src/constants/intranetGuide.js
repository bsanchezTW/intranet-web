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

const { decide } = require("../services/permissions/decide");
const expensePolicy = require("../services/expenses/expensePolicy");
const vacationPolicy = require("../services/vacations/vacationPolicy");
const { veListadoDeCarpetas } = require("../services/documents/processAccess");

/*
  Cada página interna lleva `allowed(perms)`: los mismos permisos que exige su
  ruta en Gestión de Permisos. Así el asistente no ofrece lo que daría 403.
  Los portales externos no llevan permiso (sólo se enlazan).
*/

/** Todas las claves concedidas. */
function puede(...keys) {
  return (perms) => keys.every((key) => decide(perms, key));
}

/** Quien no ve el listado de carpetas entra directo a la de su área, como en Procesos. */
function areaFolderHref(section) {
  return (ctx) =>
    !veListadoDeCarpetas(ctx.perms) && ctx.workAreaId
      ? `/procesos/${section}/${ctx.workAreaId}`
      : `/procesos/${section}`;
}

const GUIDE_ENTRIES = Object.freeze([
  {
    id: "inicio",
    allowed: puede("inicio.acceso"),
    title: "Inicio",
    href: "/",
    paths: [/^\/$/],
    summary:
      "Panel de inicio con indicadores financieros, clima y noticias recientes.",
    featureNotes: {
      lunchMenu: "Muestra el menú semanal del casino.",
      homeQuickAccess: "Tiene una banda de accesos rápidos. Cada persona puede ocultarlos y cambiar su orden.",
    },
  },
  {
    id: "noticias",
    allowed: puede("noticias.acceso", "noticias.noticia.ver"),
    title: "Noticias y comunicados",
    href: "/noticias",
    paths: [/^\/noticias(\/|$)/],
    summary: "Novedades y comunicados internos de Transworld. Se abre cada nota para leerla completa.",
  },
  {
    id: "procesos",
    allowed: puede("procesos.acceso"),
    title: "Procesos y Documentos",
    href: "/procesos",
    paths: [/^\/procesos\/?$/],
    summary:
      "Portada con los documentos generales (reglamento interno y otros) y los procedimientos y protocolos por área.",
    featureNotes: {
      expenseRequests:
        "Incluye la sección Finanzas: rendir gastos, solicitar fondos y mis solicitudes.",
    },
  },
  {
    id: "reglamento",
    allowed: puede("procesos.acceso", "procesos.reglamento.ver"),
    title: "Reglamento interno",
    href: "/procesos/reglamento",
    paths: [/^\/procesos\/reglamento(\/|$)/],
    summary: "Normativa, políticas internas y reglas generales de la empresa.",
  },
  {
    id: "otros-documentos",
    allowed: puede("procesos.acceso", "procesos.otros.ver"),
    title: "Otros documentos",
    href: "/procesos/otros",
    paths: [/^\/procesos\/otros(\/|$)/],
    summary: "Documentación adicional, plantillas e información importante.",
  },
  {
    id: "procedimientos",
    allowed: puede("procesos.acceso", "procesos.procedimientos.ver"),
    title: "Procedimientos",
    href: "/procesos/procedimientos",
    hrefFor: areaFolderHref("procedimientos"),
    paths: [/^\/procesos\/procedimientos(\/|$)/],
    summary: "Instructivos paso a paso para tareas operativas y recurrentes, organizados por área.",
  },
  {
    id: "protocolos",
    allowed: puede("procesos.acceso", "procesos.protocolos.ver"),
    title: "Protocolos",
    href: "/procesos/protocolos",
    hrefFor: areaFolderHref("protocolos"),
    paths: [/^\/procesos\/protocolos(\/|$)/],
    summary: "Lineamientos formales para situaciones específicas y de seguridad, organizados por área.",
  },
  {
    id: "gastos-rendicion",
    allowed: puede("gastos.acceso", "gastos.solicitud.crear"),
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
    allowed: puede("gastos.acceso", "gastos.solicitud.crear"),
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
    allowed: puede("gastos.acceso"),
    title: "Mis solicitudes de gastos",
    href: "/gastos",
    feature: "expenseRequests",
    paths: [/^\/gastos\/?$/, /^\/gastos\/\d+(\/|$)/],
    summary: "Estado e historial de tus rendiciones y solicitudes de fondos: en curso, borradores, aprobadas, rechazadas y anuladas.",
  },
  {
    id: "gastos-gestion",
    allowed: (perms) => puede("gastos.acceso")(perms) && expensePolicy.esRevisor(perms),
    title: "Gestión de solicitudes de gastos",
    href: "/gastos/gestion",
    feature: "expenseRequests",
    paths: [/^\/gastos\/gestion(\/|$)/],
    summary: "Aprobar, rechazar y consultar el historial de las solicitudes que te corresponden revisar.",
  },
  {
    id: "rrhh",
    allowed: puede("rrhh.acceso"),
    title: "Recursos Humanos",
    href: "/RRHH",
    paths: [/^\/RRHH\/?$/],
    summary: "Portada de RRHH: organigrama, directorio de colaboradores, vacaciones y portales de beneficios.",
  },
  {
    id: "personal",
    allowed: puede("rrhh.directorio.ver"),
    title: "Personal (directorio)",
    href: "/RRHH/personal",
    paths: [/^\/RRHH\/personal(\/|$)/],
    summary: "Directorio de colaboradores con correo, teléfono y área. Se busca por nombre y se filtra por área.",
  },
  {
    id: "organigrama",
    allowed: puede("organigrama.acceso"),
    title: "Organigrama",
    href: "/RRHH/organigrama",
    paths: [/^\/RRHH\/organigrama(\/|$)/],
    summary:
      "Áreas de trabajo de la empresa, quién dirige cada una, de qué área depende y quiénes pertenecen a ella. Se busca por área o por colaborador.",
    notes: [
      "Las áreas se administran aquí mismo, no hay una pantalla de Áreas aparte: quien gestiona RRHH ve el botón «Editar organigrama» para crear, editar y eliminar áreas, asignarles jefe y área superior, y mover colaboradores.",
    ],
  },
  {
    id: "centros-costo",
    allowed: puede("centros_costo.acceso"),
    title: "Centros de costo",
    href: "/RRHH/centros-costo",
    feature: "expenseCenter",
    paths: [/^\/RRHH\/centros-costo(\/|$)/],
    summary: "Centros de costo de la empresa.",
  },
  {
    id: "vacaciones",
    allowed: puede("vacaciones.acceso"),
    title: "Vacaciones",
    href: "/RRHH/vacaciones",
    feature: "vacations",
    paths: [/^\/RRHH\/vacaciones\/?$/],
    summary: "Portada de vacaciones: consultar tu saldo, solicitar días y revisar tu historial.",
  },
  {
    id: "mis-vacaciones",
    allowed: puede("vacaciones.acceso"),
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
    allowed: puede("vacaciones.acceso", "vacaciones.calendario.ver"),
    title: "Calendario de vacaciones",
    href: "/RRHH/vacaciones/calendario",
    feature: "vacations",
    paths: [/^\/RRHH\/vacaciones\/calendario(\/|$)/],
    summary: "Calendario mensual con las vacaciones aprobadas de todo el equipo.",
  },
  {
    id: "vacaciones-gestion",
    allowed: (perms) => puede("vacaciones.acceso")(perms) && vacationPolicy.veGestion(perms),
    title: "Gestión de vacaciones",
    href: "/RRHH/vacaciones/gestion",
    feature: "vacations",
    paths: [/^\/RRHH\/vacaciones\/gestion(\/|$)/],
    summary: "Aprobar o rechazar solicitudes de vacaciones y revisar los saldos del equipo.",
  },
  {
    id: "vacaciones-resumen",
    allowed: (perms) => puede("vacaciones.acceso")(perms) && vacationPolicy.veGestion(perms),
    title: "Resumen de vacaciones",
    href: "/RRHH/vacaciones/gestion/resumen",
    feature: "vacations",
    paths: [/^\/RRHH\/vacaciones\/gestion\/resumen(\/|$)/],
    summary:
      "Días vencidos que cada colaborador debe tomar, plazo legal, trunco, liquidación y exportación a Excel. " +
      "Desde aquí se abre la ficha de cada uno para cargar sus vacaciones anteriores a la intranet.",
  },
  {
    id: "feriados",
    allowed: puede("feriados.acceso", "feriados.feriado.ver"),
    title: "Feriados",
    href: "/RRHH/feriados",
    paths: [/^\/RRHH\/feriados(\/|$)/],
    summary: "Administración de los feriados del país: se usan para el horario hábil de Soporte y para las vacaciones.",
  },
  {
    id: "academy",
    allowed: puede("cursos.acceso"),
    title: "Academy (cursos)",
    href: "/cursos",
    paths: [/^\/cursos(\/|$)/],
    summary: "Cursos de capacitación (Equipamiento activo, Fibra óptica, Infraestructura y Safety Machine) con sus evaluaciones.",
  },
  {
    id: "kpi-cursos",
    allowed: puede("cursos.acceso", "cursos.avance.ver"),
    title: "Dashboard de capacitaciones",
    href: "/kpi-cursos",
    paths: [/^\/kpi-cursos(\/|$)/],
    summary: "Ranking general, rendimiento por curso y seguimiento individual de las capacitaciones de Academy.",
  },
  {
    id: "apps",
    allowed: puede("apps.acceso", "apps.app.ver"),
    title: "Aplicaciones",
    href: "/apps",
    paths: [/^\/apps(\/|$)/],
    summary: "Descarga de las aplicaciones y herramientas corporativas oficiales.",
  },
  {
    id: "galeria",
    allowed: puede("eventos.acceso", "eventos.evento.ver"),
    title: "Galería de eventos",
    href: "/marketing/eventos",
    paths: [/^\/marketing(\/|$)/],
    summary: "Eventos de la empresa y sus galerías de fotos. Un evento en particular se busca con search_events.",
  },
  {
    id: "soporte",
    allowed: puede("soporte.acceso"),
    title: "Soporte",
    href: "/soporte",
    feature: "supportTickets",
    paths: [/^\/soporte\/?$/, /^\/soporte\/tickets\/?$/, /^\/soporte\/tickets\/\d+(\/|$)/],
    summary: "Autoayuda para problemas comunes y tus tickets con el equipo de TI (abiertos, en curso y cerrados). Un ticket nuevo se abre con «Abrir ticket» en la barra superior o pidiéndoselo al asistente.",
    steps: [
      "Entra a Soporte desde la barra superior.",
      "En «Autoayuda» busca la herramienta para tu problema (por ejemplo «Reparación de Impresora» si no puedes imprimir) y descárgala con el botón de tu sistema.",
      "Ábrela y sigue sus instrucciones. Si el problema sigue, abre un ticket con «Abrir ticket» y cuenta lo que ya probaste.",
      "Tus tickets aparecen más abajo, en «Tickets de soporte», con su estado.",
    ],
  },
  {
    id: "perfil",
    allowed: puede("perfil.acceso"),
    title: "Mi perfil",
    href: "/perfil",
    paths: [/^\/perfil(\/|$)/],
    summary: "Tus datos de contacto, foto de perfil y contraseña. Algunos datos los administra RRHH.",
    steps: ["Haz clic en tu foto (arriba a la derecha) y elige «Mi perfil»."],
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
  if (entry.allowed) return Boolean(entry.allowed(ctx.perms || null));
  return true;
}

/**
 * Catálogo que corresponde a este usuario, con el href ya resuelto.
 * Sin `perms` sólo quedan los portales externos.
 * @param ctx { features, perms, workAreaId }
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
  GUIDE_ENTRIES,
  guideForUser,
  findEntryForPath,
  resolvePage,
  isSamePage,
  formatGuideForPrompt,
};
