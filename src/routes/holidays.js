const express = require("express");
const router = express.Router();
const db = require("../db");
const requireRrhhManager = require("../middlewares/requireRrhhManager");
const { getCurrentCountry } = require("../config/country");
const holidayService = require("../services/vacations/holidayService");
const { VACATION_MESSAGES } = require("../constants/vacationMessages");

/**
 * Feriados de la instancia (/RRHH/feriados).
 *
 * Viven fuera de Vacaciones: Soporte los usa para el horario hábil de los
 * tickets y en Chile el módulo de Vacaciones no existe (se solicitan en Rex+).
 * Los administran RRHH e Informática.
 */

const BASE_PATH = "/RRHH/feriados";

router.use(requireRrhhManager());

function redirectOk(res, msg) {
  return res.redirect(`${BASE_PATH}?ok=1&msg=${encodeURIComponent(msg)}`);
}

function redirectErr(res, msg) {
  return res.redirect(`${BASE_PATH}?error=${encodeURIComponent(msg)}`);
}

function readFlash(req) {
  return {
    success: req.query.ok === "1" ? decodeURIComponent(req.query.msg || VACATION_MESSAGES.defaultSuccess) : null,
    error: req.query.error ? decodeURIComponent(req.query.error) : null,
  };
}

async function logChange(req, action) {
  if (!req.session.user || !req.session.user.id) return;
  try {
    await db.query(
      "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
      [req.session.user.id, action, "Feriados", BASE_PATH],
    );
  } catch (err) {
    console.error("[Feriados] Error en change_log:", err.message);
  }
}

router.get("/", async (req, res) => {
  try {
    // Solo los feriados de esta instancia: el calendario del otro país se
    // administra desde su propio deployment.
    const holidays = await holidayService.listHolidays(getCurrentCountry());
    res.render("RRHH/feriados", {
      titulo: "Feriados",
      user: req.session.user,
      holidays,
      ...readFlash(req),
    });
  } catch (err) {
    console.error("Error cargando feriados:", err);
    res.status(500).send(VACATION_MESSAGES.loadHolidaysFailed);
  }
});

router.post("/", async (req, res) => {
  const { country_code, holiday_date, name, is_recurring } = req.body;
  const instanceCountry = getCurrentCountry();
  try {
    // El país llega en un hidden, así que un POST manipulado es el único modo
    // de que no coincida. No se corrige en silencio: se rechaza.
    if (country_code && country_code !== instanceCountry) {
      return redirectErr(res, VACATION_MESSAGES.holidayCountry(instanceCountry));
    }
    await holidayService.createHoliday({
      countryCode: instanceCountry,
      holidayDate: holiday_date,
      name,
      isRecurring: is_recurring === "on" || is_recurring === "1",
    });
    await logChange(req, "agregó un feriado");
    return redirectOk(res, VACATION_MESSAGES.holidayAdded);
  } catch (err) {
    console.error("Error creando feriado:", err);
    return redirectErr(res, err.message || VACATION_MESSAGES.holidayAddFailed);
  }
});

router.post("/:id/eliminar", async (req, res) => {
  try {
    const deleted = await holidayService.deleteHoliday(req.params.id, getCurrentCountry());
    if (!deleted) {
      return redirectErr(res, VACATION_MESSAGES.holidayNotFound);
    }
    await logChange(req, "eliminó un feriado");
    return redirectOk(res, VACATION_MESSAGES.holidayDeleted);
  } catch (err) {
    console.error("Error eliminando feriado:", err);
    return redirectErr(res, VACATION_MESSAGES.holidayDeleteFailed);
  }
});

module.exports = router;
