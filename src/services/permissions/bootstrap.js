const { canLogin, isAdministrador, normalizeRole } = require("../../constants/roles");
const { normalizeAreaName } = require("../../constants/workAreas");
const { isSupportAreaName } = require("../../constants/supportArea");
const { isFinanceAreaName, financeAreaIds } = require("../../constants/financeArea");
const { accessProfile } = require("../access/staffAccess");
const { SCOPE } = require("./scopes");

/**
 * Arranque de Gestión de Permisos: traduce lo que cada persona puede hacer
 * hoy (rol + nombres de área + jefaturas) a conjuntos y asignaciones, para
 * que activar el módulo no le quite nada a nadie. Puro: recibe personas,
 * áreas y catálogo, y devuelve el plan; scripts/permisos-arranque.js lo
 * muestra y lo aplica.
 *
 * Lo que la auditoría marcó como indebido NO se copia (ver CAMBIOS):
 * cualquier administrador viendo y aprobando cualquier gasto, la
 * autoaprobación, RRHH aprobando vacaciones por encima del jefe y el área
 * "Administración" volviéndose RRHH sólo por su nombre (aquí se asigna a las
 * personas que hoy gestionan RRHH, no al nombre).
 */

const { PROPIO, MI_AREA, A_CARGO, TODO } = SCOPE;

const item = (permission_key, scope = null) => ({ permission_key, scope });

/** Conjuntos iniciales (sección C.7 del plan). Los permisos que el país no tiene se descartan. */
const SYSTEM_SETS = [
  {
    code: "basico",
    name: "Básico",
    description: "Lo que toda cuenta activa usa: leer, solicitar y ver lo propio.",
    items: [
      item("inicio.acceso"),
      item("inicio.accesos.personalizar"),
      item("inicio.indicador_uf.ver"),
      item("inicio.linkedin.ver"),
      item("perfil.acceso"),
      item("perfil.propio.editar"),
      item("perfil.cursos.ver"),
      item("noticias.acceso"),
      item("noticias.noticia.ver"),
      item("eventos.acceso"),
      item("eventos.evento.ver"),
      item("cursos.acceso"),
      item("cursos.curso.ver"),
      // Hoy el KPI de cursos (con correos) está abierto a todos: se copia
      // tal cual y queda en el reporte para revisarlo.
      item("cursos.avance.ver", TODO),
      item("cursos.avance.campo.email"),
      item("apps.acceso"),
      item("apps.app.ver"),
      item("casino.acceso"),
      item("casino.menu.ver"),
      item("procesos.acceso"),
      item("procesos.procedimientos.ver", MI_AREA),
      item("procesos.protocolos.ver", MI_AREA),
      item("procesos.reglamento.ver"),
      item("procesos.otros.ver"),
      item("rrhh.acceso"),
      item("rrhh.directorio.ver"),
      item("rrhh.portales.ver"),
      item("organigrama.acceso"),
      item("vacaciones.acceso"),
      item("vacaciones.solicitud.crear"),
      item("vacaciones.solicitud.ver", PROPIO),
      item("vacaciones.saldo.ver", PROPIO),
      item("vacaciones.calendario.ver", TODO),
      item("gastos.acceso"),
      item("gastos.solicitud.crear"),
      item("gastos.solicitud.ver", PROPIO),
      item("soporte.acceso"),
      item("soporte.ticket.crear"),
      item("soporte.ticket.ver", PROPIO),
      item("soporte.ticket.responder", PROPIO),
      item("asistente.acceso"),
    ],
  },
  {
    code: "editor_noticias",
    name: "Editor de noticias",
    description: "Publica, edita, destaca y envía noticias.",
    items: ["crear", "editar", "eliminar", "destacar", "enviar_correo"].map((a) => item(`noticias.noticia.${a}`)),
  },
  {
    code: "editor_eventos",
    name: "Editor de eventos",
    description: "Crea eventos y administra sus fotos y videos.",
    items: [
      item("eventos.evento.crear"),
      item("eventos.evento.editar"),
      item("eventos.evento.eliminar"),
      item("eventos.fotos.subir"),
      item("eventos.fotos.eliminar"),
    ],
  },
  {
    code: "editor_apps",
    name: "Editor de apps",
    description: "Administra el catálogo de apps.",
    items: ["crear", "editar", "eliminar", "ordenar", "notificar"].map((a) => item(`apps.app.${a}`)),
  },
  {
    code: "editor_cursos",
    name: "Editor de cursos",
    description: "Administra el material de los cursos.",
    items: ["crear", "editar", "eliminar"].map((a) => item(`cursos.material.${a}`)),
  },
  {
    code: "editor_casino",
    name: "Editor del casino",
    description: "Edita el menú de la semana.",
    items: [item("casino.menu.editar")],
  },
  {
    code: "editor_procesos",
    name: "Editor de procesos",
    description: "Ve, sube, renombra y elimina documentos en todas las carpetas.",
    items: [
      ...["procedimientos", "protocolos"].flatMap((s) =>
        ["ver", "subir", "editar", "eliminar"].map((a) => item(`procesos.${s}.${a}`, TODO)),
      ),
      ...["reglamento", "otros"].flatMap((s) =>
        ["subir", "editar", "eliminar"].map((a) => item(`procesos.${s}.${a}`)),
      ),
      item("procesos.sin_area.ver"),
      item("procesos.sin_area.administrar"),
    ],
  },
  {
    code: "conexion_linkedin",
    name: "Conexión de LinkedIn",
    description: "Conecta la cuenta de LinkedIn de la empresa al inicio.",
    items: [item("inicio.linkedin.configurar")],
  },
  {
    code: "lectura_tickets",
    name: "Lectura de todos los tickets",
    description: "Ve todos los tickets de Soporte sin gestionarlos (como hoy cualquier administrador).",
    items: [item("soporte.ticket.ver", TODO)],
  },
  {
    code: "gestion_personal",
    name: "Gestión de personal",
    description: "Colaboradores, organigrama, feriados y centros de costo.",
    items: [
      ...["ver", "editar", "eliminar", "activar", "enviar_clave"].map((a) => item(`rrhh.colaborador.${a}`, TODO)),
      item("rrhh.colaborador.crear"),
      item("rrhh.colaborador.campo.documento_identidad"),
      item("rrhh.colaborador.campo.datos_personales"),
      item("rrhh.directorio.campo.contacto_personal"),
      ...["crear", "editar", "eliminar", "designar_jefe", "editar_miembros"].map((a) => item(`organigrama.area.${a}`)),
      item("feriados.acceso"),
      item("feriados.feriado.ver"),
      item("feriados.feriado.administrar"),
      item("centros_costo.acceso"),
      item("centros_costo.centro.ver"),
      item("centros_costo.centro.administrar"),
      item("centros_costo.miembros.asignar"),
      item("centros_costo.centro.campo.documento_identidad"),
    ],
  },
  {
    code: "gestion_vacaciones",
    name: "Gestión de vacaciones",
    description: "Gestión, saldos, historial y reportes de vacaciones de toda la empresa (sin aprobar).",
    items: [
      item("vacaciones.solicitud.ver", TODO),
      item("vacaciones.saldo.ver", TODO),
      item("vacaciones.saldo.ajustar", TODO),
      item("vacaciones.historial.editar", TODO),
      item("vacaciones.periodo.cortar"),
      item("vacaciones.reporte.exportar"),
      item("vacaciones.configuracion.editar"),
    ],
  },
  {
    code: "jefatura",
    name: "Jefatura",
    description: "Ver y aprobar lo de las áreas a su cargo y las que cuelgan de ellas.",
    items: [
      item("vacaciones.solicitud.ver", A_CARGO),
      item("vacaciones.solicitud.aprobar", A_CARGO),
      item("vacaciones.saldo.ver", A_CARGO),
      item("gastos.solicitud.ver", A_CARGO),
      item("gastos.solicitud.aprobar_jefatura", A_CARGO),
      item("procesos.procedimientos.ver", A_CARGO),
      item("procesos.protocolos.ver", A_CARGO),
    ],
  },
  {
    code: "aprobador_finanzas",
    name: "Aprobador de finanzas",
    description: "Aprueba la etapa de Finanzas y liquida rendiciones de toda la empresa.",
    items: [
      item("gastos.solicitud.ver", TODO),
      item("gastos.solicitud.aprobar_finanzas", TODO),
      item("gastos.solicitud.liquidar", TODO),
      item("gastos.solicitud.exportar"),
      item("gastos.solicitud.campo.cuenta_bancaria"),
      item("gastos.solicitud.campo.documento_identidad"),
    ],
  },
  {
    code: "personal_finanzas",
    name: "Personal de finanzas",
    description: "Emite y administra letras de cambio.",
    items: [
      item("letras.acceso"),
      ...["ver", "crear", "editar", "eliminar", "marcar_pagada", "anular", "exportar_pdf"].map((a) => item(`letras.letra.${a}`)),
    ],
  },
  {
    code: "mesa_ayuda",
    name: "Mesa de ayuda",
    description: "Ve, responde y gestiona todos los tickets de Soporte.",
    items: [item("soporte.ticket.ver", TODO), item("soporte.ticket.responder", TODO), item("soporte.ticket.gestionar")],
  },
];

/** Diferencias deliberadas con hoy: van siempre en el reporte. */
const CAMBIOS = [
  "Un administrador cualquiera deja de ver y aprobar todas las rendiciones: la etapa de jefatura es de los jefes (a cargo) y la de Finanzas de quienes tienen «Aprobador de finanzas».",
  "Nadie aprueba ni liquida lo propio (ya vigente desde la fase 0).",
  "RRHH deja de aprobar vacaciones por encima del jefe: gestiona saldos y reportes; aprueban los jefes de la cadena.",
  "Los jefes alcanzan toda la cadena hacia abajo (antes sólo su área directa).",
  "La mesa de ayuda (Informática, cualquier rol) ve todos los tickets, no sólo quien tenía rol Administrador.",
  "La rendición de quien no tiene jefe por encima (p. ej. el jefe de Gerencia) la resuelve el superadmin hasta que se asigne otro aprobador; sus vacaciones se autoaprobarán (fase 9).",
  "Los jefes ven las carpetas de procedimientos y protocolos de las áreas a su cargo; hoy sólo ven la de su área de trabajo.",
  "El correo y el teléfono personales del directorio (hoy enmascarados para todos) quedan en quien tenga el permiso; el conjunto Básico no lo trae.",
];

function displayName(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(" ").trim() || `Usuario ${u.id}`;
}

/**
 * "Nombre Apellido" → usuarios. Primer nombre exacto y apellido por prefijo,
 * sin acentos ni espacios (mismo criterio que scripts/cargar-organigrama.js).
 */
function findUsersByName(users, fullName) {
  const sinEspacios = (v) => normalizeAreaName(v).replace(/\s+/g, "");
  const [first, ...rest] = String(fullName || "").trim().split(/\s+/);
  const n = normalizeAreaName(first);
  const a = sinEspacios(rest.join(" "));
  if (!n) return [];
  return users.filter((u) => {
    const primerNombre = normalizeAreaName(u.first_name).split(/\s+/)[0] || "";
    return primerNombre === n && sinEspacios(u.last_name).startsWith(a);
  });
}

/** Conjuntos con sólo los permisos que existen en el país; los vacíos no se crean. */
function setsForCountry(catalog) {
  return SYSTEM_SETS.map((set) => ({
    ...set,
    items: set.items
      .filter((i) => catalog.byKey.has(i.permission_key))
      .map((i) => ({ ...i, scope_area_ids: [], scope_include_subareas: false })),
  })).filter((set) => set.items.length > 0);
}

/**
 * Plan de arranque.
 *   users: [{ id, first_name, last_name, role, work_area_id, is_intranet_user }]
 *   areas: [{ id, area_name, parent_area_id, manager_user_id }]
 * Devuelve { sets, assignments, superadmins, problems, changes, warnings }.
 */
function planBootstrap({ country, catalog, users, areas, superadminName = "Bastián Sánchez" }) {
  const problems = [];
  const warnings = [];
  const sets = setsForCountry(catalog);
  const hasSet = new Set(sets.map((s) => s.code));

  const areaById = new Map(areas.map((a) => [Number(a.id), a]));
  const active = users.filter((u) => canLogin(normalizeRole(u.role)));
  const intranet = active.filter((u) => u.is_intranet_user !== false);

  const superadmins = findUsersByName(active, superadminName);
  if (superadmins.length === 0) problems.push(`No se encontró una cuenta activa de «${superadminName}» para superadmin.`);
  if (superadmins.length > 1) {
    problems.push(`«${superadminName}» calza con varias cuentas: ${superadmins.map((u) => `${displayName(u)} #${u.id}`).join(", ")}.`);
  }
  const superIds = new Set(superadmins.length === 1 ? [Number(superadmins[0].id)] : []);

  const assignments = [];
  const add = (setCode, principal, why) => {
    if (!hasSet.has(setCode)) return;
    if (principal.principal_type === "user" && superIds.has(Number(principal.user_id))) return;
    assignments.push({ include_subareas: false, area_id: null, user_id: null, ...principal, set_code: setCode, why });
  };
  const forUser = (u) => ({ principal_type: "user", user_id: Number(u.id), name: displayName(u) });

  // Global y jefes.
  add("basico", { principal_type: "global", name: "Todos" }, "toda cuenta activa");
  add("jefatura", { principal_type: "jefes", name: "Jefes de área" }, "ser jefe en el organigrama");

  // Perfiles de hoy, calculados con las mismas reglas que el código actual.
  const managedNames = (u) =>
    areas.filter((a) => Number(a.manager_user_id) === Number(u.id)).map((a) => a.area_name);
  const profileOf = (u) =>
    accessProfile(
      {
        role: u.role,
        area_name: u.work_area_id ? areaById.get(Number(u.work_area_id))?.area_name : null,
        managed_area_names: managedNames(u),
      },
      country,
    );
  const financeIds = financeAreaIds(areas);
  const inSupportArea = (u) => isSupportAreaName(areaById.get(Number(u.work_area_id))?.area_name);

  for (const u of intranet) {
    const admin = isAdministrador(normalizeRole(u.role));
    const profile = profileOf(u);
    if (admin) {
      for (const code of [
        "editor_noticias",
        "editor_eventos",
        "editor_apps",
        "editor_cursos",
        "editor_casino",
        "editor_procesos",
        "conexion_linkedin",
      ]) {
        add(code, forUser(u), "rol Administrador");
      }
      if (!inSupportArea(u)) add("lectura_tickets", forUser(u), "rol Administrador (veía todos los tickets)");
    }
    if (profile.canManageRrhh) {
      const why = profile.informaticaAdmin ? "administrador de Informática" : "gestiona RRHH";
      add("gestion_personal", forUser(u), why);
      add("gestion_vacaciones", forUser(u), why);
    }
    if (profile.informaticaAdmin) {
      add("aprobador_finanzas", forUser(u), "administrador de Informática");
      add("personal_finanzas", forUser(u), "administrador de Informática");
    } else if (admin && financeIds.has(Number(u.work_area_id))) {
      add("aprobador_finanzas", forUser(u), "administrador de Finanzas");
    }
  }

  // Áreas: Finanzas (con sus subáreas) y la mesa de ayuda.
  for (const area of areas.filter((a) => isFinanceAreaName(a.area_name))) {
    add(
      "personal_finanzas",
      { principal_type: "area", area_id: Number(area.id), include_subareas: true, name: `${area.area_name} y sus subáreas` },
      "personal de Finanzas",
    );
  }
  for (const area of areas.filter((a) => isSupportAreaName(a.area_name))) {
    add("mesa_ayuda", { principal_type: "area", area_id: Number(area.id), name: area.area_name }, "área de Informática");
  }

  if (catalog.byKey.has("soporte.ticket.gestionar") && !areas.some((a) => isSupportAreaName(a.area_name))) {
    warnings.push("No hay un área de Informática: nadie quedará en la mesa de ayuda.");
  }
  if (!assignments.some((a) => a.set_code === "gestion_personal")) {
    warnings.push("Nadie gestiona RRHH hoy: sólo el superadmin podrá administrar personas.");
  }
  if (catalog.byKey.has("gastos.solicitud.aprobar_finanzas") && !assignments.some((a) => a.set_code === "aprobador_finanzas")) {
    warnings.push("Nadie aprueba la etapa de Finanzas: sólo el superadmin podrá hacerlo.");
  }
  if (catalog.byKey.has("cursos.avance.campo.email")) {
    warnings.push("El KPI de cursos (con correos) queda abierto a todos, como hoy: revisa si debe ser así.");
  }

  return { sets, assignments, superadmins, problems, warnings, changes: [...CAMBIOS] };
}

module.exports = {
  SYSTEM_SETS,
  CAMBIOS,
  findUsersByName,
  setsForCountry,
  planBootstrap,
};
