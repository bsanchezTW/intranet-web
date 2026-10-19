const { decide } = require("../permissions/decide");
const { seccionForDocumentRow } = require("./processDocumentStorage");

/**
 * Decisiones de Procesos (carpetas y documentos) vía decide().
 * En modo sombra responde la regla antigua; las claves van literales para
 * que el test de cobertura las vea.
 */

function puedeVerCarpeta(perms, legacyCtx, seccion, areaId, path = null) {
  if (seccion === "reglamento") return decide(perms, "procesos.reglamento.ver", legacyCtx, { path });
  if (seccion === "otros") return decide(perms, "procesos.otros.ver", legacyCtx, { path });
  if (areaId == null) return decide(perms, "procesos.sin_area.ver", legacyCtx, { path });
  const record = { areaId };
  if (seccion === "protocolos") {
    return decide(perms, "procesos.protocolos.ver", legacyCtx, { record, path });
  }
  return decide(perms, "procesos.procedimientos.ver", legacyCtx, { record, path });
}

function puedeSubir(perms, legacyCtx, seccion, areaId, path = null) {
  const record = areaId == null ? null : { areaId };
  if (seccion === "reglamento") return decide(perms, "procesos.reglamento.subir", legacyCtx, { path });
  if (seccion === "otros") return decide(perms, "procesos.otros.subir", legacyCtx, { path });
  if (seccion === "protocolos") {
    return decide(perms, "procesos.protocolos.subir", legacyCtx, { record, path });
  }
  if (seccion === "procedimientos") {
    return decide(perms, "procesos.procedimientos.subir", legacyCtx, { record, path });
  }
  return false;
}

/**
 * Clave para renombrar o eliminar, a partir de la fila (nunca del formulario).
 * `accion` es "editar" o "eliminar". Reglamento y otros no tienen carpeta:
 * work_area_id null no los vuelve "sin área".
 */
function claveAdministrarDocumento(row, accion) {
  const editar = accion !== "eliminar";
  if (!row || row.tabla === "other_documents") {
    return { key: editar ? "procesos.otros.editar" : "procesos.otros.eliminar", areaId: null };
  }
  const seccion = seccionForDocumentRow(row);
  if (seccion === "procedimientos" || seccion === "protocolos") {
    if (row.work_area_id == null) return { key: "procesos.sin_area.administrar", areaId: null };
    if (seccion === "protocolos") {
      return { key: editar ? "procesos.protocolos.editar" : "procesos.protocolos.eliminar", areaId: row.work_area_id };
    }
    return { key: editar ? "procesos.procedimientos.editar" : "procesos.procedimientos.eliminar", areaId: row.work_area_id };
  }
  if (seccion === "reglamento") {
    return { key: editar ? "procesos.reglamento.editar" : "procesos.reglamento.eliminar", areaId: null };
  }
  return { key: editar ? "procesos.otros.editar" : "procesos.otros.eliminar", areaId: null };
}

function puedeAdministrarDocumento(perms, legacyCtx, row, accion, path = null) {
  const { key, areaId } = claveAdministrarDocumento(row, accion);
  const record = areaId == null ? null : { areaId };
  if (key === "procesos.sin_area.administrar") {
    return decide(perms, "procesos.sin_area.administrar", legacyCtx, { path });
  }
  if (key === "procesos.protocolos.editar") return decide(perms, "procesos.protocolos.editar", legacyCtx, { record, path });
  if (key === "procesos.protocolos.eliminar") return decide(perms, "procesos.protocolos.eliminar", legacyCtx, { record, path });
  if (key === "procesos.procedimientos.editar") return decide(perms, "procesos.procedimientos.editar", legacyCtx, { record, path });
  if (key === "procesos.procedimientos.eliminar") return decide(perms, "procesos.procedimientos.eliminar", legacyCtx, { record, path });
  if (key === "procesos.reglamento.editar") return decide(perms, "procesos.reglamento.editar", legacyCtx, { path });
  if (key === "procesos.reglamento.eliminar") return decide(perms, "procesos.reglamento.eliminar", legacyCtx, { path });
  if (key === "procesos.otros.editar") return decide(perms, "procesos.otros.editar", legacyCtx, { path });
  return decide(perms, "procesos.otros.eliminar", legacyCtx, { path });
}

/**
 * ¿Ve el listado de carpetas, o entra directo a la suya?
 * En sombra es lo de hoy: sólo el administrador ve el listado. Al aplicar,
 * también quien alcanza carpetas que no son la suya (un jefe, el editor).
 */
function veListadoDeCarpetas(perms, legacyCtx) {
  if (!perms) return false;
  if (decide(perms, "procesos.sin_area.ver", legacyCtx)) return true;
  if (perms.mode !== "aplicar" || typeof perms.coverage !== "function") return false;
  const cob = perms.coverage("procesos.procedimientos.ver");
  if (!cob) return false;
  if (cob.all) return true;
  const propia = legacyCtx && legacyCtx.workAreaId != null ? Number(legacyCtx.workAreaId) : null;
  return cob.areaIds.some((id) => Number(id) !== propia);
}

/**
 * Documento que el asistente o /content ya resolvió a una fila (o a la
 * carpeta de la URL, si no hay fila). `section` es la de la ruta.
 */
function puedeVerDocumento(perms, legacyCtx, { section, folder, row } = {}, path = null) {
  if (section === "reglamento" || section === "otros") {
    return section === "otros"
      ? decide(perms, "procesos.otros.ver", legacyCtx, { path })
      : decide(perms, "procesos.reglamento.ver", legacyCtx, { path });
  }
  const fuente = row || {};
  // Sin doc_kind ni type se respeta la carpeta de la URL: no abrir el archivo
  // a todos por caer en "otros".
  const seccion = row && (row.doc_kind || row.type) ? seccionForDocumentRow(row) : section;
  if (seccion === "reglamento") return decide(perms, "procesos.reglamento.ver", legacyCtx, { path });
  if (seccion === "otros") return decide(perms, "procesos.otros.ver", legacyCtx, { path });
  const areaId = row ? fuente.work_area_id : folder;
  if (areaId == null || areaId === "" || String(areaId) === "sin-area") {
    return decide(perms, "procesos.sin_area.ver", legacyCtx, { path });
  }
  if (String(areaId) === "general") {
    return seccion === "protocolos"
      ? decide(perms, "procesos.protocolos.ver", legacyCtx, { path })
      : decide(perms, "procesos.procedimientos.ver", legacyCtx, { path });
  }
  return puedeVerCarpeta(perms, legacyCtx, seccion === "protocolos" ? "protocolos" : "procedimientos", areaId, path);
}

/** Fila del buscador del asistente (documents u other_documents). */
function puedeVerDocumentoBusqueda(perms, legacyCtx, row, path = null) {
  if (!row) return false;
  if (row.type === "otros") return decide(perms, "procesos.otros.ver", legacyCtx, { path });
  return puedeVerDocumento(perms, legacyCtx, { section: null, row }, path);
}

module.exports = {
  puedeVerCarpeta,
  puedeSubir,
  claveAdministrarDocumento,
  puedeAdministrarDocumento,
  veListadoDeCarpetas,
  puedeVerDocumento,
  puedeVerDocumentoBusqueda,
};
