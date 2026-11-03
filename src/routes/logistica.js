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
  isVehicleKind,
  labelFrom,
  formatKm,
  formatChecklistNumber,
} = require("../constants/vehicleChecklist");
const { GROUPS: ZONE_GROUPS, modelFor } = require("../constants/vehicleZones");
const { todayInCountry, formatDisplay } = require("../utils/vacationDateUtils");

/**
 * Logística: Gestión de flota (vehículos, revisión mecánica, revisión física
 * e historial) y, pronto, hojas de ruta.
 *
 *   /logistica/flota                       vehículos con sus tres botones
 *   /logistica/flota/:id/historial         historial de un vehículo
 *   /logistica/flota/:id/revision-fisica   revisión física sobre el modelo 3D
 *   /logistica/flota/mecanica/...          revisión mecánica (el checklist)
 *
 * Se monta en /logistica y no bajo /procesos por la misma razón que /letras:
 * el router de procesos termina en un catch-all (/:seccion/:area) que se
 * tragaría las rutas hijas. Las direcciones de la primera versión
 * (/logistica/vehiculos, /logistica/checklists) redirigen a las nuevas.
 */

const FLOTA = "/logistica/flota";
const MECANICA = `${FLOTA}/mecanica`;

const EXTRA_CSS = ["/css/procesos.css?v=20260916m", "/css/logistica.css?v=20261103f"];

const VIEW_HELPERS = {
  INSPECTION_KINDS,
  ANSWERS,
  RESULTS,
  FUEL_LEVELS,
  VEHICLE_KINDS,
  isVehicleKind,
  labelFrom,
  formatKm,
  formatDate: (value) => (value ? formatDisplay(value).replace(/-/g, "/") : "—"),
  resultLabel: checklists.resultLabel,
  formatChecklistNumber,
  vehicleLabel: vehicles.vehicleLabel,
  documentAlerts: vehicles.documentAlerts,
  documentsFor: vehicles.documentsFor,
  FLOTA,
  MECANICA,
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
// Direcciones de la primera versión: enlaces guardados, change_log y marcadores.
// ---------------------------------------------------------------------------

function querySuffix(req) {
  const i = req.originalUrl.indexOf("?");
  return i === -1 ? "" : req.originalUrl.slice(i);
}

router.get(/^\/vehiculos(\/.*)?$/, (req, res) => {
  const resto = req.params[0] || "";
  res.redirect(301, `${FLOTA}${resto === "/nuevo" ? "/nuevo" : resto}${querySuffix(req)}`);
});

router.get(/^\/checklists(\/.*)?$/, (req, res) => {
  const resto = req.params[0] || "";
  const destino = { "/nuevo": "/nueva", "/plantilla": "/items" }[resto] ?? resto;
  res.redirect(301, `${MECANICA}${destino}${querySuffix(req)}`);
});

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
// Permisos de la flota
// ---------------------------------------------------------------------------

const VER_FLOTA = "logistica.vehiculo.ver";
const ADMIN_FLOTA = "logistica.vehiculo.administrar";
const VER = "logistica.checklist.ver";
const CREAR = "logistica.checklist.crear";
const PLANTILLA = "logistica.plantilla.administrar";

// A Gestión de flota entra quien ve la flota o quien registra o ve
// revisiones: el conductor llega por los botones de su vehículo.
const accesoFlota = requireAnyPermission(VER_FLOTA, VER, CREAR);

function permisosFlota(req) {
  const can = (key) => decide(req.perms, key, req.permLegacy);
  return {
    puedeAdministrar: can(ADMIN_FLOTA),
    puedeRevisar: can(CREAR),
    puedeVerRevisiones: can(VER) || can(CREAR),
    puedePlantilla: can(PLANTILLA),
  };
}

/**
 * Filtro de las revisiones mecánicas: el alcance de "ver" sobre quien
 * registró. Quien sólo registra (sin "ver") encuentra lo suyo, para poder
 * imprimirlo.
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

// ---------------------------------------------------------------------------
// Revisión mecánica (el «Check list diario»). Va antes de /flota/:id para que
// "mecanica" no se lea como un id.
// ---------------------------------------------------------------------------

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

router.get("/flota/mecanica", requireAnyPermission(VER, CREAR), async (req, res) => {
  try {
    const filtros = filtrosFrom(req.query);
    const scope = checklistScope(req);
    const today = todayInCountry();
    const [registros, resumen, flota] = await Promise.all([
      checklists.listChecklists({ ...filtros, scope }),
      checklists.summary(today, scope),
      vehicles.listVehicles(),
    ]);
    res.render("logistica/flota/mecanica/index", {
      titulo: "Revisiones mecánicas",
      registros,
      resumen,
      filtros,
      flota,
      limite: checklists.LIST_LIMIT,
      ...permisosFlota(req),
      ...flashFrom(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Logística] Error listando revisiones mecánicas:", err);
    res.status(500).send("Error cargando las revisiones mecánicas");
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
  res.status(status).render("logistica/flota/mecanica/nueva", {
    titulo: "Revisión mecánica",
    values,
    errors,
    ...context,
    today: todayInCountry(),
    driverOther: checklists.DRIVER_OTHER,
    answerKey: checklists.answerKey,
    commentKey: checklists.commentKey,
    puedeFlota: decide(req.perms, ADMIN_FLOTA, req.permLegacy),
    ...VIEW_HELPERS,
    extraCss: EXTRA_CSS,
    extraJs: ["/js/checklist-form.js?v=20261103b"],
  });
}

router.get("/flota/mecanica/nueva", requirePermission(CREAR), async (req, res) => {
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

router.post("/flota/mecanica", requirePermission(CREAR), async (req, res) => {
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
    const link = `${MECANICA}/${creado.id}`;
    await logChange(req.session.user.id, `registró la revisión mecánica ${creado.number}`, link);
    // "Guardar e imprimir": queda guardada igual y se abre el PDF en el visor
    // del navegador, que ya trae imprimir y descargar.
    if (req.body.accion === "imprimir") return res.redirect(`${link}/pdf`);
    res.redirect(withFlash(link, { ok: `Revisión ${creado.number} guardada` }));
  } catch (err) {
    console.error("[Logística] Error registrando la revisión mecánica:", err);
    res.status(500).send("Error registrando la revisión mecánica");
  }
});

// --- Ítems de la revisión mecánica (plantilla) ---------------------------------

async function renderTemplate(res, { errors = {}, values = {}, editId = null, status = 200, flash = {} }) {
  const items = await checklists.listTemplateItems({ includeInactive: true });
  res.status(status).render("logistica/flota/mecanica/items", {
    titulo: "Ítems de la revisión mecánica",
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

const ITEMS = `${MECANICA}/items`;

router.get("/flota/mecanica/items", requirePermission(PLANTILLA), async (req, res) => {
  try {
    await renderTemplate(res, { flash: flashFrom(req) });
  } catch (err) {
    console.error("[Logística] Error cargando la plantilla:", err);
    res.status(500).send("Error cargando la plantilla");
  }
});

router.post("/flota/mecanica/items", requirePermission(PLANTILLA), async (req, res) => {
  try {
    const { values, errors, ok } = checklists.normalizeItemInput(req.body);
    if (!ok) return await renderTemplate(res, { errors, values, status: 422 });
    await checklists.createTemplateItem(values);
    await logChange(req.session.user.id, `agregó el ítem «${values.label}» a la revisión mecánica`, ITEMS);
    res.redirect(withFlash(ITEMS, { ok: "Ítem agregado" }));
  } catch (err) {
    console.error("[Logística] Error agregando ítem:", err);
    res.status(500).send("Error guardando el ítem");
  }
});

router.post("/flota/mecanica/items/:id", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  try {
    const { values, errors, ok } = checklists.normalizeItemInput(req.body);
    if (!ok) return await renderTemplate(res, { errors, values, editId: id, status: 422 });
    if (!(await checklists.updateTemplateItem(id, values))) return notFound(res);
    await logChange(req.session.user.id, `editó el ítem «${values.label}» de la revisión mecánica`, ITEMS);
    res.redirect(withFlash(ITEMS, { ok: "Ítem actualizado" }));
  } catch (err) {
    console.error("[Logística] Error editando ítem:", err);
    res.status(500).send("Error guardando el ítem");
  }
});

router.post("/flota/mecanica/items/:id/estado", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const activar = req.body.activo === "1";
  try {
    if (!(await checklists.setTemplateItemActive(id, activar))) return notFound(res);
    res.redirect(withFlash(ITEMS, {
      ok: activar ? "El ítem vuelve a la revisión" : "El ítem ya no se pedirá en las revisiones nuevas",
    }));
  } catch (err) {
    console.error("[Logística] Error cambiando el estado del ítem:", err);
    res.redirect(withFlash(ITEMS, { error: "No se pudo cambiar el ítem" }));
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

router.get("/flota/mecanica/:id", requireAnyPermission(VER, CREAR), async (req, res) => {
  try {
    const registro = await loadVisible(req, res);
    if (!registro) return;
    res.render("logistica/flota/mecanica/detalle", {
      titulo: `Revisión mecánica ${registro.number}`,
      registro,
      puedeAnular: decide(req.perms, "logistica.checklist.anular", req.permLegacy),
      ...flashFrom(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Logística] Error cargando la revisión mecánica:", err);
    res.status(500).send("Error cargando la revisión mecánica");
  }
});

router.get("/flota/mecanica/:id/pdf", requireAnyPermission(VER, CREAR), async (req, res) => {
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

router.post("/flota/mecanica/:id/anular", requirePermission("logistica.checklist.anular"), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const link = `${MECANICA}/${id}`;
  try {
    const anulado = await checklists.voidChecklist(id, req.body.motivo, req.session.user.id);
    if (!anulado) return res.redirect(withFlash(link, { error: "La revisión ya estaba anulada o no existe" }));
    await logChange(req.session.user.id, `anuló la revisión mecánica ${anulado.number}`, link);
    res.redirect(withFlash(link, { ok: `Revisión ${anulado.number} anulada` }));
  } catch (err) {
    if (err instanceof checklists.ChecklistError) return res.redirect(withFlash(link, { error: err.message }));
    console.error("[Logística] Error anulando la revisión mecánica:", err);
    res.redirect(withFlash(link, { error: "No se pudo anular la revisión" }));
  }
});

// ---------------------------------------------------------------------------
// Gestión de flota
// ---------------------------------------------------------------------------

router.get("/flota", accesoFlota, async (req, res) => {
  try {
    const flota = await vehicles.listVehicles();
    res.render("logistica/flota/index", {
      titulo: "Gestión de flota",
      flota,
      today: todayInCountry(),
      ...permisosFlota(req),
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
  res.status(status).render("logistica/flota/form", {
    titulo: vehiculo ? `Editar ${vehiculo.plate}` : "Agregar vehículo",
    values,
    errors,
    vehiculo,
    ...VIEW_HELPERS,
    extraCss: EXTRA_CSS,
  });
}

router.get("/flota/nuevo", requirePermission(ADMIN_FLOTA), (req, res) => {
  renderVehicleForm(res, { values: {} });
});

router.post("/flota", requirePermission(ADMIN_FLOTA), async (req, res) => {
  const { values, errors, ok } = vehicles.normalizeVehicleInput(req.body);
  try {
    if (!ok) return renderVehicleForm(res, { values, errors, status: 422 });
    await vehicles.createVehicle(values, req.session.user.id);
    await logChange(req.session.user.id, `agregó el vehículo ${values.plate}`, FLOTA);
    res.redirect(withFlash(FLOTA, { ok: `Vehículo ${values.plate} agregado` }));
  } catch (err) {
    if (err instanceof vehicles.VehicleInputError) {
      return renderVehicleForm(res, { values, errors: { [err.field]: err.message }, status: 409 });
    }
    console.error("[Logística] Error agregando vehículo:", err);
    res.status(500).send("Error guardando el vehículo");
  }
});

async function loadVehicle(req, res) {
  const id = parseId(req.params.id);
  const vehiculo = id ? await vehicles.getVehicle(id) : null;
  if (!vehiculo) notFound(res);
  return vehiculo;
}

router.get("/flota/:id/editar", requirePermission(ADMIN_FLOTA), async (req, res) => {
  try {
    const vehiculo = await loadVehicle(req, res);
    if (!vehiculo) return;
    renderVehicleForm(res, { values: vehiculo, vehiculo });
  } catch (err) {
    console.error("[Logística] Error cargando vehículo:", err);
    res.status(500).send("Error cargando el vehículo");
  }
});

router.post("/flota/:id", requirePermission(ADMIN_FLOTA), async (req, res) => {
  try {
    const vehiculo = await loadVehicle(req, res);
    if (!vehiculo) return;
    const { values, errors, ok } = vehicles.normalizeVehicleInput(req.body);
    if (!ok) return renderVehicleForm(res, { values, errors, vehiculo, status: 422 });
    try {
      await vehicles.updateVehicle(vehiculo.id, values, req.session.user.id);
    } catch (err) {
      if (err instanceof vehicles.VehicleInputError) {
        return renderVehicleForm(res, { values, errors: { [err.field]: err.message }, vehiculo, status: 409 });
      }
      throw err;
    }
    await logChange(req.session.user.id, `editó el vehículo ${values.plate}`, `${FLOTA}/${vehiculo.id}/historial`);
    res.redirect(withFlash(FLOTA, { ok: `Vehículo ${values.plate} actualizado` }));
  } catch (err) {
    console.error("[Logística] Error editando vehículo:", err);
    res.status(500).send("Error guardando el vehículo");
  }
});

router.post("/flota/:id/estado", requirePermission(ADMIN_FLOTA), async (req, res) => {
  const activar = req.body.activo === "1";
  try {
    const vehiculo = await loadVehicle(req, res);
    if (!vehiculo) return;
    await vehicles.setVehicleActive(vehiculo.id, activar, req.session.user.id);
    await logChange(
      req.session.user.id,
      `${activar ? "reactivó" : "dio de baja"} el vehículo ${vehiculo.plate}`,
      `${FLOTA}/${vehiculo.id}/historial`,
    );
    res.redirect(withFlash(FLOTA, {
      ok: activar ? `${vehiculo.plate} vuelve a la flota` : `${vehiculo.plate} quedó dado de baja`,
    }));
  } catch (err) {
    console.error("[Logística] Error cambiando estado del vehículo:", err);
    res.redirect(withFlash(FLOTA, { error: "No se pudo cambiar el estado del vehículo" }));
  }
});

// --- Historial y revisión física de un vehículo --------------------------------

router.get("/flota/:id/historial", accesoFlota, async (req, res) => {
  try {
    const vehiculo = await loadVehicle(req, res);
    if (!vehiculo) return;
    const mecanicas = await checklists.listChecklists({ vehiculo: vehiculo.id, scope: checklistScope(req) });
    res.render("logistica/flota/historial", {
      titulo: `Historial de ${vehiculo.plate}`,
      vehiculo,
      mecanicas,
      today: todayInCountry(),
      ...permisosFlota(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Logística] Error cargando el historial:", err);
    res.status(500).send("Error cargando el historial");
  }
});

router.get("/flota/:id/revision-fisica", accesoFlota, async (req, res) => {
  try {
    const vehiculo = await loadVehicle(req, res);
    if (!vehiculo) return;
    res.render("logistica/flota/fisica", {
      titulo: `Revisión física de ${vehiculo.plate}`,
      vehiculo,
      modelo: modelFor(vehiculo.kind),
      grupos: ZONE_GROUPS,
      ...permisosFlota(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Logística] Error cargando la revisión física:", err);
    res.status(500).send("Error cargando la revisión física");
  }
});

module.exports = router;
