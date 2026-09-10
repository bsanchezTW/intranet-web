const express = require("express");
const multer = require("multer");

const router = express.Router();
const db = require("../db");
const fileStorage = require("../services/fileStorage");
const requireExpenseReviewer = require("../middlewares/requireExpenseReviewer");
const { UPLOAD_LIMITS_BYTES, UPLOAD_LIMITS_MB } = require("../config/uploadLimits");
const { isAdministrador, normalizeRole } = require("../constants/roles");
const {
  EXPENSE_STAGE,
  EXPENSE_KIND_LABELS,
  expenseStatusLabel,
  expenseStatusBadge,
  expenseKindLabel,
  expenseStageLabel,
  isExpenseKind,
} = require("../constants/expenseStatuses");
const { formatMoney, getDocumentConfig } = require("../config/country");
const { formatNationalId } = require("../utils/nationalId");
const costCenters = require("../services/costCenters/costCenterService");
const expenses = require("../services/expenses/expenseRequestService");
const areaManager = require("../services/expenses/areaManager");
const financeTeam = require("../services/expenses/financeTeam");
const notifications = require("../services/expenses/expenseNotificationService");

/**
 * Centro de gastos: rendiciones y solicitudes de fondos.
 *
 * Se monta en /gastos y no bajo /procesos aunque la UI viva ahí: el router de
 * procesos termina en un catch-all /:seccion/:area que se tragaría cualquier
 * ruta hija.
 */

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMITS_BYTES.PROCESS_DOCUMENT },
});

/**
 * Formateadores para las plantillas. Las vistas EJS de este proyecto no tienen
 * require en scope, así que los helpers viajan como locals en cada render.
 */
const VIEW_HELPERS = {
  formatMoney,
  formatNationalId,
  expenseStatusLabel,
  expenseStatusBadge,
  expenseKindLabel,
  expenseStageLabel,
};

function redirectOk(res, path, msg) {
  return res.redirect(`${path}?ok=1&msg=${encodeURIComponent(msg)}`);
}

function redirectError(res, path, msg) {
  return res.redirect(`${path}?error=${encodeURIComponent(msg)}`);
}

function flashFrom(req) {
  return {
    success:
      req.query.ok === "1"
        ? decodeURIComponent(req.query.msg || "Operación exitosa")
        : null,
    error: req.query.error ? decodeURIComponent(req.query.error) : null,
  };
}

/** Registra la transición en el historial de cambios, como vacaciones. */
async function logChange(userId, action, requestId) {
  try {
    await db.query(
      "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
      [userId, action, "Centro de gastos", `/gastos/${requestId}`],
    );
  } catch (err) {
    console.error("[Gastos] No se pudo registrar en el historial:", err.message);
  }
}

/** Datos del solicitante para los correos (la sesión no trae first/last name). */
async function fetchRequester(userId) {
  const { rows } = await db.query(
    "SELECT id, first_name, last_name, email, national_id FROM users WHERE id = $1",
    [userId],
  );
  return rows[0] || null;
}

// ---------------------------------------------------------------------------
// Mis solicitudes
// ---------------------------------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const user = req.session.user;
    const [solicitudes, requisitos, esRevisor] = await Promise.all([
      expenses.listForUser(user.id),
      requisitosParaRendir(user),
      puedeRevisar(user),
    ]);

    res.render("gastos/index", {
      titulo: "Mis solicitudes de gastos",
      solicitudes,
      requisitos,
      esRevisor,
      ...flashFrom(req),
      user,
      ...VIEW_HELPERS,
      extraCss: ["/css/gastos.css"],
      extraJs: ["/js/gastos-lista.js"],
    });
  } catch (err) {
    console.error("[Gastos] Error listando solicitudes:", err);
    res.status(500).send("Error cargando tus solicitudes");
  }
});

/**
 * Qué le falta a este colaborador para poder rendir.
 *
 * Los cuatro requisitos se resuelven juntos porque la portada, el índice y el
 * formulario necesitan exactamente la misma respuesta, y responderla en tres
 * sitios distintos es como se desincronizan los avisos.
 *
 * @returns {{ ok: boolean, motivo: string|null, area, manager, centros }}
 */
async function requisitosParaRendir(user) {
  const [context, centros, ficha] = await Promise.all([
    areaManager.getUserAreaContext(user.id),
    costCenters.listUserCostCenters(user.id),
    fetchRequester(user.id),
  ]);

  const documento = ficha && ficha.national_id ? ficha.national_id : null;
  const base = {
    area: context.area,
    manager: context.manager,
    centros,
    documento,
    documentoLabel: getDocumentConfig().label,
  };

  if (!context.area) {
    return {
      ...base,
      ok: false,
      motivo: "No tienes un área asignada. Pídele a RRHH que te asigne una.",
    };
  }
  if (!context.manager) {
    return {
      ...base,
      ok: false,
      motivo: `El área ${context.area.area_name} aún no tiene un jefe asignado, y su aprobación es un requisito. Pídele a RRHH que designe uno.`,
    };
  }
  if (!documento) {
    return {
      ...base,
      ok: false,
      motivo: `Necesitas registrar tu ${base.documentoLabel} antes de rendir gastos. Complétalo en tu perfil.`,
      arreglarEn: "/perfil",
    };
  }
  if (!centros.length) {
    return {
      ...base,
      ok: false,
      motivo:
        "No tienes centros de costo asignados, y todo gasto debe imputarse a uno. Pídele a RRHH que te asigne al menos uno.",
    };
  }

  return { ...base, ok: true, motivo: null };
}

async function puedeRevisar(user) {
  if (isAdministrador(normalizeRole(user.role))) return true;
  if (await financeTeam.isFinanceApprover(user)) return true;
  return areaManager.isAreaManager(user);
}

// ---------------------------------------------------------------------------
// Formulario
// ---------------------------------------------------------------------------

router.get("/nueva/:kind", async (req, res) => {
  const { kind } = req.params;
  if (!isExpenseKind(kind)) return res.redirect("/gastos");

  try {
    const requisitos = await requisitosParaRendir(req.session.user);
    if (!requisitos.ok) {
      return redirectError(res, "/gastos", requisitos.motivo);
    }

    res.render("gastos/formulario", {
      titulo: EXPENSE_KIND_LABELS[kind],
      kind,
      requisitos,
      maxAdjuntoMb: UPLOAD_LIMITS_MB.PROCESS_DOCUMENT,
      ...flashFrom(req),
      user: req.session.user,
      ...VIEW_HELPERS,
      extraCss: ["/css/gastos.css"],
      extraJs: ["/js/gastos-form.js"],
    });
  } catch (err) {
    console.error("[Gastos] Error abriendo el formulario:", err);
    res.status(500).send("Error cargando el formulario");
  }
});

/**
 * Subida de comprobantes, en dos pasos como en /procesos: este endpoint deja el
 * archivo en el bucket y devuelve la referencia; el POST de creación la
 * persiste. Un archivo subido y luego abandonado queda huérfano en el bucket,
 * igual que hoy en Procesos.
 */
router.post("/adjuntos/upload", upload.single("archivo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No se subió archivo" });

    if (!fileStorage.validateFileSize(req.file.buffer, UPLOAD_LIMITS_MB.PROCESS_DOCUMENT)) {
      return res.status(400).json({
        error: `El archivo excede el límite de ${UPLOAD_LIMITS_MB.PROCESS_DOCUMENT} MB`,
      });
    }

    const year = new Date().getFullYear();
    const folder = `gastos/${year}/${req.session.user.id}`;
    const result = await fileStorage.saveFile(
      req.file.buffer,
      folder,
      req.file.originalname,
    );

    res.json({
      secure_url: result.secure_url,
      public_id: result.public_id,
      fileName: result.fileName,
      name: req.file.originalname,
    });
  } catch (err) {
    console.error("[Gastos] Error subiendo comprobante:", err);
    res.status(500).json({ error: err.message || "Error al subir el archivo" });
  }
});

router.post("/", async (req, res) => {
  const {
    kind,
    title,
    description,
    needed_by: neededBy,
    cost_center_id: costCenterId,
  } = req.body;

  try {
    const result = await expenses.createRequest({
      user: req.session.user,
      kind,
      title,
      description,
      neededBy,
      costCenterId,
      items: req.body.items,
      attachments: req.body.attachments,
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    const requester = await fetchRequester(req.session.user.id);
    const request = { ...result.request, area_name: result.area.area_name };
    notifications.notifyNewRequest({
      request,
      user: requester || req.session.user,
      manager: result.manager,
    });
    logChange(
      req.session.user.id,
      `envió una ${EXPENSE_KIND_LABELS[kind].toLowerCase()}`,
      result.request.id,
    );

    res.json({ ok: true, id: result.request.id });
  } catch (err) {
    console.error("[Gastos] Error creando solicitud:", err);
    res.status(500).json({ error: "No se pudo registrar la solicitud." });
  }
});

// ---------------------------------------------------------------------------
// Gestión (el tercer módulo) — antes de /:id para que no lo capture
// ---------------------------------------------------------------------------

router.get("/gestion", requireExpenseReviewer(), async (req, res) => {
  try {
    const user = req.session.user;
    const [pendientes, historial, areasACargo, esFinanzas] = await Promise.all([
      expenses.listPendingForReviewer(user),
      expenses.listHistoryForReviewer(user),
      areaManager.listManagedAreas(user.id),
      financeTeam.isFinanceApprover(user),
    ]);

    res.render("gastos/gestion", {
      titulo: "Gestión de solicitudes",
      pendientes,
      historial,
      areasACargo,
      esFinanzas,
      esAdmin: isAdministrador(normalizeRole(user.role)),
      ...flashFrom(req),
      user,
      ...VIEW_HELPERS,
      extraCss: ["/css/gastos.css"],
      extraJs: ["/js/gastos-lista.js"],
    });
  } catch (err) {
    console.error("[Gastos] Error cargando la gestión:", err);
    res.status(500).send("Error cargando las solicitudes");
  }
});

// ---------------------------------------------------------------------------
// Detalle y acciones
// ---------------------------------------------------------------------------

router.get("/:id", async (req, res) => {
  try {
    const request = await expenses.getRequestDetail(req.params.id);
    if (!request) return res.status(404).redirect("/gastos");

    const user = req.session.user;
    if (!(await expenses.canViewRequest(request, user))) {
      return res
        .status(403)
        .render("acceso_no_permitido", { titulo: "Acceso no permitido" });
    }

    const stage = await expenses.reviewerStageFor(request, user);

    res.render("gastos/detalle", {
      titulo: `Solicitud #${request.id}`,
      solicitud: request,
      etapaRevisor: stage,
      esDueno: Number(request.user_id) === Number(user.id),
      volverA: req.query.volver === "gestion" ? "/gastos/gestion" : "/gastos",
      ...flashFrom(req),
      user,
      ...VIEW_HELPERS,
      extraCss: ["/css/gastos.css"],
    });
  } catch (err) {
    console.error("[Gastos] Error abriendo el detalle:", err);
    res.status(500).send("Error cargando la solicitud");
  }
});

/** Aprobar y rechazar comparten todo salvo el verbo. */
function resolver(approve) {
  return async (req, res) => {
    const volver =
      req.body.volver === "gestion" ? "/gastos/gestion" : `/gastos/${req.params.id}`;
    try {
      const user = req.session.user;
      const result = approve
        ? await expenses.approveRequest({
            requestId: req.params.id,
            reviewer: user,
            notes: req.body.notes,
          })
        : await expenses.rejectRequest({
            requestId: req.params.id,
            reviewer: user,
            notes: req.body.notes,
          });

      if (!result.ok) return redirectError(res, volver, result.error);

      const detail = await expenses.getRequestDetail(result.request.id);
      const requester = await fetchRequester(result.request.user_id);

      if (!approve) {
        notifications.notifyRejected({
          request: detail,
          user: requester,
          stage: result.stage,
        });
      } else if (result.stage === EXPENSE_STAGE.MANAGER) {
        notifications.notifyManagerApproved({ request: detail });
      } else {
        notifications.notifyFinanceApproved({ request: detail, user: requester });
      }

      logChange(
        user.id,
        approve ? "aprobó una solicitud de gastos" : "rechazó una solicitud de gastos",
        result.request.id,
      );

      return redirectOk(
        res,
        volver,
        approve ? "Solicitud aprobada." : "Solicitud rechazada.",
      );
    } catch (err) {
      console.error("[Gastos] Error resolviendo la solicitud:", err);
      return redirectError(res, volver, "No se pudo procesar la solicitud.");
    }
  };
}

router.post("/:id/aprobar", requireExpenseReviewer(), resolver(true));
router.post("/:id/rechazar", requireExpenseReviewer(), resolver(false));

router.post("/:id/cancelar", async (req, res) => {
  try {
    const result = await expenses.cancelRequest({
      requestId: req.params.id,
      user: req.session.user,
    });
    if (!result.ok) {
      return redirectError(res, `/gastos/${req.params.id}`, result.error);
    }
    logChange(req.session.user.id, "anuló su solicitud de gastos", result.request.id);
    return redirectOk(res, "/gastos", "Solicitud anulada.");
  } catch (err) {
    console.error("[Gastos] Error anulando la solicitud:", err);
    return redirectError(
      res,
      `/gastos/${req.params.id}`,
      "No se pudo anular la solicitud.",
    );
  }
});

module.exports = router;
