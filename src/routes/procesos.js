const express = require("express");
const path = require("path");
const router = express.Router();
const db = require("../db");
const multer = require("multer");
const fileStorage = require("../services/fileStorage");
const requireRole = require("../middlewares/requireRole");
const { isAdministrador, normalizeRole } = require("../constants/roles");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const { areaSlug, enrichAreaWithPill } = require("../constants/workAreas");
const { isFeatureEnabled } = require("../config/features");
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

/** Carpeta de los documentos legacy cuyo slug no correspondía a ningún área. */
const SLUG_SIN_AREA = "sin-area";

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

function getPermissions(user) {
  const admin = user ? isAdministrador(user.role) : false;
  return { can_upload: admin, can_edit: admin, can_delete: admin };
}

function esAdmin(user) {
  return !!user && isAdministrador(normalizeRole(user.role));
}

// ==========================================
// 1. PORTADA: Finanzas / Documentos generales / Mi área
// ==========================================

router.get("/", async (req, res) => {
  const user = req.session.user;
  const admin = esAdmin(user);

  try {
    const context = await areaManager.getUserAreaContext(user.id);

    // El centro de gastos puede estar apagado por país; la sección de Finanzas
    // desaparece entera en ese caso en vez de mostrar botones muertos.
    const gastosActivos = isFeatureEnabled("expenseCenter");
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
      titulo: "Procesos y Documentos",
      esAdmin: admin,
      areaContext: context,
      conteosArea,
      gastosActivos,
      esRevisor,
      pendientes,
      fondosVencidos,
      sinRendir,
      user,
      extraCss: ["/css/procesos.css"],
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

  // El colaborador no navega carpetas ajenas: entra directo a la suya.
  if (!esAdmin(user)) {
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

  res.render("procesos/menu_carpetas", {
    titulo: SECCION_LABEL[seccion],
    seccionBase: seccion,
    areas: areasResult.rows.map(enrichAreaWithPill),
    // Documentos de slugs legacy que no correspondían a ningún área existente.
    // Se muestran para que nadie los dé por perdidos, no para navegarlos a diario.
    huerfanos: huerfanosResult.rows[0].n,
    slugSinArea: SLUG_SIN_AREA,
    user,
    extraCss: ["/css/procesos.css"],
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
  const permisos = getPermissions(req.session.user);

  res.render("procesos/vista_archivos", {
    titulo,
    tituloSeccion: titulo,
    tituloArea: null,
    seccionBase: seccion,
    slugArea: "general",
    areaColor: null,
    archivos: rows.map(mapDocumentoRow),
    user: req.session.user,
    permisos,
    can: { [`${seccion}_write`]: permisos.can_upload },
    extraCss: ["/css/procesos.css"],
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
    const admin = esAdmin(user);

    // Carpeta de huérfanos: sólo para administradores, sólo de lectura.
    if (area === SLUG_SIN_AREA) {
      if (!admin) return res.redirect(`/procesos/${seccion}`);
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
        permisos: { ...getPermissions(user), can_upload: false },
        can: { [`${seccion}_write`]: false },
        avisoHuerfanos: true,
        extraCss: ["/css/procesos.css"],
      });
    }

    const resolved = await resolverArea(area);
    if (!resolved) return res.redirect(`/procesos/${seccion}`);
    if (resolved.redirect) {
      return res.redirect(302, `/procesos/${seccion}/${resolved.area.id}`);
    }

    // Un colaborador sólo abre la carpeta de su propia área.
    if (!admin) {
      const context = await areaManager.getUserAreaContext(user.id);
      if (!context.area || Number(context.area.id) !== Number(resolved.area.id)) {
        return res
          .status(403)
          .render("acceso_no_permitido", { titulo: "Acceso no permitido" });
      }
    }

    const { rows } = await db.query(
      `SELECT * FROM documents
        WHERE work_area_id = $1 AND doc_kind = $2
        ORDER BY created_at DESC`,
      [resolved.area.id, docKind],
    );

    const permisos = getPermissions(user);

    res.render("procesos/vista_archivos", {
      titulo: `${SECCION_LABEL[seccion]}: ${resolved.area.area_name}`,
      tituloSeccion: SECCION_LABEL[seccion],
      tituloArea: resolved.area.area_name,
      seccionBase: seccion,
      slugArea: String(resolved.area.id),
      areaColor: enrichAreaWithPill(resolved.area).color,
      archivos: rows.map(mapDocumentoRow),
      user,
      permisos,
      can: { [`${seccion}_write`]: permisos.can_upload },
      extraCss: ["/css/procesos.css"],
    });
  } catch (err) {
    console.error("[Procesos] Error cargando documentos:", err);
    res.status(500).send("Error cargando documentos");
  }
});

// ==========================================
// 5. SUBIDA (dos pasos: storage y luego base de datos)
// ==========================================

router.post(
  "/:seccion/:area/upload",
  requireRole.administrador(),
  upload.single("archivo"),
  async (req, res) => {
    const { seccion, area } = req.params;

    try {
      if (!req.file) return res.status(400).json({ error: "No se subió archivo" });
      if (!fileStorage.validateFileSize(req.file.buffer, 20)) {
        return res.status(400).json({ error: "El archivo excede el límite de 20 MB" });
      }

      const folder = `documentos/${seccion}/${area}`;
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

router.post("/:seccion/:area/subir", requireRole.administrador(), async (req, res) => {
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

router.post("/documento/editar", requireRole.administrador(), async (req, res) => {
  const { id, nuevo_nombre, return_to, seccion_base } = req.body;
  const destino = safeReturnTo(return_to);
  try {
    const tabla = seccion_base === "otros" ? "other_documents" : "documents";
    await db.query(`UPDATE ${tabla} SET name = $1 WHERE id = $2`, [nuevo_nombre, id]);
    res.redirect(`${destino}?ok=Editado`);
  } catch (err) {
    console.error("[Procesos] Error editando documento:", err);
    res.redirect(destino);
  }
});

router.post("/eliminar", requireRole.administrador(), async (req, res) => {
  const { public_id, db_id, return_to, seccion_base } = req.body;
  const destino = safeReturnTo(return_to);
  try {
    if (public_id) await fileStorage.deleteFile(public_id);

    const tabla = seccion_base === "otros" ? "other_documents" : "documents";
    if (db_id) await db.query(`DELETE FROM ${tabla} WHERE id = $1`, [db_id]);

    await db.query(
      "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
      [req.session.user.id, "eliminó un documento", seccion_base || "Procesos", destino],
    );

    res.redirect(destino);
  } catch (err) {
    console.error("[Procesos] Error eliminando documento:", err);
    res.status(500).send("Error eliminando");
  }
});

/** El return_to viene de un form: se acota a rutas internas de /procesos. */
function safeReturnTo(value) {
  const raw = String(value || "");
  return /^\/procesos(\/|$)/.test(raw) ? raw : "/procesos";
}

module.exports = router;
