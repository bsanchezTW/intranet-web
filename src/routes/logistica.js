const express = require("express");

const router = express.Router();
const db = require("../db");
const requirePermission = require("../middlewares/requirePermission");
const { requireAnyPermission } = require("../middlewares/requirePermission");
const { decide } = require("../services/permissions/decide");
const vehicles = require("../services/logistics/vehicleService");
const checklists = require("../services/logistics/checklistService");
const { renderChecklistPdf } = require("../services/logistics/checklistPdf");
const { parseId } = require("../services/logistics/inputs");
const {
  INSPECTION_KINDS,
  ANSWERS,
  RESULTS,
  FUEL_LEVELS,
  VEHICLE_KINDS,
  labelFrom,
  formatKm,
} = require("../constants/vehicleChecklist");
const { todayInCountry, formatDisplay } = require("../utils/vacationDateUtils");

/**
 * Logística: flota, checklist de vehículos y (pronto) hojas de ruta.
 *
 * Se monta en /logistica y no bajo /procesos por la misma razón que /letras:
 * el router de procesos termina en un catch-all (/:seccion/:area) que se
 * tragaría las rutas hijas. La portada vive en la sección Logística de
 * Procesos; aquí no hay una propia.
 */

const EXTRA_CSS = ["/css/procesos.css?v=20260916m", "/css/logistica.css?v=20261103b"];

const VIEW_HELPERS = {
  INSPECTION_KINDS,
  ANSWERS,
  RESULTS,
  FUEL_LEVELS,
  VEHICLE_KINDS,
  labelFrom,
  formatKm,
  formatDate: (value) => (value ? formatDisplay(value).replace(/-/g, "/") : "—"),
  resultLabel: checklists.resultLabel,
  vehicleLabel: vehicles.vehicleLabel,
  documentAlerts: vehicles.documentAlerts,
};

function flashFrom(req) {
  return {
    success: req.query.ok === "1" ? String(req.query.msg || "Operación exitosa") : null,
    error: req.query.error ? String(req.query.error) : null,
  };
}

function withFlash(path, { ok, error }) {
  if (error) return `${path}?error=${encodeURIComponent(error)}`;
  return `${path}?ok=1&msg=${encodeURIComponent(ok)}`;
}

function notFound(res) {
  return res.status(404).render("404", { titulo: "Página no encontrada" });
}

async function logChange(userId, action, linkPath) {
  try {
    await db.query(
      "INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)",
      [userId, action, "Logística", linkPath],
    );
  } catch (err) {
    console.error("[Logística] No se pudo registrar en el historial:", err.message);
  }
}

router.use(requirePermission("logistica.acceso"));

router.get("/", (req, res) => res.redirect("/procesos#seccion-logistica"));

// ---------------------------------------------------------------------------
// Hojas de ruta (en construcción)
// ---------------------------------------------------------------------------

router.get("/hojas-de-ruta", requirePermission("logistica.hoja_ruta.ver"), (req, res) => {
  res.render("logistica/hojas_ruta/index", {
    titulo: "Hojas de ruta",
    extraCss: EXTRA_CSS,
  });
});

// ---------------------------------------------------------------------------
// Flota
// ---------------------------------------------------------------------------

const puedeAdministrarFlota = (req) => decide(req.perms, "logistica.vehiculo.administrar", req.permLegacy);

router.get("/vehiculos", requirePermission("logistica.vehiculo.ver"), async (req, res) => {
  try {
    const flota = await vehicles.listVehicles();
    res.render("logistica/vehiculos/index", {
      titulo: "Flota de vehículos",
      flota,
      today: todayInCountry(),
      puedeAdministrar: puedeAdministrarFlota(req),
      puedeRevisar: decide(req.perms, "logistica.checklist.crear", req.permLegacy),
      ...flashFrom(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Logística] Error listando la flota:", err);
    res.status(500).send("Error cargando la flota");
  }
});

function renderVehicleForm(res, { values, errors = {}, vehiculo = null, status = 200 }) {
  res.status(status).render("logistica/vehiculos/form", {
    titulo: vehiculo ? `Editar ${vehiculo.plate}` : "Agregar vehículo",
    values,
    errors,
    vehiculo,
    ...VIEW_HELPERS,
    extraCss: EXTRA_CSS,
  });
}

router.get("/vehiculos/nuevo", requirePermission("logistica.vehiculo.administrar"), (req, res) => {
  renderVehicleForm(res, { values: { kind: "camioneta" } });
});

router.post("/vehiculos", requirePermission("logistica.vehiculo.administrar"), async (req, res) => {
  const { values, errors, ok } = vehicles.normalizeVehicleInput(req.body);
  try {
    if (!ok) return renderVehicleForm(res, { values, errors, status: 422 });
    await vehicles.createVehicle(values, req.session.user.id);
    await logChange(req.session.user.id, `agregó el vehículo ${values.plate}`, "/logistica/vehiculos");
    res.redirect(withFlash("/logistica/vehiculos", { ok: `Vehículo ${values.plate} agregado` }));
  } catch (err) {
    if (err instanceof vehicles.VehicleInputError) {
      return renderVehicleForm(res, { values, errors: { [err.field]: err.message }, status: 409 });
    }
    console.error("[Logística] Error agregando vehículo:", err);
    res.status(500).send("Error guardando el vehículo");
  }
});

router.get("/vehiculos/:id/editar", requirePermission("logistica.vehiculo.administrar"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  try {
    const vehiculo = await vehicles.getVehicle(id);
    if (!vehiculo) return notFound(res);
    renderVehicleForm(res, { values: vehiculo, vehiculo });
  } catch (err) {
    console.error("[Logística] Error cargando vehículo:", err);
    res.status(500).send("Error cargando el vehículo");
  }
});

router.post("/vehiculos/:id", requirePermission("logistica.vehiculo.administrar"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  try {
    const vehiculo = await vehicles.getVehicle(id);
    if (!vehiculo) return notFound(res);
    const { values, errors, ok } = vehicles.normalizeVehicleInput(req.body);
    if (!ok) return renderVehicleForm(res, { values, errors, vehiculo, status: 422 });
    try {
      await vehicles.updateVehicle(id, values, req.session.user.id);
    } catch (err) {
      if (err instanceof vehicles.VehicleInputError) {
        return renderVehicleForm(res, { values, errors: { [err.field]: err.message }, vehiculo, status: 409 });
      }
      throw err;
    }
    await logChange(req.session.user.id, `editó el vehículo ${values.plate}`, "/logistica/vehiculos");
    res.redirect(withFlash("/logistica/vehiculos", { ok: `Vehículo ${values.plate} actualizado` }));
  } catch (err) {
    console.error("[Logística] Error editando vehículo:", err);
    res.status(500).send("Error guardando el vehículo");
  }
});

router.post("/vehiculos/:id/estado", requirePermission("logistica.vehiculo.administrar"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const activar = req.body.activo === "1";
  try {
    const vehiculo = await vehicles.getVehicle(id);
    if (!vehiculo) return notFound(res);
    await vehicles.setVehicleActive(id, activar, req.session.user.id);
    await logChange(
      req.session.user.id,
      `${activar ? "reactivó" : "dio de baja"} el vehículo ${vehiculo.plate}`,
      "/logistica/vehiculos",
    );
    res.redirect(withFlash("/logistica/vehiculos", {
      ok: activar ? `${vehiculo.plate} vuelve a la flota` : `${vehiculo.plate} quedó dado de baja`,
    }));
  } catch (err) {
    console.error("[Logística] Error cambiando estado del vehículo:", err);
    res.redirect(withFlash("/logistica/vehiculos", { error: "No se pudo cambiar el estado del vehículo" }));
  }
});

// ---------------------------------------------------------------------------
// Checklist de vehículos
// ---------------------------------------------------------------------------

const VER = "logistica.checklist.ver";
const CREAR = "logistica.checklist.crear";

/**
 * Filtro del listado: el alcance de "ver" sobre quien registró. Quien sólo
 * registra (sin "ver") encuentra lo suyo, para poder imprimirlo.
 */
function checklistScope(req) {
  const scope = req.perms.sqlFilter(VER, { ownerColumn: "c.created_by" });
  if (scope.clause !== "FALSE") return scope;
  return { clause: "c.created_by = $1", params: [req.session.user.id] };
}

function puedeVerChecklist(req, row) {
  if (decide(req.perms, VER, req.permLegacy, { record: { ownerId: row.created_by } })) return true;
  return Number(row.created_by) === Number(req.session.user.id) && decide(req.perms, CREAR, req.permLegacy);
}

function filtrosFrom(query) {
  const resultados = ["apto", "observado", "no_apto", "anulados"];
  return {
    q: String(query.q || "").trim().slice(0, 80),
    resultado: resultados.includes(query.resultado) ? query.resultado : "",
    desde: /^\d{4}-\d{2}-\d{2}$/.test(query.desde || "") ? query.desde : "",
    hasta: /^\d{4}-\d{2}-\d{2}$/.test(query.hasta || "") ? query.hasta : "",
    vehiculo: parseId(query.vehiculo),
  };
}

router.get("/checklists", requireAnyPermission(VER, CREAR), async (req, res) => {
  try {
    const filtros = filtrosFrom(req.query);
    const scope = checklistScope(req);
    const today = todayInCountry();
    const [registros, resumen, flota] = await Promise.all([
      checklists.listChecklists({ ...filtros, scope }),
      checklists.summary(today, scope),
      vehicles.listVehicles(),
    ]);
    res.render("logistica/checklists/index", {
      titulo: "Checklist de vehículos",
      registros,
      resumen,
      filtros,
      flota,
      limite: checklists.LIST_LIMIT,
      puedeRegistrar: decide(req.perms, CREAR, req.permLegacy),
      puedePlantilla: decide(req.perms, "logistica.plantilla.administrar", req.permLegacy),
      puedeFlota: decide(req.perms, "logistica.vehiculo.ver", req.permLegacy),
      ...flashFrom(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Logística] Error listando checklists:", err);
    res.status(500).send("Error cargando los checklists");
  }
});

async function formContext() {
  const [items, flota, conductores] = await Promise.all([
    checklists.listTemplateItems(),
    vehicles.listVehicles({ includeInactive: false }),
    checklists.listDrivers(),
  ]);
  return { items, flota, conductores };
}

async function renderChecklistForm(req, res, { values, errors = {}, status = 200, ctx = null }) {
  const context = ctx || (await formContext());
  res.status(status).render("logistica/checklists/nuevo", {
    titulo: "Registrar checklist",
    values,
    errors,
    ...context,
    today: todayInCountry(),
    driverOther: checklists.DRIVER_OTHER,
    answerKey: checklists.answerKey,
    commentKey: checklists.commentKey,
    puedeFlota: decide(req.perms, "logistica.vehiculo.administrar", req.permLegacy),
    ...VIEW_HELPERS,
    extraCss: EXTRA_CSS,
    extraJs: ["/js/checklist-form.js?v=20261103a"],
  });
}

router.get("/checklists/nuevo", requirePermission(CREAR), async (req, res) => {
  try {
    const vehiculo = parseId(req.query.vehiculo);
    await renderChecklistForm(req, res, {
      values: {
        inspection_date: todayInCountry(),
        inspection_kind: "salida",
        vehicle_id: vehiculo || "",
        driver_choice: String(req.session.user.id),
      },
    });
  } catch (err) {
    console.error("[Logística] Error abriendo el formulario:", err);
    res.status(500).send("Error cargando el formulario");
  }
});

router.post("/checklists", requirePermission(CREAR), async (req, res) => {
  try {
    const ctx = await formContext();
    const { values, errors, ok } = checklists.normalizeChecklistInput(req.body, {
      items: ctx.items,
      vehicles: ctx.flota,
      drivers: ctx.conductores,
      today: todayInCountry(),
    });
    if (!ok) return await renderChecklistForm(req, res, { values, errors, status: 422, ctx });
    let creado;
    try {
      creado = await checklists.createChecklist(values, req.session.user.id);
    } catch (err) {
      if (err instanceof checklists.ChecklistError) {
        return await renderChecklistForm(req, res, { values, errors: { general: err.message }, status: 409, ctx });
      }
      throw err;
    }
    const link = `/logistica/checklists/${creado.id}`;
    await logChange(req.session.user.id, `registró el checklist ${creado.number}`, link);
    res.redirect(withFlash(link, { ok: `Checklist ${creado.number} registrado` }));
  } catch (err) {
    console.error("[Logística] Error registrando checklist:", err);
    res.status(500).send("Error registrando el checklist");
  }
});

// --- Plantilla --------------------------------------------------------------

const PLANTILLA = "logistica.plantilla.administrar";

async function renderTemplate(res, { errors = {}, values = {}, editId = null, status = 200, flash = {} }) {
  const items = await checklists.listTemplateItems({ includeInactive: true });
  res.status(status).render("logistica/checklists/plantilla", {
    titulo: "Ítems del checklist",
    items,
    errors,
    values,
    editId,
    categorias: [...new Set(items.map((i) => i.category))],
    ...flash,
    ...VIEW_HELPERS,
    extraCss: EXTRA_CSS,
  });
}

router.get("/checklists/plantilla", requirePermission(PLANTILLA), async (req, res) => {
  try {
    await renderTemplate(res, { flash: flashFrom(req) });
  } catch (err) {
    console.error("[Logística] Error cargando la plantilla:", err);
    res.status(500).send("Error cargando la plantilla");
  }
});

router.post("/checklists/plantilla", requirePermission(PLANTILLA), async (req, res) => {
  try {
    const { values, errors, ok } = checklists.normalizeItemInput(req.body);
    if (!ok) return await renderTemplate(res, { errors, values, status: 422 });
    await checklists.createTemplateItem(values);
    await logChange(req.session.user.id, `agregó el ítem «${values.label}» al checklist`, "/logistica/checklists/plantilla");
    res.redirect(withFlash("/logistica/checklists/plantilla", { ok: "Ítem agregado" }));
  } catch (err) {
    console.error("[Logística] Error agregando ítem:", err);
    res.status(500).send("Error guardando el ítem");
  }
});

router.post("/checklists/plantilla/:id", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  try {
    const { values, errors, ok } = checklists.normalizeItemInput(req.body);
    if (!ok) return await renderTemplate(res, { errors, values, editId: id, status: 422 });
    if (!(await checklists.updateTemplateItem(id, values))) return notFound(res);
    await logChange(req.session.user.id, `editó el ítem «${values.label}» del checklist`, "/logistica/checklists/plantilla");
    res.redirect(withFlash("/logistica/checklists/plantilla", { ok: "Ítem actualizado" }));
  } catch (err) {
    console.error("[Logística] Error editando ítem:", err);
    res.status(500).send("Error guardando el ítem");
  }
});

router.post("/checklists/plantilla/:id/estado", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const activar = req.body.activo === "1";
  try {
    if (!(await checklists.setTemplateItemActive(id, activar))) return notFound(res);
    res.redirect(withFlash("/logistica/checklists/plantilla", {
      ok: activar ? "El ítem vuelve al checklist" : "El ítem ya no se pedirá en los checklists nuevos",
    }));
  } catch (err) {
    console.error("[Logística] Error cambiando el estado del ítem:", err);
    res.redirect(withFlash("/logistica/checklists/plantilla", { error: "No se pudo cambiar el ítem" }));
  }
});

// --- Documento ---------------------------------------------------------------

async function loadVisible(req, res) {
  const id = parseId(req.params.id);
  const registro = id ? await checklists.getChecklist(id) : null;
  if (!registro) {
    notFound(res);
    return null;
  }
  if (!puedeVerChecklist(req, registro)) {
    res.status(403).render("acceso_no_permitido", { titulo: "Acceso no permitido" });
    return null;
  }
  return registro;
}

router.get("/checklists/:id", requireAnyPermission(VER, CREAR), async (req, res) => {
  try {
    const registro = await loadVisible(req, res);
    if (!registro) return;
    res.render("logistica/checklists/detalle", {
      titulo: `Checklist ${registro.number}`,
      registro,
      puedeAnular: decide(req.perms, "logistica.checklist.anular", req.permLegacy),
      ...flashFrom(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Logística] Error cargando checklist:", err);
    res.status(500).send("Error cargando el checklist");
  }
});

router.get("/checklists/:id/pdf", requireAnyPermission(VER, CREAR), async (req, res) => {
  try {
    const registro = await loadVisible(req, res);
    if (!registro) return;
    const buffer = await renderChecklistPdf(registro);
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="${registro.number}.pdf"`);
    res.set("Cache-Control", "private, no-store");
    res.send(buffer);
  } catch (err) {
    console.error("[Logística] Error generando el PDF:", err);
    res.status(500).send("Error generando el PDF");
  }
});

router.post("/checklists/:id/anular", requirePermission("logistica.checklist.anular"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const link = `/logistica/checklists/${id}`;
  try {
    const anulado = await checklists.voidChecklist(id, req.body.motivo, req.session.user.id);
    if (!anulado) return res.redirect(withFlash(link, { error: "El checklist ya estaba anulado o no existe" }));
    await logChange(req.session.user.id, `anuló el checklist ${anulado.number}`, link);
    res.redirect(withFlash(link, { ok: `Checklist ${anulado.number} anulado` }));
  } catch (err) {
    if (err instanceof checklists.ChecklistError) return res.redirect(withFlash(link, { error: err.message }));
    console.error("[Logística] Error anulando checklist:", err);
    res.redirect(withFlash(link, { error: "No se pudo anular el checklist" }));
  }
});

module.exports = router;
