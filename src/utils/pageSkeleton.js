/**
 * Qué esqueleto muestra el velo de carga según la ruta (partials/skeleton-pagina).
 * Lo que no calza aquí usa "contenido", que sirve para fichas y formularios.
 */
const REGLAS = [
  ["inicio", /^\/$/],
  [
    "tabla",
    /^\/(rrhh\/(personal|centros-costo|feriados|vacaciones\/(gestion(\/resumen)?|aprobaciones))|permisos\/(usuarios|auditoria|modulos|conjuntos)|gastos(\/gestion)?|letras|soporte(\/tickets)?|procesos\/[^/]+\/[^/]+)$/,
  ],
  [
    "tarjetas",
    /^\/(noticias|marketing(\/eventos)?|apps|cursos(\/(equipamiento-activo|fibra-optica|infraestructura|safety-machine))?|procesos(\/[^/]+)?|rrhh|permisos)$/,
  ],
];

function pageSkeletonFor(ruta) {
  // Express no distingue mayúsculas en las rutas: /RRHH y /rrhh son la misma.
  const limpia = String(ruta || "/").toLowerCase().replace(/(.)\/+$/, "$1");
  const regla = REGLAS.find(([, patron]) => patron.test(limpia));
  return regla ? regla[0] : "contenido";
}

module.exports = { pageSkeletonFor };
