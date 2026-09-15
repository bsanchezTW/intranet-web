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
  EXPENSE_STATUS,
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
const bankAccounts = require("../services/expenses/bankAccountService");
const {
  BANCO_ESTADO_CODE,
  ALL_BANK_ACCOUNT_TYPES,
  bankAccountTypeLabel,
} = require("../constants/banks");
const {
  EXPENSE_CATEGORY_GROUPS,
  HIDDEN_EXPENSE_CATEGORIES,
  MAX_LODGING_DAYS,
  expenseCategoryLabel,
  categoryRequiresDays,
  formatFuelDetails,
} = require("../constants/expenseCategories");
const { formatDisplay } = require("../utils/vacationDateUtils");
const funds = require("../services/expenses/expenseFundService");

/**
 * Centro de gastos: rendiciones y solicitudes de fondos.
 *
 * Se monta en /gastos y no bajo /procesos aunque la UI viva ahí: el router de
 * procesos termina en un catch-all /:seccion/:area que se tragaría cualquier
 * ruta hija.
 *
 * El formulario no tiene página propia: es un modal de /gastos que sirve para
 * crear, guardar como borrador y retomar borradores.
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
  expenseCategoryLabel,
  categoryRequiresDays,
  formatFuelDetails: (details) => formatFuelDetails(details, formatMoney),
  bankAccountTypeLabel,
  fundBalance: funds.fundBalance,
  fundStateLabel: funds.fundStateLabel,
  formatExpenseDate: (value) => (value ? formatDisplay(value) : "—"),
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
// Mis solicitudes (con el formulario en modal)
// ---------------------------------------------------------------------------

router.get("/", async (req, res) => {
  try {
    const user = req.session.user;
    const [solicitudes, requisitos, esRevisor, fondos] = await Promise.all([
      expenses.listForUser(user.id),
      requisitosParaRendir(user),
      puedeRevisar(user),
      funds.getFundSummary(user.id),
    ]);

    // Los catálogos del formulario sólo se cargan si el colaborador puede
    // abrirlo: sin requisitos el modal no se pinta.
    const formulario = requisitos.ok ? await datosFormulario(user, requisitos, fondos) : null;

    res.render("gastos/index", {
      titulo: "Mis solicitudes de gastos",
      solicitudes,
      requisitos,
      esRevisor,
      formulario,
      fondos,
      diasBorrador: expenses.DRAFT_TTL_DAYS,
      ...flashFrom(req),
      user,
      ...VIEW_HELPERS,
      // procesos.css: las tarjetas de "Nueva solicitud" y el aviso de
      // requisitos son las de Procesos y Documentos.
      extraCss: ["/css/procesos.css", "/css/gastos.css?v=20260915g"],
      extraJs: formulario
        ? ["/js/gastos-lista.js?v=20260915i", "/js/gastos-form.js?v=20260915g"]
        : ["/js/gastos-lista.js?v=20260915i"],
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

/** Catálogos y datos propios que necesita el modal del formulario. */
async function datosFormulario(user, requisitos, fondos) {
  const [bancos, cuentasGuardadas] = await Promise.all([
    bankAccounts.listBanks(),
    bankAccounts.listUserAccounts(user.id),
  ]);
  return {
    categoriaGrupos: EXPENSE_CATEGORY_GROUPS,
    categoriasOcultas: HIDDEN_EXPENSE_CATEGORIES,
    // Fondos aprobados sin rendición activa: lo que se puede rendir ahora.
    fondosPorRendir: fondos ? fondos.porRendir : [],
    maxDiasHospedaje: MAX_LODGING_DAYS,
    bancos,
    cuentasGuardadas,
    tiposCuenta: ALL_BANK_ACCOUNT_TYPES,
    bancoEstadoCode: BANCO_ESTADO_CODE,
    cuentaRut: bankAccounts.cuentaRutNumber(requisitos.documento),
    maxAdjuntoMb: UPLOAD_LIMITS_MB.PROCESS_DOCUMENT,
  };
}

async function puedeRevisar(user) {
  if (isAdministrador(normalizeRole(user.role))) return true;
  if (await financeTeam.isFinanceApprover(user)) return true;
  return areaManager.isAreaManager(user);
}

// ---------------------------------------------------------------------------
// Formulario
// ---------------------------------------------------------------------------

/** El formulario es un modal de /gastos; esta URL queda por enlaces antiguos. */
router.get("/nueva/:kind", (req, res) => {
  const { kind } = req.params;
  if (!isExpenseKind(kind)) return res.redirect("/gastos");
  res.redirect(`/gastos?nueva=${kind}`);
});

/**
 * Subida de comprobantes al bucket. El formulario los tiene en el navegador
 * hasta guardar el borrador o enviar; entonces los manda aquí y el POST de
 * /guardar los asocia y les pone el nombre definitivo.
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
      req.file.mimetype ? { contentType: req.file.mimetype } : {},
    );

    res.json({
      secure_url: result.secure_url,
      public_id: result.public_id,
      fileName: result.fileName,
      name: req.file.originalname,
    });
  } catch (err) {
    console.error("[Gastos] Error subiendo comprobante:", err);
    const raw = err.message || "";
    const error = /fetch failed|network|ECONNRESET|ETIMEDOUT/i.test(raw)
      ? "No se pudo guardar el comprobante en el almacenamiento. Inténtalo de nuevo."
      : raw || "Error al subir el archivo";
    res.status(500).json({ error });
  }
});

/**
 * Borra del bucket comprobantes subidos que no llegaron a guardarse (el
 * usuario los quitó o cerró el formulario). El servicio sólo toca archivos de
 * la carpeta del usuario que no pertenezcan a ninguna solicitud. Lo llama
 * también navigator.sendBeacon al salir de la página.
 */
router.post("/adjuntos/descartar", async (req, res) => {
  try {
    const result = await expenses.discardUploads({
      user: req.session.user,
      refs: (req.body || {}).refs,
    });
    res.json(result);
  } catch (err) {
    console.error("[Gastos] Error descartando comprobantes:", err);
    res.status(500).json({ error: "No se pudieron descartar los archivos." });
  }
});

/** Borra una cuenta guardada. Sólo toca las del usuario de la sesión. */
router.post("/cuentas/eliminar", async (req, res) => {
  try {
    const deleted = await bankAccounts.deleteUserAccount(req.session.user.id, req.body);
    if (!deleted) {
      return res.status(404).json({ error: "Esa cuenta ya no estaba guardada." });
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("[Gastos] Error eliminando cuenta guardada:", err);
    res.status(500).json({ error: "No se pudo eliminar la cuenta." });
  }
});

/**
 * Crea o envía una solicitud, o guarda un borrador.
 * `draft: true` guarda sin exigir nada; `id` apunta al borrador que se retoma.
 *
 * Vive en /gastos/guardar y no en POST /gastos: en Express 5 un POST al mismo
 * path del GET de la lista puede redirigir por la barra final, y Firefox
 * aborta ese fetch con "NetworkError when attempting to fetch resource".
 */
router.post("/guardar", async (req, res) => {
  const body = req.body || {};
  const asDraft = body.draft === true || body.draft === "true";

  try {
    const result = await expenses.saveRequest({
      user: req.session.user,
      kind: body.kind,
      draftId: body.id,
      asDraft,
      title: body.title,
      description: body.description,
      neededBy: body.needed_by,
      costCenterId: body.cost_center_id,
      items: body.items,
      attachments: body.attachments,
      bankAccount: body.bank_account,
      saveBankAccount: body.save_bank_account,
      fundRequestId: body.fund_request_id,
      destination: body.destination,
      periodStart: body.period_start,
      periodEnd: body.period_end,
    });

    if (!result.ok) {
      return res.status(400).json({ error: result.error });
    }

    if (asDraft) {
      return res.json({
        ok: true,
        draft: true,
        id: result.request.id,
        updatedAt: result.request.updated_at,
        attachments: result.attachments,
      });
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
      `envió una ${EXPENSE_KIND_LABELS[body.kind].toLowerCase()}`,
      result.request.id,
    );

    res.json({ ok: true, id: result.request.id });
  } catch (err) {
    console.error("[Gastos] Error guardando solicitud:", err);
    res.status(500).json({ error: "No se pudo guardar la solicitud." });
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
    const [porLiquidar, sinRendir] = esFinanzas
      ? await Promise.all([expenses.listPendingSettlements(), funds.listOverdueFunds()])
      : [[], []];

    res.render("gastos/gestion", {
      titulo: "Gestión de solicitudes",
      pendientes,
      historial,
      areasACargo,
      esFinanzas,
      porLiquidar,
      sinRendir,
      esAdmin: isAdministrador(normalizeRole(user.role)),
      ...flashFrom(req),
      user,
      ...VIEW_HELPERS,
      extraCss: ["/css/gastos.css?v=20260915g"],
    extraJs: ["/js/gastos-lista.js?v=20260915i"],
    });
  } catch (err) {
    console.error("[Gastos] Error cargando la gestión:", err);
    res.status(500).send("Error cargando las solicitudes");
  }
});

// ---------------------------------------------------------------------------
// Borradores
// ---------------------------------------------------------------------------

/** Datos de un borrador propio para rellenar el modal. */
router.get("/:id/borrador", async (req, res) => {
  try {
    const draft = await expenses.getDraftForEdit(req.params.id, req.session.user);
    if (!draft) {
      return res.status(404).json({ error: "Ese borrador ya no existe o ya fue enviado." });
    }
    res.json(draft);
  } catch (err) {
    console.error("[Gastos] Error abriendo borrador:", err);
    res.status(500).json({ error: "No se pudo abrir el borrador." });
  }
});

router.post("/:id/borrador/eliminar", async (req, res) => {
  try {
    const result = await expenses.deleteDraft({
      requestId: req.params.id,
      user: req.session.user,
    });
    if (!result.ok) return res.status(404).json({ error: result.error });
    res.json({ ok: true });
  } catch (err) {
    console.error("[Gastos] Error eliminando borrador:", err);
    res.status(500).json({ error: "No se pudo eliminar el borrador." });
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

    // Un borrador no tiene detalle: se retoma en el modal de Mis solicitudes.
    if (request.status === EXPENSE_STATUS.DRAFT) {
      return Number(request.user_id) === Number(user.id)
        ? res.redirect(`/gastos?borrador=${request.id}`)
        : res.redirect("/gastos");
    }

    if (!(await expenses.canViewRequest(request, user))) {
      return res
        .status(403)
        .render("acceso_no_permitido", { titulo: "Acceso no permitido" });
    }

    const stage = await expenses.reviewerStageFor(request, user);
    // Liquidar es de Finanzas, sólo sobre rendiciones aprobadas con saldo
    // pendiente (las sin saldo se liquidan solas al aprobarse).
    const puedeLiquidar =
      request.kind === "rendicion" &&
      request.status === EXPENSE_STATUS.APPROVED_FINANCE &&
      !request.settled_at &&
      (await financeTeam.isFinanceApprover(user));

    res.render("gastos/detalle", {
      titulo: `Solicitud #${request.id}`,
      solicitud: request,
      etapaRevisor: stage,
      puedeLiquidar,
      esDueno: Number(request.user_id) === Number(user.id),
      volverA: req.query.volver === "gestion" ? "/gastos/gestion" : "/gastos",
      ...flashFrom(req),
      user,
      ...VIEW_HELPERS,
      // procesos.css: las migas de navegación son las de Procesos.
      extraCss: ["/css/procesos.css", "/css/gastos.css?v=20260915h"],
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

/** Finanzas marca la rendición como liquidada (saldo devuelto o pagado). */
router.post("/:id/liquidar", requireExpenseReviewer(), async (req, res) => {
  const volver =
    req.body.volver === "gestion" ? "/gastos/gestion" : `/gastos/${req.params.id}`;
  try {
    const result = await expenses.settleRequest({
      requestId: req.params.id,
      reviewer: req.session.user,
      notes: req.body.notes,
    });
    if (!result.ok) return redirectError(res, volver, result.error);

    const requester = await fetchRequester(result.request.user_id);
    notifications.notifySettled({ request: result.request, user: requester });
    logChange(req.session.user.id, "liquidó una rendición de gastos", result.request.id);
    return redirectOk(res, volver, "Rendición liquidada.");
  } catch (err) {
    console.error("[Gastos] Error liquidando la rendición:", err);
    return redirectError(res, volver, "No se pudo liquidar la rendición.");
  }
});

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
