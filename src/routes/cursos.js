/**
 * Academy: catálogo de cursos por sección, material, reproductor, evaluación
 * y el tablero de avance (KPI).
 */
const express = require("express");
const db = require("../db");
const multer = require("multer");
const fileStorage = require("../services/fileStorage");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const requirePermission = require("../middlewares/requirePermission");
const { scopeFilter } = require("../services/permissions/decide");
const { safeReturnTo, withQueryParam } = require("../utils/returnTo");
const { gradeEvaluation, attachOptions } = require("../services/courses/evaluation");
const {
  MATERIAL_VIEW_COLUMNS,
  mapCourseForView,
  mapStudyMaterialForView,
  mapQuestionForView,
  buildCourseProgressMap,
  groupCoursesBySubsection,
  mapCourseCatalogRow,
  mapIntegranteCourseProgress,
} = require("../utils/schemaMappers");

const router = express.Router();

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_LIMITS_BYTES.COURSE_MATERIAL },
});

const COURSE_LIST_BASE = `
  SELECT c.id, c.title, c.subsection, sd.image_url
  FROM courses c
  LEFT JOIN subsection_details sd ON c.subsection = sd.name
`;

const COURSE_PROGRESS_COLUMNS = `
  course_id, status, seconds_watched
`;

// ==========================================
// RUTA: CURSOS Y CAPACITACIONES
// ==========================================
const verCursos = requirePermission("cursos.curso.ver");
// Entrar a Cursos (también el KPI y el material de quienes los editan).
router.use(["/cursos", "/kpi-cursos"], requirePermission("cursos.acceso"));
router.use("/cursos", (req, res, next) =>
  /^\/(material|editar-subseccion)(\/|$)/.test(req.path) ? next() : verCursos(req, res, next),
);

router.get("/cursos", async (req, res) => {

  try {
    res.render("cursos/index", {
      titulo: "Cursos | Transworld",
      user: req.session.user,
      active: "inicio",
    });
  } catch (err) {
    console.error("Error al cargar la página de cursos:", err);
    res.status(500).send("Error cargando los cursos");
  }
});

// ==========================================
// RUTA: EQUIPAMIENTO ACTIVO
// ==========================================
router.get("/cursos/equipamiento-activo", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const { rows: progreso } = await db.query(
      `SELECT ${COURSE_PROGRESS_COLUMNS} FROM user_course_progress WHERE user_id = $1`,
      [req.session.user.id],
    );
    const progresoMap = buildCourseProgressMap(progreso);

    const { rows: cursosRows } = await db.query(
      `${COURSE_LIST_BASE} WHERE c.section ILIKE '%Equipamiento%' AND c.is_active = true ORDER BY c.subsection ASC, c.title ASC`,
    );
    const cursosAgrupados = groupCoursesBySubsection(cursosRows);

    const { rows: materiales } = await db.query(
      `SELECT ${MATERIAL_VIEW_COLUMNS} FROM study_materials WHERE section = 'Equipamiento Activo' ORDER BY created_at DESC`,
    );

    res.render("cursos/equipamiento-activo", {
      titulo: "Equipamiento Activo | Transworld",
      pageTitle: "Equipamiento activo",
      user: req.session.user,
      active: "equipamiento",
      progresoUsuario: progresoMap,
      cursosAgrupados,
      materiales: materiales.map(mapStudyMaterialForView),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ==========================================
// RUTA: FIBRA ÓPTICA
// ==========================================
router.get("/cursos/fibra-optica", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const { rows: progreso } = await db.query(
      `SELECT ${COURSE_PROGRESS_COLUMNS} FROM user_course_progress WHERE user_id = $1`,
      [req.session.user.id],
    );
    const progresoMap = buildCourseProgressMap(progreso);

    const { rows: cursosRows } = await db.query(
      `${COURSE_LIST_BASE} WHERE c.section ILIKE '%Fibra%' AND c.is_active = true ORDER BY c.subsection ASC, c.title ASC`,
    );
    const cursosAgrupados = groupCoursesBySubsection(cursosRows);

    const { rows: materiales } = await db.query(
      `SELECT ${MATERIAL_VIEW_COLUMNS} FROM study_materials WHERE section = 'Fibra Óptica' ORDER BY created_at DESC`,
    );

    res.render("cursos/fibra-optica", {
      titulo: "Fibra Óptica | Transworld",
      pageTitle: "Fibra Óptica",
      user: req.session.user,
      active: "fibra",
      progresoUsuario: progresoMap,
      cursosAgrupados,
      materiales: materiales.map(mapStudyMaterialForView),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ==========================================
// RUTA: INFRAESTRUCTURA
// ==========================================
router.get("/cursos/infraestructura", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const { rows: progreso } = await db.query(
      `SELECT ${COURSE_PROGRESS_COLUMNS} FROM user_course_progress WHERE user_id = $1`,
      [req.session.user.id],
    );
    const progresoMap = buildCourseProgressMap(progreso);

    const { rows: cursosRows } = await db.query(
      `${COURSE_LIST_BASE} WHERE c.section ILIKE '%Infraestructura%' AND c.is_active = true ORDER BY c.subsection ASC, c.title ASC`,
    );
    const cursosAgrupados = groupCoursesBySubsection(cursosRows);

    const { rows: materiales } = await db.query(
      `SELECT ${MATERIAL_VIEW_COLUMNS} FROM study_materials WHERE section = 'Infraestructura' ORDER BY created_at DESC`,
    );

    res.render("cursos/infraestructura", {
      titulo: "Infraestructura | Transworld",
      pageTitle: "Infraestructura",
      user: req.session.user,
      active: "infraestructura",
      progresoUsuario: progresoMap,
      cursosAgrupados,
      materiales: materiales.map(mapStudyMaterialForView),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ==========================================
// RUTA: SAFETY MACHINE
// ==========================================
router.get("/cursos/safety-machine", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  try {
    const { rows: progreso } = await db.query(
      `SELECT ${COURSE_PROGRESS_COLUMNS} FROM user_course_progress WHERE user_id = $1`,
      [req.session.user.id],
    );
    const progresoMap = buildCourseProgressMap(progreso);

    const { rows: cursosRows } = await db.query(
      `${COURSE_LIST_BASE} WHERE (c.section ILIKE '%Safety%' OR c.section ILIKE '%Seguridad%') AND c.is_active = true ORDER BY c.subsection ASC, c.title ASC`,
    );
    const cursosAgrupados = groupCoursesBySubsection(cursosRows);

    const { rows: materiales } = await db.query(
      `SELECT ${MATERIAL_VIEW_COLUMNS} FROM study_materials WHERE section = 'Safety Machine' ORDER BY created_at DESC`,
    );

    res.render("cursos/safety-machine", {
      titulo: "Safety Machine | Transworld",
      pageTitle: "Safety Machine",
      user: req.session.user,
      active: "safety-machine",
      progresoUsuario: progresoMap,
      cursosAgrupados,
      materiales: materiales.map(mapStudyMaterialForView),
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// ==========================================
// CRUD: MATERIAL DE ESTUDIO
// ==========================================

/**
 * Vuelve a la página del curso desde la que se hizo la acción, con el aviso
 * (?ok= o ?error=) que el layout muestra como toast. return_url viene del
 * formulario: sólo se aceptan rutas internas.
 */
function volverACursos(res, returnUrl, tipo, mensaje) {
  return res.redirect(withQueryParam(safeReturnTo(returnUrl, "/cursos"), tipo, mensaje));
}

router.post(
  "/cursos/material/nuevo",
  requirePermission("cursos.material.crear"),
  upload.single("archivo"),
  async (req, res) => {
    const { nombre, seccion, return_url } = req.body;
    try {
      if (!req.file) return volverACursos(res, return_url, "error", "Debes adjuntar un archivo");

      const result = await fileStorage.saveFile(
        req.file.buffer,
        "material_estudio",
        req.file.originalname,
      );

      await db.query(
        "INSERT INTO study_materials (section, name, file_url, public_id, resource_type) VALUES ($1, $2, $3, $4, $5)",
        [
          seccion,
          nombre,
          result.secure_url,
          result.public_id,
          result.resource_type || "file",
        ],
      );
      volverACursos(res, return_url, "ok", "Material subido");
    } catch (err) {
      console.error("Error subiendo material:", err);
      volverACursos(res, return_url, "error", "No se pudo subir el material");
    }
  },
);

router.post(
  "/cursos/material/editar/:id",
  requirePermission("cursos.material.editar"),
  upload.single("archivo"),
  async (req, res) => {
    const { id } = req.params;
    const { nombre, return_url } = req.body;
    try {
      if (req.file) {
        const { rows } = await db.query(
          "SELECT public_id FROM study_materials WHERE id = $1",
          [id],
        );
        if (rows.length > 0 && rows[0].public_id) {
          await fileStorage.deleteFile(rows[0].public_id);
        }

        const result = await fileStorage.saveFile(
          req.file.buffer,
          "material_estudio",
          req.file.originalname,
        );

        await db.query(
          "UPDATE study_materials SET name = $1, file_url = $2, public_id = $3, resource_type = $4 WHERE id = $5",
          [nombre, result.secure_url, result.public_id, "file", id],
        );
      } else {
        await db.query(
          "UPDATE study_materials SET name = $1 WHERE id = $2",
          [nombre, id],
        );
      }
      volverACursos(res, return_url, "ok", "Material actualizado");
    } catch (err) {
      console.error("Error editando material:", err);
      volverACursos(res, return_url, "error", "No se pudo actualizar el material");
    }
  },
);

router.post(
  "/cursos/material/eliminar/:id",
  requirePermission("cursos.material.eliminar"),
  async (req, res) => {
    const { id } = req.params;
    const { return_url } = req.body;
    try {
      const { rows } = await db.query(
        "SELECT public_id FROM study_materials WHERE id = $1",
        [id],
      );
      if (rows.length > 0 && rows[0].public_id) {
        await fileStorage.deleteFile(rows[0].public_id);
      }
      await db.query("DELETE FROM study_materials WHERE id = $1", [id]);
      volverACursos(res, return_url, "ok", "Material eliminado");
    } catch (err) {
      console.error("Error eliminando material:", err);
      volverACursos(res, return_url, "error", "No se pudo eliminar el material");
    }
  },
);

// ==========================================
// EDITAR SUBSECCIÓN Y SUBIR IMAGEN
// ==========================================
router.post(
  "/cursos/editar-subseccion",
  requirePermission("cursos.material.editar"),
  upload.single("imagen"),
  async (req, res) => {
    const { old_name, new_name, current_url, return_url } = req.body;
    const nombre_final = new_name || old_name;

    try {
      if (new_name && new_name !== old_name) {
        await db.query(
          "UPDATE courses SET subsection = $1 WHERE subsection = $2",
          [new_name, old_name],
        );
        await db.query(
          "UPDATE subsection_details SET name = $1 WHERE name = $2",
          [new_name, old_name],
        );
      }

      let imageUrl = current_url;
      if (req.file) {
        if (current_url) {
          try {
            await fileStorage.deleteFile(current_url);
          } catch (err) {
            console.error("Error al intentar borrar imagen antigua:", err);
          }
        }

        const result = await fileStorage.saveFile(
          req.file.buffer,
          "subsecciones_cursos",
          req.file.originalname,
        );
        imageUrl = result.secure_url;
      }

      await db.query(
        `INSERT INTO subsection_details (name, image_url) 
         VALUES ($1, $2)
         ON CONFLICT (name) 
         DO UPDATE SET image_url = EXCLUDED.image_url`,
        [nombre_final, imageUrl],
      );

      volverACursos(res, return_url, "ok", "Subsección actualizada");
    } catch (err) {
      console.error("Error editando subsección:", err);
      volverACursos(res, return_url, "error", "No se pudo editar la subsección");
    }
  },
);

// ==========================================
// RUTA: REPRODUCTOR DE CURSOS
// ==========================================
router.get("/cursos/reproductor/:id", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  try {
    const cursoId = req.params.id;
    const usuarioId = req.session.user.id;

    const { rows: cursoRows } = await db.query(
      "SELECT * FROM courses WHERE id = $1",
      [cursoId],
    );
    if (cursoRows.length === 0)
      return res.status(404).send("Curso no encontrado");
    const cursoDb = mapCourseForView(cursoRows[0]);

    const { rows: progresoRows } = await db.query(
      "SELECT seconds_watched FROM user_course_progress WHERE user_id = $1 AND course_id = $2",
      [usuarioId, cursoId],
    );
    const progresoGuardado =
      progresoRows.length > 0 ? progresoRows[0].seconds_watched : 0;

    res.render("cursos/reproductor", {
      titulo: `${cursoDb.title} | Transworld`,
      pageTitle: "Reproductor de Curso",
      user: req.session.user,
      active: "equipamiento",
      curso: {
        id: cursoDb.id,
        title: cursoDb.title,
        description: cursoDb.description,
        youtubeId: cursoDb.video_url,
        tiempoRequerido: cursoDb.required_watch_seconds,
      },
      progresoGuardado,
    });
  } catch (err) {
    console.error("Error cargando reproductor:", err);
    res.status(500).send("Error interno del servidor");
  }
});

// ==========================================
// API: GUARDAR PROGRESO AUTOMÁTICAMENTE
// ==========================================
router.post("/cursos/api/progreso", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "No autorizado" });

  const { curso_id, segundos_vistos } = req.body;
  const usuario_id = req.session.user.id;

  try {
    const sql = `
      INSERT INTO user_course_progress (user_id, course_id, seconds_watched, status) 
      VALUES ($1, $2, $3, 'in_progress') 
      ON CONFLICT (user_id, course_id) 
      DO UPDATE SET 
        seconds_watched = GREATEST(user_course_progress.seconds_watched, EXCLUDED.seconds_watched),
        status = CASE WHEN user_course_progress.status = 'evaluated' THEN 'evaluated' ELSE 'in_progress' END
    `;
    await db.query(sql, [usuario_id, curso_id, segundos_vistos]);
    res.json({ success: true });
  } catch (err) {
    console.error("Error guardando progreso:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// ==========================================
// RUTA: MOSTRAR EVALUACIÓN
// ==========================================
router.get("/cursos/evaluacion/:id", async (req, res) => {
  if (!req.session.user) return res.redirect("/login");
  const cursoId = req.params.id;
  const usuarioId = req.session.user.id;

  try {
    const { rows: cursoRows } = await db.query(
      "SELECT * FROM courses WHERE id = $1",
      [cursoId],
    );
    if (cursoRows.length === 0)
      return res.status(404).send("Curso no encontrado");

    const curso = mapCourseForView(cursoRows[0]);

    const { rows: userProg } = await db.query(
      "SELECT status, score, attempts FROM user_course_progress WHERE user_id = $1 AND course_id = $2",
      [usuarioId, cursoId],
    );
    const progreso = userProg.length > 0 ? userProg[0] : null;

    const yaEvaluado = progreso && progreso.status === "evaluated";
    const notaGuardada = progreso ? progreso.score : null;
    const intentosTotales = progreso ? progreso.attempts || 0 : 0;

    const { rows: preguntasRows } = await db.query(
      "SELECT id, question_text, sort_order FROM questions WHERE course_id = $1 ORDER BY sort_order ASC",
      [cursoId],
    );

    // Todas las alternativas en una consulta (antes, una por pregunta).
    const { rows: altRows } = preguntasRows.length
      ? await db.query(
          `SELECT id, question_id, text FROM question_options
            WHERE question_id = ANY($1::bigint[])
            ORDER BY id ASC`,
          [preguntasRows.map((p) => p.id)],
        )
      : { rows: [] };
    const preguntas = attachOptions(preguntasRows, altRows);

    let correctasIds = [];
    if (yaEvaluado && notaGuardada >= 80) {
      const { rows: correctas } = await db.query(
        `SELECT a.id AS alternativa_id 
         FROM question_options a 
         JOIN questions p ON a.question_id = p.id 
         WHERE p.course_id = $1 AND a.is_correct = true`,
        [cursoId],
      );
      correctasIds = correctas.map((c) => c.alternativa_id);
    }

    res.render("cursos/evaluacion", {
      titulo: `Evaluación: ${curso.title} | Transworld`,
      pageTitle: "Evaluación de Curso",
      user: req.session.user,
      active: "equipamiento",
      curso,
      preguntas: preguntas.map(mapQuestionForView),
      yaEvaluado,
      notaGuardada,
      intentosTotales,
      correctasIds,
    });
  } catch (err) {
    console.error("Error cargando evaluación:", err);
    res.status(500).send("Error interno");
  }
});

// ==========================================
// RUTA: PROCESAR EVALUACIÓN
// ==========================================
router.post("/cursos/api/evaluacion/:id", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "No autorizado" });
  const cursoId = req.params.id;
  const usuarioId = req.session.user.id;
  const respuestasUsuario = req.body;

  try {
    const { rows: correctas } = await db.query(
      `SELECT a.question_id AS pregunta_id, a.id AS alternativa_id 
       FROM question_options a 
       JOIN questions p ON a.question_id = p.id 
       WHERE p.course_id = $1 AND a.is_correct = true`,
      [cursoId],
    );

    const nota = gradeEvaluation(correctas, respuestasUsuario);
    if (!nota.ok) return res.status(400).json({ error: nota.error });
    const { porcentaje, mostrarFeedback, mapeoCorrectas } = nota;

    await db.query(
      `UPDATE user_course_progress 
       SET attempts = COALESCE(attempts, 0) + 1, 
           score = GREATEST(COALESCE(score, 0), $1), 
           status = 'evaluated', 
           seconds_watched = 0, 
           completed_at = COALESCE(completed_at, NOW())
       WHERE user_id = $2 AND course_id = $3`,
      [porcentaje, usuarioId, cursoId],
    );

    res.json({
      success: true,
      porcentaje,
      mostrarFeedback,
      respuestasCorrectas: mostrarFeedback ? mapeoCorrectas : null,
    });
  } catch (err) {
    console.error("Error procesando examen:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// ==========================================
// RUTA: REINTENTAR CURSO
// ==========================================
router.post("/cursos/api/reintentar/:id", async (req, res) => {
  if (!req.session.user)
    return res.status(401).json({ error: "No autorizado" });

  try {
    await db.query(
      `UPDATE user_course_progress 
       SET seconds_watched = 0, status = 'in_progress' 
       WHERE user_id = $1 AND course_id = $2`,
      [req.session.user.id, req.params.id],
    );
    res.json({ success: true });
  } catch (err) {
    console.error("Error reiniciando curso:", err);
    res.status(500).json({ error: "Error interno" });
  }
});

// ==========================================
// RUTA: DASHBOARD KPI DE CURSOS
// ==========================================
function buildKpiPorCursoFromRows(rows) {
  const byCourse = new Map();
  rows.forEach((row) => {
    if (!byCourse.has(row.course_id)) {
      byCourse.set(row.course_id, {
        course_id: row.course_id,
        curso_titulo: row.title,
        section: row.section,
        subsection: row.subsection,
        top10: [],
      });
    }
    byCourse.get(row.course_id).top10.push({
      nombre_usuario: row.nombre_usuario,
      score: row.score,
    });
  });
  return Array.from(byCourse.values());
}

/**
 * Alcance del KPI de cursos: se ve a quienes cubre «Ver el avance de otros».
 * El correo, sólo con «Ver el correo de cada persona en el KPI».
 */
function kpiScope(req, firstParam) {
  return scopeFilter(req.perms, "cursos.avance.ver", {
    ownerColumn: "u.id",
    areaColumn: "u.work_area_id",
    firstParam,
  });
}

function kpiShowsEmail(res) {
  return res.locals.can.field("cursos.avance.campo.email");
}

function withoutEmail(rows) {
  return rows.map((row) => ({ ...row, email: null }));
}

router.get("/kpi-cursos", requirePermission("cursos.avance.ver"), async (req, res) => {
  try {
    const alcance = kpiScope(req, 1);
    const queryRanking = `
      SELECT 
        u.id AS usuario_id,
        TRIM(u.first_name || ' ' || COALESCE(u.last_name, '')) AS nombre_usuario,
        u.email,
        COALESCE(SUM(cu.score) FILTER (WHERE cu.status = 'evaluated'), 0) AS puntaje_total,
        COUNT(cu.course_id) FILTER (WHERE cu.status = 'evaluated') AS cursos_completados,
        COUNT(cu.course_id) FILTER (WHERE cu.status = 'in_progress') AS cursos_en_curso
      FROM users u
      LEFT JOIN user_course_progress cu ON cu.user_id = u.id
      WHERE u.active AND ${alcance.clause}
      GROUP BY u.id, u.first_name, u.last_name, u.email
      HAVING COUNT(cu.course_id) FILTER (WHERE cu.status = 'evaluated') > 0
      ORDER BY puntaje_total DESC, cursos_completados DESC, nombre_usuario ASC
    `;
    const { rows: rankingRows } = await db.query(queryRanking, [
      ...alcance.params,
    ]);
    const todosLosRanking = kpiShowsEmail(res) ? rankingRows : withoutEmail(rankingRows);
    const top10Ranking = todosLosRanking.slice(0, 10);

    const { rows: cursos } = await db.query(
      `SELECT id, title, section, subsection
       FROM courses
       WHERE is_active = true
       ORDER BY section NULLS LAST, subsection NULLS LAST, title ASC`,
    );
    const catalogoCursos = cursos.map(mapCourseCatalogRow);

    const alcanceNotas = kpiScope(req, 1);
    const { rows: notasRows } = await db.query(
      `WITH ranked AS (
        SELECT
          c.id AS course_id,
          c.title,
          c.section,
          c.subsection,
          TRIM(u.first_name || ' ' || COALESCE(u.last_name, '')) AS nombre_usuario,
          cu.score,
          ROW_NUMBER() OVER (PARTITION BY c.id ORDER BY cu.score DESC NULLS LAST) AS rn
        FROM courses c
        INNER JOIN user_course_progress cu ON cu.course_id = c.id
        INNER JOIN users u ON u.id = cu.user_id
        WHERE c.is_active = true
          AND cu.score IS NOT NULL
          AND cu.score > 0
          AND ${alcanceNotas.clause}
      )
      SELECT course_id, title, section, subsection, nombre_usuario, score
      FROM ranked
      WHERE rn <= 10
      ORDER BY section NULLS LAST, subsection NULLS LAST, title ASC, score DESC`,
      alcanceNotas.params,
    );
    const kpiPorCurso = buildKpiPorCursoFromRows(notasRows);

    const { rows: statsRows } = await db.query(
      `SELECT
        (SELECT COUNT(*) FROM courses WHERE is_active = true) AS total_cursos,
        (SELECT COUNT(DISTINCT user_id) FROM user_course_progress WHERE status = 'evaluated') AS integrantes_con_completados,
        (SELECT COUNT(*) FROM user_course_progress WHERE status = 'evaluated') AS total_completados,
        (SELECT COUNT(*) FROM user_course_progress WHERE status = 'in_progress') AS total_en_curso`,
    );
    const stats = statsRows[0] || {};

    res.render("kpi-cursos", {
      titulo: "KPI Cursos | Transworld",
      pageTitle: "Dashboard de Capacitaciones",
      user: req.session.user,
      active: "inicio",
      todosLosRanking,
      top10Ranking,
      kpiPorCurso,
      catalogoCursos,
      stats,
    });
  } catch (err) {
    console.error("Error cargando Dashboard KPI Cursos:", err);
    res.status(500).send("Error interno cargando los indicadores.");
  }
});

router.get("/kpi-cursos/api/integrantes", requirePermission("cursos.avance.ver"), async (req, res) => {

  const q = String(req.query.q || "").trim();
  if (q.length < 2) {
    return res.json([]);
  }

  try {
    // Sin permiso de ver correos tampoco se busca por correo.
    const conCorreo = kpiShowsEmail(res);
    const alcance = kpiScope(req, 2);
    const { rows } = await db.query(
      `SELECT
        u.id,
        TRIM(u.first_name || ' ' || COALESCE(u.last_name, '')) AS name,
        u.email
      FROM users u
      WHERE u.active
        AND ${alcance.clause}
        AND (
          u.first_name ILIKE $1
          OR u.last_name ILIKE $1
          ${conCorreo ? "OR u.email ILIKE $1" : ""}
          OR TRIM(u.first_name || ' ' || COALESCE(u.last_name, '')) ILIKE $1
        )
      ORDER BY name ASC
      LIMIT 12`,
      [`%${q}%`, ...alcance.params],
    );
    res.json(conCorreo ? rows : withoutEmail(rows));
  } catch (err) {
    console.error("Error buscando integrantes KPI:", err);
    res.status(500).json({ error: "Error al buscar integrantes" });
  }
});

router.get("/kpi-cursos/api/integrantes/:id", requirePermission("cursos.avance.ver"), async (req, res) => {

  const userId = req.params.id;

  try {
    const alcance = kpiScope(req, 2);
    const { rows: userRows } = await db.query(
      `SELECT
        u.id,
        TRIM(u.first_name || ' ' || COALESCE(u.last_name, '')) AS name,
        u.email
      FROM users u
      WHERE u.id = $1 AND u.active AND ${alcance.clause}`,
      [userId, ...alcance.params],
    );
    if (userRows.length === 0) {
      return res.status(404).json({ error: "Integrante no encontrado" });
    }

    const { rows: progressRows } = await db.query(
      `SELECT
        c.id AS course_id,
        c.title,
        c.section,
        c.subsection,
        c.required_watch_seconds,
        cu.id AS progress_id,
        cu.status,
        cu.score,
        cu.attempts,
        cu.seconds_watched,
        cu.started_at,
        cu.completed_at
      FROM courses c
      LEFT JOIN user_course_progress cu
        ON cu.course_id = c.id AND cu.user_id = $1
      WHERE c.is_active = true
      ORDER BY c.section NULLS LAST, c.subsection NULLS LAST, c.title ASC`,
      [userId],
    );

    const courses = progressRows.map(mapIntegranteCourseProgress);
    const summary = {
      total_cursos: courses.length,
      completados: courses.filter((c) => c.status === "evaluated").length,
      en_curso: courses.filter((c) => c.status === "in_progress").length,
      sin_iniciar: courses.filter((c) => !c.status).length,
      puntaje_total: courses
        .filter((c) => c.status === "evaluated" && c.score != null)
        .reduce((sum, c) => sum + c.score, 0),
    };

    res.json({
      user: kpiShowsEmail(res) ? userRows[0] : { ...userRows[0], email: null },
      summary,
      courses,
    });
  } catch (err) {
    console.error("Error obteniendo progreso integrante KPI:", err);
    res.status(500).json({ error: "Error al cargar el progreso del integrante" });
  }
});

module.exports = router;
