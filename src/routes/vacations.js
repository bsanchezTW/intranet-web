const express = require("express");
const multer = require("multer");
const router = express.Router();
const db = require("../db");
const requireRole = require("../middlewares/requireRole");
const requireRrhhManager = require("../middlewares/requireRrhhManager");
const {
  getStrategy,
  resolveCountryForUser,
} = require("../services/vacations/VacationEngine");
const balanceService = require("../services/vacations/vacationBalanceService");
const requestService = require("../services/vacations/vacationRequestService");
const historyService = require("../services/vacations/vacationHistoryService");
const importService = require("../services/vacations/vacationHistoryImportService");
const settingsService = require("../services/vacations/vacationSettingsService");
const reportService = require("../services/vacations/vacationReportService");
const notificationService = require("../services/vacations/vacationNotificationService");
const { excelFileName, sendWorkbook } = require("../services/exports/excelWorkbook");
const {
  mapVacationRequestForView,
  mapVacationPeriodForView,
  mapVacationHistoryForView,
} = require("../utils/schemaMappers");
const { countryLabel } = require("../constants/vacationStatuses");
const { VACATION_MESSAGES } = require("../constants/vacationMessages");
const {
  MONTH_NAMES,
  HISTORY_DETAIL,
  MIN_HISTORY_YEAR,
} = require("../constants/vacationHistory");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const {
  toDateOnly,
  addDays,
  formatDisplay,
  todayInCountry,
} = require("../utils/vacationDateUtils");

// El Excel de RR.HH. se procesa en memoria: se valida, se muestra la vista
// previa y solo entonces se inserta. Nunca se guarda el archivo en disco.
const uploadExcel = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: UPLOAD_LIMITS_BYTES.PROCESS_DOCUMENT },
});

// ---------- helpers de redirect con flash ----------
function redirectOk(res, path, msg) {
  return res.redirect(`${path}?ok=1&msg=${encodeURIComponent(msg)}`);
}
function redirectErr(res, path, msg) {
  return res.redirect(`${path}?error=${encodeURIComponent(msg)}`);
}
function readFlash(req) {
  return {
    success: req.query.ok === "1" ? decodeURIComponent(req.query.msg || VACATION_MESSAGES.defaultSuccess) : null,
    error: req.query.error ? decodeURIComponent(req.query.error) : null,
  };
}

async function logChange(req, action, linkPath) {
  if (!req.session.user || !req.session.user.id) return;
  try {
    await db.query(
      "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
      [req.session.user.id, action, "Vacaciones", linkPath],
    );
  } catch (err) {
    console.error("[Vacaciones] Error en change_log:", err.message);
  }
}

async function getAreas() {
  const { rows } = await db.query(
    "SELECT id, area_name FROM work_areas ORDER BY area_name ASC",
  );
  return rows;
}

// ==========================================================
// INDEX
// ==========================================================
router.get("/", requireRole.intranetActivo(), (req, res) => {
  res.render("RRHH/vacaciones/index", {
    titulo: "Vacaciones",
    user: req.session.user,
    ...readFlash(req),
  });
});

// ==========================================================
// MIS VACACIONES
// ==========================================================
router.get("/mis-vacaciones", requireRole.intranetActivo(), async (req, res) => {
  const userId = req.session.user.id;
  try {
    const profile = await balanceService.getUserVacationProfile(userId);
    if (profile && profile.hire_date) {
      await balanceService.recalculatePeriods(userId);
      // Mantiene al día el historial previo a la intranet (dos SUM; solo
      // reimputa cuando dejó de cuadrar, p. ej. tras un aniversario).
      await balanceService.ensureHistoryImputed(userId);
    }

    const [summary, periods, requests] = await Promise.all([
      balanceService.getBalanceSummary(userId),
      balanceService.listPeriods(userId),
      requestService.listForUser(userId),
    ]);

    const country = resolveCountryForUser(profile);
    const strategy = getStrategy(country);

    res.render("RRHH/vacaciones/mis_vacaciones", {
      titulo: "Mis vacaciones",
      user: req.session.user,
      profile,
      summary,
      periods: periods.map(mapVacationPeriodForView),
      requests: requests.map(mapVacationRequestForView),
      country,
      countryLabel: countryLabel(country),
      dayUnit: strategy.getDayUnit(),
      dayUnitLabel: strategy.getDayUnit() === "business" ? "días hábiles" : "días calendario",
      hasHireDate: Boolean(profile?.hire_date),
      nextAccrualFmt: summary.nextAccrualDate
        ? formatDisplay(summary.nextAccrualDate)
        : null,
      ...readFlash(req),
    });
  } catch (err) {
    console.error("Error en mis-vacaciones:", err);
    res.status(500).send(VACATION_MESSAGES.loadMineFailed);
  }
});

router.post("/mis-vacaciones/solicitar", requireRole.intranetActivo(), async (req, res) => {
  const userId = req.session.user.id;
  const {
    start_date,
    end_date,
    notes,
    fraction_ack,
    policy_warning_ack,
  } = req.body;
  try {
    const result = await requestService.createRequest({
      userId,
      startDate: start_date,
      endDate: end_date,
      notes,
      fractionAcknowledged: fraction_ack === "on" || fraction_ack === "1",
      policyWarningAck: policy_warning_ack === "on" || policy_warning_ack === "1",
    });

    if (!result.ok) {
      return redirectErr(res, "/RRHH/vacaciones/mis-vacaciones", result.errors.join(" "));
    }

    const profile = await balanceService.getUserVacationProfile(userId);
    notificationService.notifyNewRequest({
      request: result.request,
      user: profile,
      accumulationAlert: Boolean(result.accumulationAlert),
    });

    return redirectOk(
      res,
      "/RRHH/vacaciones/mis-vacaciones",
      VACATION_MESSAGES.requestSent,
    );
  } catch (err) {
    console.error("Error creando solicitud:", err);
    return redirectErr(res, "/RRHH/vacaciones/mis-vacaciones", VACATION_MESSAGES.sendFailed);
  }
});

router.post("/mis-vacaciones/cancelar/:id", requireRole.intranetActivo(), async (req, res) => {
  const userId = req.session.user.id;
  try {
    const result = await requestService.cancelRequest({
      requestId: req.params.id,
      userId,
    });
    if (!result.ok) {
      return redirectErr(res, "/RRHH/vacaciones/mis-vacaciones", result.error);
    }
    return redirectOk(res, "/RRHH/vacaciones/mis-vacaciones", VACATION_MESSAGES.requestCancelled);
  } catch (err) {
    console.error("Error cancelando solicitud:", err);
    return redirectErr(res, "/RRHH/vacaciones/mis-vacaciones", VACATION_MESSAGES.cancelFailed);
  }
});

// ==========================================================
// GESTIÓN (ADMIN)
// ==========================================================
router.get("/gestion", requireRrhhManager(), async (req, res) => {
  try {
    const { area, status } = req.query;
    const [requests, areas] = await Promise.all([
      requestService.listForAdmin({
        workAreaId: area || null,
        status: status || null,
      }),
      getAreas(),
    ]);

    res.render("RRHH/vacaciones/gestion", {
      titulo: "Gestión de vacaciones",
      user: req.session.user,
      requests: requests.map(mapVacationRequestForView),
      areas,
      filtros: { area: area || "", status: status || "" },
      ...readFlash(req),
    });
  } catch (err) {
    console.error("Error en gestión vacaciones:", err);
    res.status(500).send(VACATION_MESSAGES.loadGestionFailed);
  }
});

// ==========================================================
// RESUMEN CONSOLIDADO Y EXPORTACIONES (ADMIN)
// ==========================================================
// Ojo con el orden: estas rutas tienen que declararse ANTES de
// /gestion/:userId, si no "resumen" y "historial" se interpretan como el id
// de un colaborador.

router.get("/gestion/resumen", requireRrhhManager(), async (req, res) => {
  try {
    const search = req.query.q || "";
    const [report, settings] = await Promise.all([
      reportService.buildTeamReport({ search }),
      settingsService.getSettings(),
    ]);

    res.render("RRHH/vacaciones/resumen", {
      titulo: "Resumen de vacaciones",
      user: req.session.user,
      rows: report.rows,
      totals: report.totals,
      referenceDateFmt: formatDisplay(report.referenceDate),
      cutoffDate: settings.historyCutoffDate,
      cutoffDateFmt: settings.historyCutoffDate
        ? formatDisplay(settings.historyCutoffDate)
        : null,
      search,
      ...readFlash(req),
    });
  } catch (err) {
    console.error("Error en resumen de vacaciones:", err);
    res.status(500).send(VACATION_MESSAGES.loadReportFailed);
  }
});

router.get("/gestion/resumen/exportar", requireRrhhManager(), async (req, res) => {
  try {
    const buffer = await reportService.exportTeamReport();
    await logChange(req, "exportó el resumen de vacaciones", "/RRHH/vacaciones/gestion/resumen");
    return sendWorkbook(res, buffer, excelFileName("vacaciones-resumen"));
  } catch (err) {
    console.error("Error exportando resumen:", err);
    return redirectErr(res, "/RRHH/vacaciones/gestion/resumen", VACATION_MESSAGES.exportFailed);
  }
});

router.get("/gestion/exportar", requireRrhhManager(), async (req, res) => {
  try {
    const buffer = await reportService.exportRequests({
      workAreaId: req.query.area || null,
      status: req.query.status || null,
    });
    await logChange(req, "exportó el historial de solicitudes", "/RRHH/vacaciones/gestion");
    return sendWorkbook(res, buffer, excelFileName("vacaciones-solicitudes"));
  } catch (err) {
    console.error("Error exportando solicitudes:", err);
    return redirectErr(res, "/RRHH/vacaciones/gestion", VACATION_MESSAGES.exportFailed);
  }
});

router.post("/gestion/corte", requireRrhhManager(), async (req, res) => {
  const backTo = "/RRHH/vacaciones/gestion/historial/importar";
  try {
    const result = await settingsService.setCutoffDate({
      cutoffDate: req.body.cutoff_date,
      updatedBy: req.session.user.id,
    });
    if (!result.ok) return redirectErr(res, backTo, VACATION_MESSAGES.cutoffInvalid);
    await logChange(req, "actualizó la fecha de corte del historial", backTo);
    return redirectOk(res, backTo, VACATION_MESSAGES.cutoffSaved);
  } catch (err) {
    console.error("Error guardando fecha de corte:", err);
    return redirectErr(res, backTo, VACATION_MESSAGES.cutoffFailed);
  }
});

// ==========================================================
// IMPORTACIÓN DEL HISTORIAL (ADMIN)
// ==========================================================

const IMPORT_PATH = "/RRHH/vacaciones/gestion/historial/importar";

router.get("/gestion/historial/importar", requireRrhhManager(), async (req, res) => {
  try {
    const [settings, batches] = await Promise.all([
      settingsService.getSettings(),
      importService.listImports(),
    ]);
    const preview = req.session.vacationImportPreview || null;

    res.render("RRHH/vacaciones/importar_historial", {
      titulo: "Importar vacaciones históricas",
      user: req.session.user,
      preview,
      batches,
      months: MONTH_NAMES,
      cutoffDate: settings.historyCutoffDate,
      cutoffDateFmt: settings.historyCutoffDate
        ? formatDisplay(settings.historyCutoffDate)
        : null,
      ...readFlash(req),
    });
  } catch (err) {
    console.error("Error en importación de historial:", err);
    res.status(500).send(VACATION_MESSAGES.historyLoadFailed);
  }
});

router.get("/gestion/historial/plantilla", requireRrhhManager(), async (req, res) => {
  try {
    const buffer = await importService.buildTemplate();
    return sendWorkbook(res, buffer, "plantilla-vacaciones-historicas.xlsx");
  } catch (err) {
    console.error("Error generando plantilla:", err);
    return redirectErr(res, IMPORT_PATH, VACATION_MESSAGES.exportFailed);
  }
});

router.get("/gestion/historial/exportar", requireRrhhManager(), async (req, res) => {
  try {
    const buffer = await reportService.exportHistory();
    await logChange(req, "exportó el historial de vacaciones", IMPORT_PATH);
    return sendWorkbook(res, buffer, excelFileName("vacaciones-historial"));
  } catch (err) {
    console.error("Error exportando historial:", err);
    return redirectErr(res, IMPORT_PATH, VACATION_MESSAGES.exportFailed);
  }
});

router.post(
  "/gestion/historial/importar/validar",
  requireRrhhManager(),
  uploadExcel.single("archivo"),
  async (req, res) => {
    try {
      if (!req.file || !req.file.buffer) {
        return redirectErr(res, IMPORT_PATH, VACATION_MESSAGES.importNoFile);
      }
      const cutoffDate = await settingsService.getCutoffDate();
      const result = await importService.validateFile(req.file.buffer, {
        fileName: req.file.originalname,
        cutoffDate,
      });
      if (!result.ok) {
        return redirectErr(res, IMPORT_PATH, result.error);
      }
      // La vista previa vive en la sesión hasta que RR.HH. confirme o cancele:
      // nada toca la base antes de la confirmación.
      req.session.vacationImportPreview = result.preview;
      return res.redirect(IMPORT_PATH);
    } catch (err) {
      console.error("Error validando importación:", err);
      return redirectErr(res, IMPORT_PATH, VACATION_MESSAGES.importFailed);
    }
  },
);

router.post("/gestion/historial/importar/cancelar", requireRrhhManager(), (req, res) => {
  delete req.session.vacationImportPreview;
  return res.redirect(IMPORT_PATH);
});

router.post("/gestion/historial/importar/confirmar", requireRrhhManager(), async (req, res) => {
  const preview = req.session.vacationImportPreview;
  if (!preview) {
    return redirectErr(res, IMPORT_PATH, VACATION_MESSAGES.importExpired);
  }
  try {
    const result = await importService.confirmImport({
      preview,
      actorId: req.session.user.id,
      skipDuplicates: req.body.incluir_duplicados !== "1",
    });
    if (!result.ok) {
      return redirectErr(res, IMPORT_PATH, result.error);
    }
    delete req.session.vacationImportPreview;
    await logChange(req, "importó vacaciones históricas", IMPORT_PATH);
    return redirectOk(res, IMPORT_PATH, VACATION_MESSAGES.importConfirmed(result.imported));
  } catch (err) {
    console.error("Error confirmando importación:", err);
    return redirectErr(res, IMPORT_PATH, VACATION_MESSAGES.importFailed);
  }
});

router.post(
  "/gestion/historial/importar/:batchId/revertir",
  requireRrhhManager(),
  async (req, res) => {
    try {
      const result = await importService.revertImport({
        batchId: req.params.batchId,
        actorId: req.session.user.id,
      });
      if (!result.ok) return redirectErr(res, IMPORT_PATH, result.error);
      await logChange(req, "revirtió una importación de vacaciones", IMPORT_PATH);
      return redirectOk(res, IMPORT_PATH, VACATION_MESSAGES.importReverted(result.reverted));
    } catch (err) {
      console.error("Error revirtiendo importación:", err);
      return redirectErr(res, IMPORT_PATH, VACATION_MESSAGES.importFailed);
    }
  },
);

router.get("/gestion/:userId", requireRrhhManager(), async (req, res) => {
  const { userId } = req.params;
  try {
    const profile = await balanceService.getUserVacationProfile(userId);
    if (!profile) return res.status(404).send(VACATION_MESSAGES.collaboratorNotFound);
    if (profile.hire_date) {
      await balanceService.recalculatePeriods(userId);
      await balanceService.ensureHistoryImputed(userId);
    }

    const [summary, periods, requests, history, historyAudit, settings] =
      await Promise.all([
        balanceService.getBalanceSummary(userId),
        balanceService.listPeriods(userId),
        requestService.listForUser(userId),
        historyService.listForUser(userId),
        historyService.listAudit(userId, 25),
        settingsService.getSettings(),
      ]);

    const country = resolveCountryForUser(profile);
    const currentYear = Number((todayInCountry() || "").slice(0, 4));

    // Días del historial que no caben en ningún período devengado. La
    // imputación FIFO llena hasta donde hay derecho; sin esto, cargar de más
    // deja el saldo en cero y el sobrante desaparece sin avisar.
    const historyTotalDays =
      Math.round(history.reduce((sum, h) => sum + Number(h.days_used), 0) * 100) / 100;
    const unimputedDays =
      Math.round((historyTotalDays - summary.historicalUsedDays) * 100) / 100;

    res.render("RRHH/vacaciones/detalle_colaborador", {
      titulo: "Detalle de vacaciones",
      user: req.session.user,
      profile,
      summary,
      periods: periods.map(mapVacationPeriodForView),
      requests: requests.map(mapVacationRequestForView),
      history: history.map(mapVacationHistoryForView),
      historyAudit,
      historyTotalDays,
      unimputedDays: unimputedDays > 0.001 ? unimputedDays : 0,
      serviceTime: reportService.serviceTimeLabel(profile.hire_date, todayInCountry()),
      nextAccrualFmt: summary.nextAccrualDate
        ? formatDisplay(summary.nextAccrualDate)
        : null,
      cutoffDateFmt: settings.historyCutoffDate
        ? formatDisplay(settings.historyCutoffDate)
        : null,
      months: MONTH_NAMES,
      historyDetailModes: HISTORY_DETAIL,
      minHistoryYear: MIN_HISTORY_YEAR,
      currentYear,
      employmentCountry: country,
      countryLabel: countryLabel(country),
      ...readFlash(req),
    });
  } catch (err) {
    console.error("Error en detalle colaborador:", err);
    res.status(500).send(VACATION_MESSAGES.loadDetailFailed);
  }
});

// ---------- historial previo a la intranet, por colaborador ----------

/** Campos del formulario → entrada del servicio (resumido vs detallado). */
function historyInputFromBody(body) {
  const detailed = body.detail_mode === HISTORY_DETAIL.DETAILED;
  return {
    periodYear: body.period_year,
    periodMonth: body.period_month,
    startDate: detailed ? body.start_date : null,
    endDate: detailed ? body.end_date : null,
    daysUsed: body.days_used,
    observation: body.observation,
  };
}

router.post("/gestion/:userId/historial", requireRrhhManager(), async (req, res) => {
  const { userId } = req.params;
  const backTo = `/RRHH/vacaciones/gestion/${encodeURIComponent(userId)}`;
  try {
    const cutoffDate = await settingsService.getCutoffDate();
    const result = await historyService.createHistory({
      userId,
      input: historyInputFromBody(req.body),
      actorId: req.session.user.id,
      cutoffDate,
    });
    if (!result.ok) {
      return redirectErr(res, backTo, result.errors.join(" "));
    }
    await logChange(req, "registró vacaciones históricas", backTo);
    return redirectOk(res, backTo, VACATION_MESSAGES.historyCreated);
  } catch (err) {
    console.error("Error registrando historial:", err);
    return redirectErr(res, backTo, VACATION_MESSAGES.historyCreateFailed);
  }
});

router.post(
  "/gestion/:userId/historial/:historyId/editar",
  requireRrhhManager(),
  async (req, res) => {
    const { userId, historyId } = req.params;
    const backTo = `/RRHH/vacaciones/gestion/${encodeURIComponent(userId)}`;
    try {
      const cutoffDate = await settingsService.getCutoffDate();
      const result = await historyService.updateHistory({
        historyId,
        input: historyInputFromBody(req.body),
        actorId: req.session.user.id,
        cutoffDate,
      });
      if (!result.ok) {
        return redirectErr(res, backTo, result.errors.join(" "));
      }
      await logChange(req, "editó un período histórico de vacaciones", backTo);
      return redirectOk(res, backTo, VACATION_MESSAGES.historyUpdated);
    } catch (err) {
      console.error("Error editando historial:", err);
      return redirectErr(res, backTo, VACATION_MESSAGES.historyUpdateFailed);
    }
  },
);

router.post(
  "/gestion/:userId/historial/:historyId/eliminar",
  requireRrhhManager(),
  async (req, res) => {
    const { userId, historyId } = req.params;
    const backTo = `/RRHH/vacaciones/gestion/${encodeURIComponent(userId)}`;
    try {
      const result = await historyService.deleteHistory({
        historyId,
        actorId: req.session.user.id,
      });
      if (!result.ok) return redirectErr(res, backTo, result.error);
      await logChange(req, "eliminó un período histórico de vacaciones", backTo);
      return redirectOk(res, backTo, VACATION_MESSAGES.historyDeleted);
    } catch (err) {
      console.error("Error eliminando historial:", err);
      return redirectErr(res, backTo, VACATION_MESSAGES.historyDeleteFailed);
    }
  },
);

/** Rehace períodos e imputación del historial desde cero. */
router.post("/gestion/:userId/recalcular", requireRrhhManager(), async (req, res) => {
  const { userId } = req.params;
  const backTo = `/RRHH/vacaciones/gestion/${encodeURIComponent(userId)}`;
  try {
    await balanceService.recalculatePeriods(userId);
    const result = await balanceService.reimputeHistoricalDays(userId);
    await logChange(req, "recalculó el saldo de vacaciones", backTo);
    const extra =
      result.overflow > 0
        ? ` Quedaron ${result.overflow} día(s) del historial sin período que los respalde: revisa la fecha de ingreso.`
        : "";
    return redirectOk(res, backTo, `Saldo recalculado.${extra}`);
  } catch (err) {
    console.error("Error recalculando saldo:", err);
    return redirectErr(res, backTo, VACATION_MESSAGES.adjustFailed);
  }
});

router.post("/gestion/:userId/ajustar", requireRrhhManager(), async (req, res) => {
  const { userId } = req.params;
  const { period_id, days_delta, reason } = req.body;
  const backTo = `/RRHH/vacaciones/gestion/${encodeURIComponent(userId)}`;
  try {
    const profile = await balanceService.getUserVacationProfile(userId);
    if (!profile) {
      return redirectErr(res, "/RRHH/vacaciones/gestion", VACATION_MESSAGES.collaboratorNotFound);
    }
    const delta = Number(days_delta);
    if (!period_id || !Number.isFinite(delta) || delta === 0) {
      return redirectErr(res, backTo, VACATION_MESSAGES.adjustNeedPeriod);
    }
    if (!reason || !String(reason).trim()) {
      return redirectErr(res, backTo, VACATION_MESSAGES.adjustNeedReason);
    }

    await balanceService.applyAdjustment({
      periodId: period_id,
      adjustedBy: req.session.user.id,
      daysDelta: delta,
      reason,
    });
    await logChange(req, "ajustó saldo de vacaciones", backTo);

    return redirectOk(res, backTo, VACATION_MESSAGES.adjustOk);
  } catch (err) {
    console.error("Error ajustando saldo:", err);
    return redirectErr(res, backTo, VACATION_MESSAGES.adjustFailed);
  }
});

router.post("/gestion/:userId/periodo/:periodId/record", requireRrhhManager(), async (req, res) => {
  const { userId, periodId } = req.params;
  const { record_met, record_notes } = req.body;
  const backTo = `/RRHH/vacaciones/gestion/${encodeURIComponent(userId)}`;
  try {
    const profile = await balanceService.getUserVacationProfile(userId);
    if (!profile) {
      return redirectErr(res, "/RRHH/vacaciones/gestion", VACATION_MESSAGES.collaboratorNotFound);
    }
    const met = record_met === "on" || record_met === "1" || record_met === "true";
    if (!met && (!record_notes || !String(record_notes).trim())) {
      return redirectErr(res, backTo, VACATION_MESSAGES.recordNeedReason);
    }
    await balanceService.updatePeriodRecord({
      periodId,
      recordMet: met,
      validatedBy: req.session.user.id,
      notes: record_notes,
    });
    await logChange(req, "actualizó récord vacacional", backTo);
    return redirectOk(res, backTo, VACATION_MESSAGES.recordOk);
  } catch (err) {
    console.error("Error actualizando récord:", err);
    return redirectErr(res, backTo, VACATION_MESSAGES.recordFailed);
  }
});

router.post("/gestion/solicitud/:id/aprobar", requireRrhhManager(), async (req, res) => {
  const backTo = "/RRHH/vacaciones/gestion";
  try {
    const result = await requestService.approveRequest({
      requestId: req.params.id,
      reviewerId: req.session.user.id,
      notes: req.body.notes,
    });
    if (!result.ok) return redirectErr(res, backTo, result.error);

    const profile = await balanceService.getUserVacationProfile(result.request.user_id);
    // El saldo ya descontado va en la constancia: es lo primero que pregunta
    // el colaborador al recibirla.
    const balance = await balanceService.getBalanceSummary(result.request.user_id);
    notificationService.notifyApproved({ request: result.request, user: profile, balance });
    await logChange(req, "aprobó una solicitud de vacaciones", backTo);

    return redirectOk(res, backTo, VACATION_MESSAGES.requestApproved);
  } catch (err) {
    console.error("Error aprobando solicitud:", err);
    return redirectErr(res, backTo, VACATION_MESSAGES.approveFailed);
  }
});

router.post("/gestion/solicitud/:id/rechazar", requireRrhhManager(), async (req, res) => {
  const backTo = "/RRHH/vacaciones/gestion";
  try {
    const result = await requestService.rejectRequest({
      requestId: req.params.id,
      reviewerId: req.session.user.id,
      reason: req.body.reason,
    });
    if (!result.ok) return redirectErr(res, backTo, result.error);

    const profile = await balanceService.getUserVacationProfile(result.request.user_id);
    notificationService.notifyRejected({ request: result.request, user: profile });
    await logChange(req, "rechazó una solicitud de vacaciones", backTo);

    return redirectOk(res, backTo, VACATION_MESSAGES.requestRejected);
  } catch (err) {
    console.error("Error rechazando solicitud:", err);
    return redirectErr(res, backTo, VACATION_MESSAGES.rejectFailed);
  }
});

// ==========================================================
// CALENDARIO
// ==========================================================
router.get("/calendario", requireRole.intranetActivo(), async (req, res) => {
  try {
    const isAdmin = Boolean(res.locals.isAdministrador);
    const today = todayInCountry();
    const start = req.query.from ? toDateOnly(req.query.from) : addDays(today, -30);
    const end = req.query.to ? toDateOnly(req.query.to) : addDays(today, 90);

    const events = await requestService.listApprovedInRange({
      startDate: start,
      endDate: end,
      userId: isAdmin ? null : req.session.user.id,
    });

    res.render("RRHH/vacaciones/calendario", {
      titulo: "Calendario de vacaciones",
      user: req.session.user,
      isAdmin,
      events: events.map(mapVacationRequestForView),
      range: { from: start, to: end },
      ...readFlash(req),
    });
  } catch (err) {
    console.error("Error en calendario:", err);
    res.status(500).send(VACATION_MESSAGES.loadCalendarFailed);
  }
});

// ==========================================================
// API JSON
// ==========================================================
router.get("/api/saldo", requireRole.intranetActivo(), async (req, res) => {
  try {
    const userId = req.session.user.id;
    const summary = await balanceService.getBalanceSummary(userId);
    res.json(summary);
  } catch (err) {
    console.error("Error api saldo:", err);
    res.status(500).json({ error: VACATION_MESSAGES.saldoApiFailed });
  }
});

router.get("/api/preview-dias", requireRole.intranetActivo(), async (req, res) => {
  try {
    const { start_date, end_date, fraction_ack } = req.query;
    const start = toDateOnly(start_date);
    const end = toDateOnly(end_date);
    if (!start || !end) {
      return res.status(400).json({ error: VACATION_MESSAGES.invalidDates });
    }

    const preview = await requestService.previewRequest({
      userId: req.session.user.id,
      startDate: start,
      endDate: end,
      fractionAcknowledged: fraction_ack === "1" || fraction_ack === "true",
    });

    if (preview.error) {
      return res.status(400).json({ error: preview.error });
    }

    res.json(preview);
  } catch (err) {
    console.error("Error api preview-dias:", err);
    res.status(500).json({ error: VACATION_MESSAGES.previewFailed });
  }
});

module.exports = router;
