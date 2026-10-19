const express = require("express");
const path = require("path");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const fileStorage = require("../services/fileStorage");
const { isAdministrador, normalizeRole } = require("../constants/roles");
const {
  puedeVerCarpeta,
  puedeSubir,
  puedeAdministrarDocumento,
  veListadoDeCarpetas,
} = require("../services/documents/processAccess");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const { areaSlug, enrichAreaWithPill } = require("../constants/workAreas");
const { isFeatureEnabled } = require("../config/features");
const { withQueryParam } = require("../utils/returnTo");
const { folderForUpload, SLUG_SIN_AREA } = require("../services/documents/processDocumentStorage");
const areaManager = require("../services/expenses/areaManager");
const financeTeam = require("../services/expenses/financeTeam");
const expenses = require("../services/expenses/expenseRequestService");
const funds = require("../services/expenses/expenseFundService");

/**
 * Procesos y Documentos.
 *
 * Las carpetas de procedimientos y protocolos cuelgan de work_areas
 * (documents.work_area_id + doc_kind). Antes eran una lista hardcodeada de
 * slugs que no tenía relación con las áreas reales: crear un área no le daba
 * carpeta y la mitad de las carpetas no correspondían a ningún área.
 *
 * `documents.type` sigue escribiéndose por compatibilidad con las filas
 * históricas, pero ya no se lee para navegar.
 *
 * Las subidas nuevas van a Storage (`/content/documentos/...`). Las filas
 * heredadas de Cloudinary se migran con scripts/migrate-cloudinary-process-docs.js.
 */

// Secciones que viven en `documents` con carpeta por área.
const SECCIONES_AREA = {
  procedimientos: "procedimiento",
  protocolos: "protocolo",
};

const SECCION_LABEL = {
  procedimientos: "Procedimientos",
  protocolos: "Protocolos",
};

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMITS_BYTES.PROCESS_DOCUMENT },
});

function getFileExtension(url, nombre) {
  const source = url || nombre || "";
  const clean = String(source).split("?")[0].split("#")[0];
  const ext = path.extname(clean).replace(".", "").toLowerCase();
  if (ext) return ext;
  const match = clean.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : "";
}

function mapDocumentoRow(row) {
  return {
    id: row.id,
    url: row.url,
    name: row.name,
    public_id: row.public_id,
    format: getFileExtension(row.url, row.name),
  };
}

function esAdmin(user) {
  return !!user && isAdministrador(normalizeRole(user.role));
}

function negarAccion(req, res) {
  const accept = req.headers.accept || "";
  const json = req.xhr || accept.includes("application/json") || /\/(upload|subir)(\/|$)/.test(req.path)
    || String(req.get("Content-Type") || "").includes("application/json");
  if (json) return res.status(403).json({ error: "No tienes permiso para esta acción." });
  return res.status(403).render("acceso_no_permitido", { titulo: "Acceso no permitido" });
}

/** Área de destino de una subida a carpeta. null si la sección no es de área. */
async function areaDeSubida(seccion, area) {
  if (seccion !== "procedimientos" && seccion !== "protocolos") return { areaId: null };
  const resolved = await resolverArea(area);
  return resolved ? { areaId: resolved.area.id, resolved } : { areaId: null, missing: true };
}

// ==========================================
// 1. PORTADA: Finanzas / Documentos generales / Mi área
// ==========================================

router.get("/", async (req, res) => {
  const user = req.session.user;
  const admin = esAdmin(user);

  try {
    const context = await areaManager.getUserAreaContext(user.id);

    // Las rendiciones pueden estar apagadas; la sección de Finanzas desaparece
    // entera en ese caso en vez de mostrar botones muertos.
    const gastosActivos = isFeatureEnabled("expenseRequests");
    let esRevisor = false;
    let pendientes = 0;
    let fondosVencidos = 0;
    let sinRendir = 0;

    if (gastosActivos) {
      const esFinanzas = admin || (await financeTeam.isFinanceApprover(user));
      esRevisor = esFinanzas || (await areaManager.isAreaManager(user));
      const [resumenFondos, pendientesCount, vencidosFinanzas] = await Promise.all([
        funds.getFundSummary(user.id),
        esRevisor ? expenses.countPendingForReviewer(user) : Promise.resolve(0),
        esFinanzas ? funds.countOverdueFunds() : Promise.resolve(0),
      ]);
      pendientes = pendientesCount;
      fondosVencidos = resumenFondos.vencidos || 0;
      sinRendir = vencidosFinanzas;
    }

    // Conteos de la carpeta propia: el colaborador entra directo a su área, así
    // que la tarjeta ya le dice cuántos documentos va a encontrar.
    let conteosArea = { procedimiento: 0, protocolo: 0 };
    if (context.area) {
      const { rows } = await db.query(
        `SELECT doc_kind, COUNT(*)::int AS n
           FROM documents
          WHERE work_area_id = $1 AND doc_kind IS NOT NULL
          GROUP BY doc_kind`,
        [context.area.id],
      );
      for (const row of rows) conteosArea[row.doc_kind] = row.n;
    }

    res.render("procesos/index", {
      titulo: "Procesos y documentos",
      areaContext: context,
      conteosArea,
      gastosActivos,
      esRevisor,
      pendientes,
      fondosVencidos,
      sinRendir,
      user,
      extraCss: ["/css/procesos.css?v=20260916m"],
    });
  } catch (err) {
    console.error("[Procesos] Error cargando la portada:", err);
    res.status(500).send("Error cargando Procesos y Documentos");
  }
});

// ==========================================
// 2. LISTADO DE CARPETAS POR ÁREA (solo administradores)
// ==========================================

async function renderCarpetas(req, res, seccion) {
  const docKind = SECCIONES_AREA[seccion];
  const user = req.session.user;

  // Quien sólo ve su carpeta entra directo, como hoy. El listado (admin, y al
  // aplicar un jefe con varias áreas) muestra únicamente las que pasan.
  if (!veListadoDeCarpetas(req.perms, req.permLegacy)) {
    const context = await areaManager.getUserAreaContext(user.id);
    if (!context.area) {
      return res.redirect(
        `/procesos?error=${encodeURIComponent(
          "No tienes un área asignada. Pídele a RRHH que te asigne una.",
        )}`,
      );
    }
    return res.redirect(`/procesos/${seccion}/${context.area.id}`);
  }

  // Una sola consulta agregada: antes era un Promise.all con una query por área.
  const [areasResult, huerfanosResult] = await Promise.all([
    db.query(
      `SELECT w.id, w.area_name, w.color, COUNT(d.id)::int AS cantidad
         FROM work_areas w
         LEFT JOIN documents d
           ON d.work_area_id = w.id AND d.doc_kind = $1
        GROUP BY w.id, w.area_name, w.color
        ORDER BY w.area_name ASC`,
      [docKind],
    ),
    db.query(
      `SELECT COUNT(*)::int AS n
         FROM documents
        WHERE work_area_id IS NULL AND doc_kind = $1`,
      [docKind],
    ),
  ]);

  const veSinArea = puedeVerCarpeta(req.perms, req.permLegacy, seccion, null, req.originalUrl);
  const areas = areasResult.rows
    .filter((area) => puedeVerCarpeta(req.perms, req.permLegacy, seccion, area.id, req.originalUrl))
    .map(enrichAreaWithPill);

  res.render("procesos/menu_carpetas", {
    titulo: SECCION_LABEL[seccion],
    seccionBase: seccion,
    areas,
    // Documentos de slugs legacy que no correspondían a ningún área existente.
    // Se muestran para que nadie los dé por perdidos, no para navegarlos a diario.
    huerfanos: veSinArea ? huerfanosResult.rows[0].n : 0,
    slugSinArea: SLUG_SIN_AREA,
    user,
    extraCss: ["/css/procesos.css?v=20260916m"],
  });
}

router.get("/procedimientos", async (req, res) => {
  try {
    await renderCarpetas(req, res, "procedimientos");
  } catch (err) {
    console.error("[Procesos] Error cargando carpetas:", err);
    res.status(500).send("Error cargando carpetas");
  }
});

router.get("/protocolos", async (req, res) => {
  try {
    await renderCarpetas(req, res, "protocolos");
  } catch (err) {
    console.error("[Procesos] Error cargando carpetas:", err);
    res.status(500).send("Error cargando carpetas");
  }
});

// ==========================================
// 3. SECCIONES GENERALES
// ==========================================

async function renderGeneral(req, res, { seccion, titulo, sql, params }) {
  const { rows } = await db.query(sql, params);

  res.render("procesos/vista_archivos", {
    titulo,
    tituloSeccion: titulo,
    tituloArea: null,
    seccionBase: seccion,
    slugArea: "general",
    areaColor: null,
    archivos: rows.map(mapDocumentoRow),
    user: req.session.user,
    extraCss: ["/css/procesos.css?v=20260916m"],
  });
}

router.get("/reglamento", async (req, res) => {
  try {
    await renderGeneral(req, res, {
      seccion: "reglamento",
      titulo: "Reglamento interno",
      sql: "SELECT * FROM documents WHERE type = 'reglamento' ORDER BY created_at DESC",
      params: [],
    });
  } catch (err) {
    console.error("[Procesos] Error cargando el reglamento:", err);
    res.status(500).send("Error");
  }
});

router.get("/otros", async (req, res) => {
  try {
    await renderGeneral(req, res, {
      seccion: "otros",
      titulo: "Otros documentos",
      sql: "SELECT * FROM other_documents ORDER BY created_at DESC",
      params: [],
    });
  } catch (err) {
    console.error("[Procesos] Error cargando otros documentos:", err);
    res.status(500).send("Error");
  }
});

// ==========================================
// 4. VISTA DE ARCHIVOS DE UN ÁREA
// ==========================================

/**
 * Resuelve el parámetro :area, que ahora es el id de 4 dígitos de work_areas.
 * Un valor no numérico es un enlace histórico ('logistica', y también los
 * link_path guardados en change_log): se resuelve por slug y se redirige, para
 * no romper nada de lo ya publicado.
 */
async function resolverArea(rawArea) {
  const id = Number(rawArea);
  if (Number.isInteger(id) && id > 0) {
    const { rows } = await db.query(
      "SELECT id, area_name, color FROM work_areas WHERE id = $1",
      [id],
    );
    return rows.length ? { area: rows[0], redirect: false } : null;
  }

  const slug = areaSlug(rawArea);
  if (!slug) return null;

  const { rows } = await db.query("SELECT id, area_name, color FROM work_areas");
  const match = rows.find((row) => areaSlug(row.area_name) === slug);
  return match ? { area: match, redirect: true } : null;
}

router.get("/:seccion/:area", async (req, res) => {
  const { seccion, area } = req.params;
  const docKind = SECCIONES_AREA[seccion];
  if (!docKind) return res.redirect("/procesos");

  try {
    const user = req.session.user;

    // Carpeta de huérfanos: sólo quien ve documentos sin área. Se puede borrar
    // o renombrar; no se sube nada nuevo aquí.
    if (area === SLUG_SIN_AREA) {
      if (!puedeVerCarpeta(req.perms, req.permLegacy, seccion, null, req.originalUrl)) {
        return res.redirect(`/procesos/${seccion}`);
      }
      const { rows } = await db.query(
        `SELECT * FROM documents
          WHERE work_area_id IS NULL AND doc_kind = $1
          ORDER BY created_at DESC`,
        [docKind],
      );
      return res.render("procesos/vista_archivos", {
        titulo: `${SECCION_LABEL[seccion]}: sin área`,
        tituloSeccion: SECCION_LABEL[seccion],
        tituloArea: "Sin área",
        seccionBase: seccion,
        slugArea: SLUG_SIN_AREA,
        areaColor: null,
        archivos: rows.map(mapDocumentoRow),
        user,
        avisoHuerfanos: true,
        extraCss: ["/css/procesos.css?v=20260916m"],
      });
    }

    const resolved = await resolverArea(area);
    if (!resolved) return res.redirect(`/procesos/${seccion}`);
    if (resolved.redirect) {
      return res.redirect(302, `/procesos/${seccion}/${resolved.area.id}`);
    }

    if (!puedeVerCarpeta(req.perms, req.permLegacy, seccion, resolved.area.id, req.originalUrl)) {
      return res
        .status(403)
        .render("acceso_no_permitido", { titulo: "Acceso no permitido" });
    }

    const { rows } = await db.query(
      `SELECT * FROM documents
        WHERE work_area_id = $1 AND doc_kind = $2
        ORDER BY created_at DESC`,
      [resolved.area.id, docKind],
    );

    res.render("procesos/vista_archivos", {
      titulo: `${SECCION_LABEL[seccion]}: ${resolved.area.area_name}`,
      tituloSeccion: SECCION_LABEL[seccion],
      tituloArea: resolved.area.area_name,
      seccionBase: seccion,
      slugArea: String(resolved.area.id),
      areaColor: enrichAreaWithPill(resolved.area).color,
      archivos: rows.map(mapDocumentoRow),
      user,
      extraCss: ["/css/procesos.css?v=20260916m"],
    });
  } catch (err) {
    console.error("[Procesos] Error cargando documentos:", err);
    res.status(500).send("Error cargando documentos");
  }
});

// ==========================================
// 5. SUBIDA (dos pasos: storage y luego base de datos)
// ==========================================

async function exigirSubida(req, res, next) {
  try {
    const { seccion, area } = req.params;
    if (seccion !== "reglamento" && seccion !== "otros" && !SECCIONES_AREA[seccion]) {
      return res.status(400).json({ error: "Sección inválida" });
    }
    let areaId = null;
    if (SECCIONES_AREA[seccion]) {
      const destino = await areaDeSubida(seccion, area);
      // En sombra un administrador puede subir aunque el área no resuelva
      // (la ruta no lo comprobaba). Al aplicar, sin área no hay carpeta.
      if (destino.missing && req.perms && req.perms.mode === "aplicar") {
        return res.status(400).json({ error: "El área no existe" });
      }
      areaId = destino.areaId;
    }
    if (!puedeSubir(req.perms, req.permLegacy, seccion, areaId, req.originalUrl)) {
      return negarAccion(req, res);
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

router.post(
  "/:seccion/:area/upload",
  exigirSubida,
  upload.single("archivo"),
  async (req, res) => {
    const { seccion, area } = req.params;

    try {
      if (!req.file) return res.status(400).json({ error: "No se subió archivo" });
      if (!fileStorage.validateFileSize(req.file.buffer, 20)) {
        return res.status(400).json({ error: "El archivo excede el límite de 20 MB" });
      }

      const folder = folderForUpload(seccion, area);
      const result = await fileStorage.saveFile(
        req.file.buffer,
        folder,
        req.file.originalname,
      );

      res.json({
        secure_url: result.secure_url,
        public_id: result.public_id,
        url: result.url,
        fileName: result.fileName,
      });
    } catch (err) {
      console.error("[Procesos] Error de subida a Storage:", err);
      res.status(500).json({ error: err.message || "Error al subir el archivo" });
    }
  },
);

router.post("/:seccion/:area/subir", exigirSubida, async (req, res) => {
  const { seccion, area } = req.params;
  const { nombre_archivo, secure_url, public_id } = req.body;

  try {
    if (!secure_url || !public_id) {
      return res.status(400).json({ error: "Faltan datos del archivo subido" });
    }

    let textoHistorial = SECCION_LABEL[seccion] || seccion;
    let urlHistorial = `/procesos/${seccion}/${area}`;

    if (seccion === "otros") {
      await db.query(
        "INSERT INTO other_documents (name, url, public_id) VALUES ($1, $2, $3)",
        [nombre_archivo || "Documento", secure_url, public_id],
      );
      textoHistorial = "Otros documentos";
      urlHistorial = "/procesos/otros";
    } else if (seccion === "reglamento") {
      await db.query(
        `INSERT INTO documents (name, type, url, public_id, user_id)
         VALUES ($1, 'reglamento', $2, $3, $4)`,
        [nombre_archivo || "Documento", secure_url, public_id, req.session.user.id],
      );
      textoHistorial = "Reglamento interno";
      urlHistorial = "/procesos/reglamento";
    } else {
      const docKind = SECCIONES_AREA[seccion];
      if (!docKind) return res.status(400).json({ error: "Sección inválida" });

      const resolved = await resolverArea(area);
      if (!resolved) return res.status(400).json({ error: "El área no existe" });

      // `type` se sigue escribiendo por compatibilidad con las filas históricas
      // y con los informes que lo consultan; la navegación usa work_area_id.
      await db.query(
        `INSERT INTO documents (name, type, url, public_id, user_id, work_area_id, doc_kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          nombre_archivo || "Documento",
          `${docKind}_${areaSlug(resolved.area.area_name)}`,
          secure_url,
          public_id,
          req.session.user.id,
          resolved.area.id,
          docKind,
        ],
      );
      textoHistorial = `${SECCION_LABEL[seccion]} · ${resolved.area.area_name}`;
      urlHistorial = `/procesos/${seccion}/${resolved.area.id}`;
    }

    await db.query(
      "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
      [req.session.user.id, "subió un documento", textoHistorial, urlHistorial],
    );

    res.json({ ok: true });
  } catch (err) {
    console.error("[Procesos] Error guardando documento:", err);
    res.status(500).json({ error: err.message || "Error al guardar en la base de datos" });
  }
});

// ==========================================
// 6. EDITAR Y ELIMINAR
// ==========================================

async function cargarDocumento(seccionBase, id) {
  // La tabla sí sale del formulario: documents y other_documents no comparten
  // id. La sección del permiso sale de la fila (doc_kind / type), no de aquí.
  if (seccionBase === "otros") {
    const { rows } = await db.query("SELECT id, public_id FROM other_documents WHERE id = $1", [id]);
    return rows[0] ? { ...rows[0], tabla: "other_documents" } : null;
  }
  const { rows } = await db.query(
    "SELECT id, public_id, work_area_id, doc_kind, type FROM documents WHERE id = $1",
    [id],
  );
  return rows[0] ? { ...rows[0], tabla: "documents" } : null;
}

router.post("/documento/editar", async (req, res) => {
  const { id, nuevo_nombre, return_to, seccion_base } = req.body;
  const destino = safeReturnTo(return_to);
  try {
    const tabla = seccion_base === "otros" ? "other_documents" : "documents";
    const row = await cargarDocumento(seccion_base, id);
    if (row && !puedeAdministrarDocumento(req.perms, req.permLegacy, row, "editar", req.originalUrl)) {
      return negarAccion(req, res);
    }
    if (row) {
      await db.query(`UPDATE ${tabla} SET name = $1 WHERE id = $2`, [nuevo_nombre, row.id]);
    }
    res.redirect(withQueryParam(destino, "ok", "Documento renombrado"));
  } catch (err) {
    console.error("[Procesos] Error editando documento:", err);
    res.redirect(withQueryParam(destino, "error", "No se pudo renombrar el documento"));
  }
});

router.post("/eliminar", async (req, res) => {
  const { db_id, return_to, seccion_base } = req.body;
  const destino = safeReturnTo(return_to);
  try {
    // El archivo que se borra es el de la fila, no el que diga el formulario:
    // un public_id editado a mano no puede tocar otra parte del bucket.
    const tabla = seccion_base === "otros" ? "other_documents" : "documents";
    const row = await cargarDocumento(seccion_base, db_id);
    if (!row) {
      return res.redirect(withQueryParam(destino, "error", "El documento ya no existe"));
    }
    if (!puedeAdministrarDocumento(req.perms, req.permLegacy, row, "eliminar", req.originalUrl)) {
      return negarAccion(req, res);
    }
    const { rows } = await db.query(`DELETE FROM ${tabla} WHERE id = $1 RETURNING public_id`, [row.id]);
    if (!rows.length) {
      return res.redirect(withQueryParam(destino, "error", "El documento ya no existe"));
    }
    const stored = fileStorage.resolveStoredPath(rows[0].public_id);
    if (stored.startsWith("documentos/")) await fileStorage.deleteFile(stored);

    await db.query(
      "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
      [req.session.user.id, "eliminó un documento", seccion_base || "Procesos", destino],
    );

    res.redirect(withQueryParam(destino, "ok", "Documento eliminado"));
  } catch (err) {
    console.error("[Procesos] Error eliminando documento:", err);
    res.redirect(withQueryParam(destino, "error", "No se pudo eliminar el documento"));
  }
});

/** El return_to viene de un form: se acota a rutas internas de /procesos. */
function safeReturnTo(value) {
  const raw = String(value || "");
  return /^\/procesos(\/|$)/.test(raw) ? raw : "/procesos";
}

module.exports = router;
