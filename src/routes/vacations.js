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
const notificationService = require("../services/vacations/vacationNotificationService");
const {
  mapVacationRequestForView,
  mapVacationPeriodForView,
} = require("../utils/schemaMappers");
const { countryLabel } = require("../constants/vacationStatuses");
const { VACATION_MESSAGES } = require("../constants/vacationMessages");
const {
  toDateOnly,
  addDays,
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

router.get("/gestion/:userId", requireRrhhManager(), async (req, res) => {
  const { userId } = req.params;
  try {
    const profile = await balanceService.getUserVacationProfile(userId);
    if (!profile) return res.status(404).send(VACATION_MESSAGES.collaboratorNotFound);
    if (profile.hire_date) await balanceService.recalculatePeriods(userId);

    const [summary, periods, requests] = await Promise.all([
      balanceService.getBalanceSummary(userId),
      balanceService.listPeriods(userId),
      requestService.listForUser(userId),
    ]);

    const country = resolveCountryForUser(profile);

    res.render("RRHH/vacaciones/detalle_colaborador", {
      titulo: "Detalle de vacaciones",
      user: req.session.user,
      profile,
      summary,
      periods: periods.map(mapVacationPeriodForView),
      requests: requests.map(mapVacationRequestForView),
      employmentCountry: country,
      countryLabel: countryLabel(country),
      ...readFlash(req),
    });
  } catch (err) {
    console.error("Error en detalle colaborador:", err);
    res.status(500).send(VACATION_MESSAGES.loadDetailFailed);
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
    notificationService.notifyApproved({ request: result.request, user: profile });
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
