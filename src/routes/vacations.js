const express = require("express");
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
const referenceService = require("../services/vacations/vacationReferenceService");
const profileService = require("../services/vacations/vacationProfileService");
const settingsService = require("../services/vacations/vacationSettingsService");
const reportService = require("../services/vacations/vacationReportService");
const notificationService = require("../services/vacations/vacationNotificationService");
const { excelFileName, sendWorkbook } = require("../services/exports/excelWorkbook");
const {
  mapVacationRequestForView,
  mapVacationPeriodForView,
  mapVacationHistoryForView,
  mapHistoryAuditForView,
} = require("../utils/schemaMappers");
const { nationalIdClientConfig } = require("../utils/nationalId");
const { countryLabel } = require("../constants/vacationStatuses");
const { VACATION_MESSAGES } = require("../constants/vacationMessages");
const { MONTH_NAMES } = require("../constants/vacationHistory");
const {
  toDateOnly,
  addDays,
  parseDateOnly,
  eachDay,
  formatDisplay,
  todayInCountry,
} = require("../utils/vacationDateUtils");

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

const RESUMEN_PATH = "/RRHH/vacaciones/gestion/resumen";

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
    await logChange(req, "exportó el resumen de vacaciones", RESUMEN_PATH);
    return sendWorkbook(res, buffer, excelFileName("vacaciones-resumen"));
  } catch (err) {
    console.error("Error exportando resumen:", err);
    return redirectErr(res, RESUMEN_PATH, VACATION_MESSAGES.exportFailed);
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

router.get("/gestion/historial/exportar", requireRrhhManager(), async (req, res) => {
  try {
    const buffer = await reportService.exportHistory();
    await logChange(req, "exportó el historial de vacaciones", RESUMEN_PATH);
    return sendWorkbook(res, buffer, excelFileName("vacaciones-historial"));
  } catch (err) {
    console.error("Error exportando historial:", err);
    return redirectErr(res, RESUMEN_PATH, VACATION_MESSAGES.exportFailed);
  }
});

router.post("/gestion/corte", requireRrhhManager(), async (req, res) => {
  const backTo = RESUMEN_PATH;
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

router.get("/gestion/:userId", requireRrhhManager(), async (req, res) => {
  const { userId } = req.params;
  try {
    const profile = await balanceService.getUserVacationProfile(userId);
    if (!profile) return res.status(404).send(VACATION_MESSAGES.collaboratorNotFound);
    let periodsBlocked = false;
    if (profile.hire_date) {
      const recalc = await balanceService.recalculatePeriods(userId);
      periodsBlocked = recalc.blocked.length > 0;
      await balanceService.ensureHistoryImputed(userId);
    }

    const [summary, periods, requests, history, historyAudit, settings, references, consuming] =
      await Promise.all([
        balanceService.getBalanceSummary(userId),
        balanceService.listPeriods(userId),
        requestService.listForUser(userId),
        historyService.listForUser(userId),
        historyService.listAudit(userId, 50),
        settingsService.getSettings(),
        referenceService.listForUser(userId),
        referenceService.consumingRequestsByUser([Number(userId)]),
      ]);

    const country = resolveCountryForUser(profile);
    const today = todayInCountry();

    // Días del historial que no caben en ningún período devengado. La
    // imputación FIFO llena hasta donde hay derecho; sin esto, cargar de más
    // deja el saldo en cero y el sobrante desaparece sin avisar.
    const historyTotalDays =
      Math.round(history.reduce((sum, h) => sum + Number(h.days_used), 0) * 100) / 100;
    const unimputedDays =
      Math.round((historyTotalDays - summary.historicalUsedDays) * 100) / 100;

    const periodViews = periods.map(mapVacationPeriodForView);
    const periodLabels = new Map(periodViews.map((p) => [p.id, p.periodLabel]));
    const requestsForBalance = consuming.get(Number(userId)) || [];
    const referenceViews = references.map((r) => ({
      ...r,
      asOfFmt: formatDisplay(r.as_of_date),
      createdByName:
        [r.created_by_first_name, r.created_by_last_name].filter(Boolean).join(" ") || null,
      ...referenceService.compareReference({
        reference: r,
        periods,
        history,
        requests: requestsForBalance,
      }),
    }));

    res.render("RRHH/vacaciones/detalle_colaborador", {
      titulo: "Detalle de vacaciones",
      user: req.session.user,
      profile,
      summary,
      periods: periodViews,
      overduePeriods: periodViews.filter((p) => p.overdue),
      dueSoonPeriods: periodViews.filter((p) => p.dueSoon),
      periodsBlockedMessage: periodsBlocked ? VACATION_MESSAGES.periodsBlocked : null,
      requests: requests.map(mapVacationRequestForView),
      history: history.map((h) => mapVacationHistoryForView(h, periodLabels)),
      historyAudit: historyAudit.map(mapHistoryAuditForView),
      historyTotalDays,
      unimputedDays: unimputedDays > 0.001 ? unimputedDays : 0,
      references: referenceViews,
      today,
      serviceTime: reportService.serviceTimeLabel(profile.hire_date, today),
      hireDateValue: toDateOnly(profile.hire_date) || "",
      nextAccrualFmt: summary.nextAccrualDate
        ? formatDisplay(summary.nextAccrualDate)
        : null,
      cutoffDateFmt: settings.historyCutoffDate
        ? formatDisplay(settings.historyCutoffDate)
        : null,
      currentMonth: today.slice(0, 7),
      documentLabel: nationalIdClientConfig().label,
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

/** Campos del modal de edición → entrada del servicio. */
function historyInputFromBody(body) {
  return {
    yearMonth: body.month,
    startDate: body.start_date || null,
    endDate: body.end_date || null,
    daysUsed: body.days_used,
    observation: body.observation,
  };
}

/** La vista previa sin los valores normalizados, que solo usa el servidor. */
function publicPreview({ values, ...preview }) {
  return preview;
}

/** Filas de la carga por lotes, tal como las manda vacaciones-historial.js. */
function batchRowsFromBody(body) {
  return Array.isArray(body?.rows)
    ? body.rows.map((r) => ({
        month: r?.month,
        days: r?.days,
        start: r?.start,
        end: r?.end,
        observation: r?.observation,
      }))
    : null;
}

router.post(
  "/gestion/:userId/historial/lote/previsualizar",
  requireRrhhManager(),
  async (req, res) => {
    try {
      const result = await historyService.previewHistoryBatch({
        userId: req.params.userId,
        rows: batchRowsFromBody(req.body),
        cutoffDate: await settingsService.getCutoffDate(),
      });
      if (!result.ok) return res.status(400).json({ errors: result.errors });
      return res.json(publicPreview(result.preview));
    } catch (err) {
      console.error("Error en vista previa del lote:", err);
      return res.status(500).json({ errors: [VACATION_MESSAGES.historyCreateFailed] });
    }
  },
);

router.post("/gestion/:userId/historial/lote", requireRrhhManager(), async (req, res) => {
  const { userId } = req.params;
  const backTo = `/RRHH/vacaciones/gestion/${encodeURIComponent(userId)}`;
  try {
    const result = await historyService.createHistoryBatch({
      userId,
      rows: batchRowsFromBody(req.body),
      actorId: req.session.user.id,
      cutoffDate: await settingsService.getCutoffDate(),
    });
    if (!result.ok) {
      return res.status(400).json({
        errors: result.errors,
        preview: result.preview ? publicPreview(result.preview) : null,
      });
    }
    await logChange(req, "registró vacaciones históricas", backTo);
    const msg = VACATION_MESSAGES.historyBatchCreated(result.created);
    return res.json({
      ok: true,
      redirect: `${backTo}?ok=1&msg=${encodeURIComponent(msg)}#historial`,
    });
  } catch (err) {
    console.error("Error registrando historial:", err);
    return res.status(500).json({ errors: [VACATION_MESSAGES.historyCreateFailed] });
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
        userId,
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
        userId,
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

// ---------- datos del cálculo y saldo de referencia ----------

router.post("/gestion/:userId/datos", requireRrhhManager(), async (req, res) => {
  const { userId } = req.params;
  const backTo = `/RRHH/vacaciones/gestion/${encodeURIComponent(userId)}`;
  try {
    const result = await profileService.updateCalculationData({
      userId,
      hireDate: req.body.hire_date,
      nationalId: req.body.national_id,
      reason: req.body.reason,
      actorId: req.session.user.id,
    });
    if (!result.ok) return redirectErr(res, backTo, result.errors.join(" "));
    await logChange(req, "corrigió los datos de cálculo de vacaciones", backTo);
    return redirectOk(
      res,
      backTo,
      [VACATION_MESSAGES.profileSaved, ...result.warnings].join(" "),
    );
  } catch (err) {
    console.error("Error actualizando datos de cálculo:", err);
    return redirectErr(res, backTo, VACATION_MESSAGES.profileFailed);
  }
});

router.post("/gestion/:userId/referencia", requireRrhhManager(), async (req, res) => {
  const { userId } = req.params;
  const backTo = `/RRHH/vacaciones/gestion/${encodeURIComponent(userId)}`;
  try {
    const profile = await balanceService.getUserVacationProfile(userId);
    if (!profile) {
      return redirectErr(res, RESUMEN_PATH, VACATION_MESSAGES.collaboratorNotFound);
    }
    const result = await referenceService.createReference({
      userId,
      asOfDate: req.body.as_of_date,
      expectedDays: req.body.expected_days,
      note: req.body.note,
      actorId: req.session.user.id,
    });
    if (!result.ok) return redirectErr(res, backTo, result.errors.join(" "));
    await logChange(req, "registró un saldo de referencia de vacaciones", backTo);
    return redirectOk(res, backTo, VACATION_MESSAGES.referenceSaved);
  } catch (err) {
    console.error("Error guardando saldo de referencia:", err);
    return redirectErr(res, backTo, VACATION_MESSAGES.referenceFailed);
  }
});

router.post(
  "/gestion/:userId/referencia/:referenceId/eliminar",
  requireRrhhManager(),
  async (req, res) => {
    const { userId, referenceId } = req.params;
    const backTo = `/RRHH/vacaciones/gestion/${encodeURIComponent(userId)}`;
    try {
      const result = await referenceService.deleteReference({
        userId,
        referenceId,
        actorId: req.session.user.id,
      });
      if (!result.ok) return redirectErr(res, backTo, result.error);
      await logChange(req, "eliminó un saldo de referencia de vacaciones", backTo);
      return redirectOk(res, backTo, VACATION_MESSAGES.referenceDeleted);
    } catch (err) {
      console.error("Error eliminando saldo de referencia:", err);
      return redirectErr(res, backTo, VACATION_MESSAGES.referenceFailed);
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

const CALENDAR_VISIBLE = 3;
const CALENDAR_WEEKDAYS = ["Lun", "Mar", "Mié", "Jue", "Vie", "Sáb", "Dom"];

function monthParam(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

function shiftMonth(year, month, delta) {
  const date = new Date(Date.UTC(year, month - 1 + delta, 1, 12));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}

function parseCalendarMonth(value, today) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(value || ""));
  if (match) {
    const year = Number(match[1]);
    const month = Number(match[2]);
    if (month >= 1 && month <= 12 && year >= 2000 && year <= 2100) {
      return { year, month };
    }
  }
  const iso = toDateOnly(today);
  return { year: Number(iso.slice(0, 4)), month: Number(iso.slice(5, 7)) };
}

function calendarMonthLabel(year, month) {
  return `${MONTH_NAMES[month - 1]} ${year}`;
}

function personChip(event) {
  const full = event.collaboratorName || "Colaborador";
  return {
    label: full.split(/\s+/)[0] || full,
    title: `${full} · ${event.startDateFmt} → ${event.endDateFmt}`,
    sort: full,
  };
}

function eventCoversDay(event, iso) {
  const start = toDateOnly(event.start_date);
  const end = toDateOnly(event.end_date);
  return Boolean(start && end && start <= iso && end >= iso);
}

/** Semanas lun–dom del mes, con los días del mes anterior y siguiente que cierran la grilla. */
function buildCalendarWeeks({ year, month, today, events }) {
  const start = `${monthParam(year, month)}-01`;
  const lead = (parseDateOnly(start).getUTCDay() + 6) % 7;
  const next = shiftMonth(year, month, 1);
  const end = addDays(`${monthParam(next.year, next.month)}-01`, -1);
  const trail = (7 - ((parseDateOnly(end).getUTCDay() + 6) % 7) - 1) % 7;
  const prefix = monthParam(year, month);
  const days = eachDay(addDays(start, -lead), addDays(end, trail)).map((iso) => {
    const people = events
      .filter((event) => eventCoversDay(event, iso))
      .map(personChip)
      .sort((a, b) => a.sort.localeCompare(b.sort, "es"));
    const hidden = people.slice(CALENDAR_VISIBLE);
    return {
      iso,
      number: Number(iso.slice(8)),
      inMonth: iso.startsWith(prefix),
      isToday: iso === today,
      people: people.slice(0, CALENDAR_VISIBLE),
      extra: hidden.length,
      extraTitle: hidden.map((person) => person.title).join(" · "),
    };
  });
  const weeks = [];
  for (let i = 0; i < days.length; i += 7) weeks.push(days.slice(i, i + 7));
  return weeks;
}

router.get("/calendario", requireRole.intranetActivo(), async (req, res) => {
  try {
    const today = todayInCountry();
    const { year, month } = parseCalendarMonth(req.query.mes, today);
    const next = shiftMonth(year, month, 1);
    const rangeEnd = addDays(`${monthParam(next.year, next.month)}-01`, -1);

    const events = await requestService.listApprovedInRange({
      startDate: `${monthParam(year, month)}-01`,
      endDate: rangeEnd,
    });

    const prev = shiftMonth(year, month, -1);
    res.render("RRHH/vacaciones/calendario", {
      titulo: "Calendario de vacaciones",
      user: req.session.user,
      monthLabel: calendarMonthLabel(year, month),
      prevMes: monthParam(prev.year, prev.month),
      nextMes: monthParam(next.year, next.month),
      weekdays: CALENDAR_WEEKDAYS,
      weeks: buildCalendarWeeks({
        year,
        month,
        today,
        events: events.map(mapVacationRequestForView),
      }),
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
