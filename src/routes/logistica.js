const os = require("os");
const fsp = require("fs/promises");
const express = require("express");
const multer = require("multer");

const router = express.Router();
const db = require("../db");
const requirePermission = require("../middlewares/requirePermission");
const { requireAnyPermission } = require("../middlewares/requirePermission");
const { decide } = require("../services/permissions/decide");
const vehicles = require("../services/logistics/vehicleService");
const checklists = require("../services/logistics/checklistService");
const template = require("../services/logistics/templateService");
const { renderChecklistPdf } = require("../services/logistics/checklistPdf");
const physical = require("../services/logistics/physicalService");
const damagePhotos = require("../services/logistics/damagePhotos");
const { renderPhysicalPdf } = require("../services/logistics/physicalPdf");
const {
  REVIEW_REASONS,
  DAMAGE_TYPES,
  MAX_PHOTOS,
  MAX_DAMAGES,
  CAPTURE_VIEWS,
  damageTypeLabel,
  reasonLabel,
  damageStateLabel,
  physicalReviewAlert,
} = require("../constants/vehiclePhysical");
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
 * Logística: Gestión de flota y, pronto, hojas de ruta.
 *
 *   /logistica/flota                       vehículos con sus botones
 *   /logistica/flota/:id/revisiones        revisiones de un vehículo (también
 *                                          se despliegan en su tarjeta)
 *   /logistica/flota/:id/revision-fisica   revisión física sobre el modelo 3D
 *   /logistica/flota/mecanica/nueva        revisión mecánica (el checklist)
 *   /logistica/flota/mecanica/:id          una revisión mecánica y su PDF
 *   /logistica/flota/mecanica/items        configurar categorías e ítems
 *   /logistica/flota/fisica/:id            una revisión física y su PDF
 *   /logistica/flota/danios/:id            un daño: fotos y reparación
 *   /logistica/flota/fotos/:id             la foto de un daño (con permiso)
 *
 * Las revisiones se consultan dentro de cada vehículo: no hay listado
 * general. Se monta en /logistica y no bajo /procesos por la misma razón que
 * /letras: el router de procesos termina en un catch-all (/:seccion/:area)
 * que se tragaría las rutas hijas. Las direcciones anteriores
 * (/logistica/vehiculos, /logistica/checklists, el listado general y el
 * historial) redirigen a las nuevas.
 */

const FLOTA = "/logistica/flota";
const MECANICA = `${FLOTA}/mecanica`;
const ITEMS = `${MECANICA}/items`;
const FISICA = `${FLOTA}/fisica`;
const DANIOS = `${FLOTA}/danios`;
const FOTOS = `${FLOTA}/fotos`;

const EXTRA_CSS = ["/css/procesos.css?v=20260916m", "/css/logistica.css?v=20261104b"];

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
  REVIEW_REASONS,
  DAMAGE_TYPES,
  MAX_PHOTOS,
  MAX_DAMAGES,
  damageTypeLabel,
  reasonLabel,
  damageStateLabel,
  physicalReviewAlert,
  FLOTA,
  MECANICA,
  ITEMS,
  FISICA,
  DANIOS,
  FOTOS,
};

function flashFrom(req) {
  return {
    success: req.query.ok === "1" ? String(req.query.msg || "Operación exitosa") : null,
    error: req.query.error ? String(req.query.error) : null,
  };
}

function withFlash(path, { ok, error }) {
  const [base, hash] = path.split("#");
  const q = error ? `error=${encodeURIComponent(error)}` : `ok=1&msg=${encodeURIComponent(ok)}`;
  return `${base}?${q}${hash ? `#${hash}` : ""}`;
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
// Direcciones anteriores: enlaces guardados, change_log y marcadores.
// ---------------------------------------------------------------------------

function querySuffix(req) {
  const i = req.originalUrl.indexOf("?");
  return i === -1 ? "" : req.originalUrl.slice(i);
}

router.get(/^\/vehiculos(\/.*)?$/, (req, res) => {
  const resto = req.params[0] || "";
  res.redirect(301, `${FLOTA}${resto}${querySuffix(req)}`);
});

router.get(/^\/checklists(\/.*)?$/, (req, res) => {
  const resto = req.params[0] || "";
  // El listado general ya no existe: lleva a Gestión de flota.
  if (!resto || resto === "/") return res.redirect(301, FLOTA);
  const destino = { "/nuevo": "/nueva", "/plantilla": "/items" }[resto] ?? resto;
  return res.redirect(301, `${MECANICA}${destino}${querySuffix(req)}`);
});

router.get("/flota/mecanica", (req, res) => res.redirect(301, FLOTA));

router.get("/flota/:id/historial", (req, res) => {
  const id = parseId(req.params.id);
  return id ? res.redirect(301, `${FLOTA}/${id}/revisiones`) : notFound(res);
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
const VER_FISICA = "logistica.fisica.ver";
const CREAR_FISICA = "logistica.fisica.crear";
const ANULAR_FISICA = "logistica.fisica.anular";
const REPARAR = "logistica.danio.reparar";

// A Gestión de flota entra quien ve la flota o quien registra o ve
// revisiones: el conductor llega por los botones de su vehículo.
const accesoFlota = requireAnyPermission(VER_FLOTA, VER, CREAR, VER_FISICA, CREAR_FISICA, REPARAR);

function permisosFlota(req) {
  const can = (key) => decide(req.perms, key, req.permLegacy);
  return {
    puedeAdministrar: can(ADMIN_FLOTA),
    puedeRevisar: can(CREAR),
    puedeRevisarFisica: can(CREAR_FISICA),
    puedeVerMecanicas: can(VER) || can(CREAR),
    puedeVerFisicas: can(VER_FISICA) || can(CREAR_FISICA),
    puedeVerDanios: can(VER_FISICA) || can(CREAR_FISICA) || can(REPARAR),
    puedeReparar: can(REPARAR),
    puedeVerRevisiones: can(VER) || can(CREAR) || can(VER_FISICA) || can(CREAR_FISICA) || can(REPARAR),
    puedePlantilla: can(PLANTILLA),
  };
}

/** Como checklistScope, para las revisiones físicas (sobre r.created_by). */
function fisicaScope(req) {
  const scope = req.perms.sqlFilter(VER_FISICA, { ownerColumn: "r.created_by" });
  if (scope.clause !== "FALSE") return scope;
  return { clause: "r.created_by = $1", params: [req.session.user.id] };
}

function puedeVerFisica(req, row) {
  if (decide(req.perms, VER_FISICA, req.permLegacy, { record: { ownerId: row.created_by } })) return true;
  return Number(row.created_by) === Number(req.session.user.id) && decide(req.perms, CREAR_FISICA, req.permLegacy);
}

/**
 * Un daño (y sus fotos) lo ve quien puede ver su revisión, quien repara y,
 * mientras está abierto, quien registra revisiones físicas: tiene que saber
 * qué ya estaba registrado para no repetirlo.
 */
function puedeVerDanio(req, damage) {
  if (puedeVerFisica(req, { created_by: damage.review_created_by })) return true;
  if (decide(req.perms, REPARAR, req.permLegacy)) return true;
  return damage.status === "abierto" && decide(req.perms, CREAR_FISICA, req.permLegacy);
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

async function formContext() {
  const [items, flota, conductores] = await Promise.all([
    template.listTemplateItems(),
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
    extraJs: ["/js/checklist-form.js?v=20261104a"],
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

// --- Configurar ítems: categorías y sus ítems -----------------------------------

async function renderTemplate(res, { errors = {}, values = {}, foco = null, status = 200, flash = {} }) {
  const categorias = await template.listCategories();
  res.status(status).render("logistica/flota/mecanica/items", {
    titulo: "Configurar ítems",
    categorias,
    errors,
    values,
    foco,
    ...flash,
    ...VIEW_HELPERS,
    extraCss: EXTRA_CSS,
    extraJs: ["/js/flota-items.js?v=20261104a"],
  });
}

/** Vuelve a la pantalla, a la altura de la categoría que se tocó. */
const volverA = (categoriaId) => (categoriaId ? `${ITEMS}#categoria-${categoriaId}` : ITEMS);

router.get("/flota/mecanica/items", requirePermission(PLANTILLA), async (req, res) => {
  try {
    await renderTemplate(res, { flash: flashFrom(req) });
  } catch (err) {
    console.error("[Logística] Error cargando la plantilla:", err);
    res.status(500).send("Error cargando la plantilla");
  }
});

router.post("/flota/mecanica/items/categorias", requirePermission(PLANTILLA), async (req, res) => {
  const { values, errors, ok } = template.normalizeCategoryInput(req.body);
  try {
    if (!ok) return await renderTemplate(res, { errors, values, foco: "nueva", status: 422 });
    const id = await template.createCategory(values);
    await logChange(req.session.user.id, `agregó la categoría «${values.name}» a la revisión mecánica`, ITEMS);
    res.redirect(withFlash(volverA(id), { ok: `Categoría «${values.name}» agregada` }));
  } catch (err) {
    if (err instanceof template.TemplateError) {
      return renderTemplate(res, { errors: { name: err.message }, values, foco: "nueva", status: 409 });
    }
    console.error("[Logística] Error agregando categoría:", err);
    res.status(500).send("Error guardando la categoría");
  }
});

router.post("/flota/mecanica/items/categorias/:id", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const { values, errors, ok } = template.normalizeCategoryInput(req.body);
  try {
    if (!ok) return await renderTemplate(res, { errors, values, foco: `categoria-${id}`, status: 422 });
    if (!(await template.renameCategory(id, values))) return notFound(res);
    await logChange(req.session.user.id, `renombró la categoría «${values.name}» de la revisión mecánica`, ITEMS);
    res.redirect(withFlash(volverA(id), { ok: "Categoría renombrada" }));
  } catch (err) {
    if (err instanceof template.TemplateError) {
      return renderTemplate(res, { errors: { name: err.message }, values, foco: `categoria-${id}`, status: 409 });
    }
    console.error("[Logística] Error renombrando categoría:", err);
    res.status(500).send("Error guardando la categoría");
  }
});

router.post("/flota/mecanica/items/categorias/:id/eliminar", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  try {
    const borrada = await template.deleteCategory(id);
    if (!borrada) return res.redirect(withFlash(ITEMS, { error: "La categoría ya no existe" }));
    await logChange(req.session.user.id, `eliminó la categoría «${borrada.name}» de la revisión mecánica`, ITEMS);
    res.redirect(withFlash(ITEMS, { ok: `Categoría «${borrada.name}» eliminada` }));
  } catch (err) {
    console.error("[Logística] Error eliminando categoría:", err);
    res.redirect(withFlash(ITEMS, { error: "No se pudo eliminar la categoría" }));
  }
});

router.post("/flota/mecanica/items/categorias/:id/mover", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  try {
    await template.moveCategory(id, req.body.direccion);
    res.redirect(volverA(id));
  } catch (err) {
    console.error("[Logística] Error moviendo categoría:", err);
    res.redirect(withFlash(ITEMS, { error: "No se pudo mover la categoría" }));
  }
});

router.post("/flota/mecanica/items/categorias/:id/items", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const { values, errors, ok } = template.normalizeItemInput(req.body);
  try {
    if (!ok) return await renderTemplate(res, { errors, values, foco: `nuevo-${id}`, status: 422 });
    if (!(await template.createItem(id, values))) return notFound(res);
    await logChange(req.session.user.id, `agregó el ítem «${values.label}» a la revisión mecánica`, ITEMS);
    res.redirect(withFlash(volverA(id), { ok: "Ítem agregado" }));
  } catch (err) {
    console.error("[Logística] Error agregando ítem:", err);
    res.status(500).send("Error guardando el ítem");
  }
});

router.post("/flota/mecanica/items/:id", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const categoria = parseId(req.body.categoria);
  const { values, errors, ok } = template.normalizeItemInput(req.body);
  try {
    if (!ok) return await renderTemplate(res, { errors, values, foco: `item-${id}`, status: 422 });
    if (!(await template.updateItem(id, values))) return notFound(res);
    await logChange(req.session.user.id, `editó el ítem «${values.label}» de la revisión mecánica`, ITEMS);
    res.redirect(withFlash(volverA(categoria), { ok: "Ítem actualizado" }));
  } catch (err) {
    console.error("[Logística] Error editando ítem:", err);
    res.status(500).send("Error guardando el ítem");
  }
});

router.post("/flota/mecanica/items/:id/eliminar", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const categoria = parseId(req.body.categoria);
  try {
    const borrado = await template.deleteItem(id);
    if (!borrado) return res.redirect(withFlash(volverA(categoria), { error: "El ítem ya no existe" }));
    await logChange(req.session.user.id, `eliminó el ítem «${borrado.label}» de la revisión mecánica`, ITEMS);
    res.redirect(withFlash(volverA(categoria), { ok: "Ítem eliminado" }));
  } catch (err) {
    console.error("[Logística] Error eliminando ítem:", err);
    res.redirect(withFlash(ITEMS, { error: "No se pudo eliminar el ítem" }));
  }
});

router.post("/flota/mecanica/items/:id/mover", requirePermission(PLANTILLA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  try {
    await template.moveItem(id, req.body.direccion);
    res.redirect(volverA(parseId(req.body.categoria)));
  } catch (err) {
    console.error("[Logística] Error moviendo ítem:", err);
    res.redirect(withFlash(ITEMS, { error: "No se pudo mover el ítem" }));
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
      extraJs: ["/js/flota-revisiones.js?v=20261104b"],
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
    await logChange(req.session.user.id, `editó el vehículo ${values.plate}`, `${FLOTA}/${vehiculo.id}/revisiones`);
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
      `${FLOTA}/${vehiculo.id}/revisiones`,
    );
    res.redirect(withFlash(FLOTA, {
      ok: activar ? `${vehiculo.plate} vuelve a la flota` : `${vehiculo.plate} quedó dado de baja`,
    }));
  } catch (err) {
    console.error("[Logística] Error cambiando estado del vehículo:", err);
    res.redirect(withFlash(FLOTA, { error: "No se pudo cambiar el estado del vehículo" }));
  }
});

// --- Revisiones y revisión física de un vehículo ---------------------------------

/**
 * Revisiones de un vehículo. Con ?parcial=1 (lo pide la tarjeta al
 * desplegarse) responde sólo las listas, sin la página.
 */
router.get("/flota/:id/revisiones", accesoFlota, async (req, res) => {
  try {
    const vehiculo = await loadVehicle(req, res);
    if (!vehiculo) return;
    const permisos = permisosFlota(req);
    const [mecanicas, fisicas, danios] = await Promise.all([
      checklists.listChecklists({ vehiculo: vehiculo.id, scope: checklistScope(req) }),
      physical.listPhysicalReviews({ vehiculo: vehiculo.id, scope: fisicaScope(req) }),
      permisos.puedeVerDanios ? physical.listDamages(vehiculo.id) : Promise.resolve([]),
    ]);
    const datos = {
      vehiculo,
      mecanicas,
      fisicas,
      danios,
      today: todayInCountry(),
      ...permisos,
      ...VIEW_HELPERS,
    };
    if (req.query.parcial === "1") {
      res.set("Cache-Control", "private, no-store");
      return res.render("logistica/flota/partials/revisiones_listas", { ...datos, compacto: true, layout: false });
    }
    res.render("logistica/flota/revisiones", {
      titulo: `Revisiones de ${vehiculo.plate}`,
      ...datos,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Logística] Error cargando las revisiones:", err);
    res.status(500).send("Error cargando las revisiones");
  }
});

// ---------------------------------------------------------------------------
// Revisión física y daños
// ---------------------------------------------------------------------------

// Las fotos llegan a un temporal en disco (no a memoria) y se procesan de a
// una. El teléfono las manda reducidas; el límite por archivo cubre una
// foto original si la reducción no corrió.
const uploadFotos = multer({
  dest: os.tmpdir(),
  limits: {
    fileSize: 12 * 1024 * 1024,
    files: MAX_DAMAGES * MAX_PHOTOS + CAPTURE_VIEWS.length,
    fields: 40,
    fieldSize: 64 * 1024,
  },
});

const esFetch = (req) => req.get("X-Requested-With") === "fetch";

/** Recibe los archivos; si exceden los límites responde un error legible. */
function recibirFotos(req, res, next) {
  uploadFotos.any()(req, res, (err) => {
    if (!err) return next();
    const mensaje = err.code === "LIMIT_FILE_SIZE"
      ? "Una de las fotos pesa más de 12 MB. Sácala de nuevo o elige otra."
      : err.code === "LIMIT_FILE_COUNT"
        ? `Son ${MAX_PHOTOS} fotos por daño como máximo.`
        : "No se pudieron recibir las fotos. Vuelve a intentarlo.";
    borrarTemporales(req);
    if (esFetch(req)) return res.status(413).json({ errors: { general: mensaje } });
    return res.status(413).send(mensaje);
  });
}

async function borrarTemporales(req) {
  await Promise.all((req.files || []).map((f) => fsp.unlink(f.path).catch(() => {})));
}

/** Archivos de un campo, en el orden en que llegaron. */
function archivosDe(req, campo) {
  return (req.files || []).filter((f) => f.fieldname === campo);
}

async function procesarArchivo(file, opciones) {
  const buffer = await fsp.readFile(file.path);
  return damagePhotos.processImage(buffer, opciones);
}

function leerDanios(raw) {
  try {
    const list = JSON.parse(String(raw || "[]"));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

router.get("/flota/:id/revision-fisica", accesoFlota, async (req, res) => {
  try {
    const vehiculo = await loadVehicle(req, res);
    if (!vehiculo) return;
    const permisos = permisosFlota(req);
    const [abiertos, conductores] = await Promise.all([
      permisos.puedeVerDanios
        ? physical.listDamages(vehiculo.id).then((l) => l.filter((d) => d.status === "abierto"))
        : Promise.resolve([]),
      permisos.puedeRevisarFisica ? checklists.listDrivers() : Promise.resolve([]),
    ]);
    res.render("logistica/flota/fisica", {
      titulo: `Revisión física de ${vehiculo.plate}`,
      vehiculo,
      modelo: modelFor(vehiculo.kind),
      grupos: ZONE_GROUPS,
      abiertos,
      conductores,
      driverOther: checklists.DRIVER_OTHER,
      today: todayInCountry(),
      values: {
        review_date: todayInCountry(),
        reason: "",
        driver_choice: String(req.session.user.id),
      },
      ...permisos,
      ...flashFrom(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Logística] Error cargando la revisión física:", err);
    res.status(500).send("Error cargando la revisión física");
  }
});

/**
 * Registra una revisión física. La manda el formulario por fetch (multipart):
 * campos, `danios` (JSON con zona, tipo y observación de cada daño nuevo),
 * foto_<i> por daño y captura_<vista> del modelo. Responde JSON.
 */
router.post("/flota/:id/revision-fisica", requirePermission(CREAR_FISICA), recibirFotos, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const vehiculo = id ? await vehicles.getVehicle(id) : null;
    if (!vehiculo) return res.status(404).json({ errors: { general: "El vehículo ya no existe." } });
    const modelo = modelFor(vehiculo.kind);
    if (!modelo) return res.status(409).json({ errors: { general: "El vehículo no tiene tipo: elígelo en la flota." } });

    const danios = leerDanios(req.body.danios);
    const photoCounts = danios.map((_, i) => archivosDe(req, physical.photoField(i)).length);
    const conductores = await checklists.listDrivers();
    const { values, errors, ok } = physical.normalizePhysicalInput(req.body, {
      vehicle: vehiculo,
      zones: modelo.zones,
      drivers: conductores,
      today: todayInCountry(),
      damages: danios,
      photoCounts,
    });
    if (!ok) return res.status(422).json({ errors });

    const damagePhotosList = [];
    for (let i = 0; i < values.damages.length; i += 1) {
      const lista = [];
      for (const file of archivosDe(req, physical.photoField(i))) {
        try {
          lista.push(await procesarArchivo(file));
        } catch (err) {
          if (err instanceof damagePhotos.PhotoError) {
            return res.status(422).json({ errors: { [physical.damageKey(i)]: err.message } });
          }
          throw err;
        }
      }
      damagePhotosList.push(lista);
    }
    // Las capturas son un apoyo del PDF: si una no sirve, se omite.
    const captures = {};
    for (const v of CAPTURE_VIEWS) {
      const [file] = archivosDe(req, physical.captureField(v.value));
      if (!file) continue;
      try {
        captures[v.value] = await procesarArchivo(file, { maxEdge: 1400 });
      } catch (err) {
        console.warn("[Logística] Captura del modelo descartada:", err.message);
      }
    }

    let creada;
    try {
      creada = await physical.createPhysicalReview(values, { damagePhotos: damagePhotosList, captures }, req.session.user.id);
    } catch (err) {
      if (err instanceof physical.PhysicalError) return res.status(409).json({ errors: { general: err.message } });
      throw err;
    }
    const link = `${FISICA}/${creada.id}`;
    await logChange(req.session.user.id, `registró la revisión física ${creada.number}`, link);
    const msg = creada.damages
      ? `Revisión ${creada.number} guardada con ${creada.damages} ${creada.damages === 1 ? "daño nuevo" : "daños nuevos"}`
      : `Revisión ${creada.number} guardada, sin daños nuevos`;
    res.json({ ok: true, redirect: withFlash(link, { ok: msg }) });
  } catch (err) {
    console.error("[Logística] Error registrando la revisión física:", err);
    res.status(500).json({ errors: { general: "No se pudo guardar la revisión. Vuelve a intentarlo." } });
  } finally {
    await borrarTemporales(req);
  }
});

async function loadFisicaVisible(req, res) {
  const id = parseId(req.params.id);
  const review = id ? await physical.getPhysicalReview(id) : null;
  if (!review) {
    notFound(res);
    return null;
  }
  if (!puedeVerFisica(req, review)) {
    res.status(403).render("acceso_no_permitido", { titulo: "Acceso no permitido" });
    return null;
  }
  return review;
}

router.get("/flota/fisica/:id", requireAnyPermission(VER_FISICA, CREAR_FISICA), async (req, res) => {
  try {
    const review = await loadFisicaVisible(req, res);
    if (!review) return;
    res.render("logistica/flota/fisica/detalle", {
      titulo: `Revisión física ${review.number}`,
      review,
      captureViews: CAPTURE_VIEWS,
      puedeAnular: decide(req.perms, ANULAR_FISICA, req.permLegacy),
      puedeReparar: decide(req.perms, REPARAR, req.permLegacy),
      ...flashFrom(req),
      ...VIEW_HELPERS,
      extraCss: EXTRA_CSS,
    });
  } catch (err) {
    console.error("[Logística] Error cargando la revisión física:", err);
    res.status(500).send("Error cargando la revisión física");
  }
});

/** Contenido de las imágenes del PDF; lo que Storage no entregue queda fuera. */
async function imagenesDelPdf(review) {
  const leer = (ruta) => damagePhotos.readStored(ruta).catch((err) => {
    console.warn("[Logística] Imagen no disponible para el PDF:", ruta, err.message);
    return null;
  });
  const captures = {};
  await Promise.all(Object.entries(review.captures || {}).map(async ([vista, ruta]) => {
    if (damagePhotos.isOwnPath(ruta)) captures[vista] = await leer(ruta);
  }));
  const rutas = await physical.photoPaths(review.damages.map((d) => d.id));
  const photos = new Map();
  const pendientes = [];
  for (const lista of rutas.values()) {
    lista.filter((p) => p.kind === "danio").forEach((p) => {
      pendientes.push(leer(p.storage_path).then((buf) => { if (buf) photos.set(String(p.id), buf); }));
    });
  }
  await Promise.all(pendientes);
  return { captures, photos };
}

router.get("/flota/fisica/:id/pdf", requireAnyPermission(VER_FISICA, CREAR_FISICA), async (req, res) => {
  try {
    const review = await loadFisicaVisible(req, res);
    if (!review) return;
    const buffer = await renderPhysicalPdf(review, await imagenesDelPdf(review));
    res.set("Content-Type", "application/pdf");
    res.set("Content-Disposition", `inline; filename="${review.number}.pdf"`);
    res.set("Cache-Control", "private, no-store");
    res.send(buffer);
  } catch (err) {
    console.error("[Logística] Error generando el PDF de la revisión física:", err);
    res.status(500).send("Error generando el PDF");
  }
});

async function enviarImagen(res, ruta) {
  if (!damagePhotos.isOwnPath(ruta)) return notFound(res);
  const buffer = await damagePhotos.readStored(ruta);
  res.set("Content-Type", "image/jpeg");
  res.set("Cache-Control", "private, max-age=86400");
  res.set("X-Content-Type-Options", "nosniff");
  return res.send(buffer);
}

router.get("/flota/fisica/:id/captura/:vista", requireAnyPermission(VER_FISICA, CREAR_FISICA), async (req, res) => {
  try {
    const review = await loadFisicaVisible(req, res);
    if (!review) return;
    const ruta = (review.captures || {})[req.params.vista];
    if (!ruta) return notFound(res);
    await enviarImagen(res, ruta);
  } catch (err) {
    console.error("[Logística] Error entregando la captura:", err);
    res.status(500).send("Error cargando la imagen");
  }
});

router.post("/flota/fisica/:id/anular", requirePermission(ANULAR_FISICA), async (req, res) => {
  const id = parseId(req.params.id);
  if (!id) return notFound(res);
  const link = `${FISICA}/${id}`;
  try {
    const anulada = await physical.voidPhysicalReview(id, req.body.motivo, req.session.user.id);
    if (!anulada) return res.redirect(withFlash(link, { error: "La revisión ya estaba anulada o no existe" }));
    await logChange(req.session.user.id, `anuló la revisión física ${anulada.number}`, link);
    res.redirect(withFlash(link, { ok: `Revisión ${anulada.number} anulada` }));
  } catch (err) {
    if (err instanceof physical.PhysicalError) return res.redirect(withFlash(link, { error: err.message }));
    console.error("[Logística] Error anulando la revisión física:", err);
    res.redirect(withFlash(link, { error: "No se pudo anular la revisión" }));
  }
});

// --- Daños --------------------------------------------------------------------

async function loadDanioVisible(req, res) {
  const id = parseId(req.params.id);
  const damage = id ? await physical.getDamage(id) : null;
  if (!damage) {
    notFound(res);
    return null;
  }
  if (!puedeVerDanio(req, damage)) {
    res.status(403).render("acceso_no_permitido", { titulo: "Acceso no permitido" });
    return null;
  }
  return damage;
}

function renderDanio(req, res, { damage, values = {}, errors = {}, status = 200 }) {
  res.status(status).render("logistica/flota/danio", {
    titulo: `${damage.zone_label} · ${damage.vehicle_plate}`,
    damage,
    values: { repaired_on: todayInCountry(), ...values },
    errors,
    today: todayInCountry(),
    puedeReparar: decide(req.perms, REPARAR, req.permLegacy),
    puedeVerSuRevision: puedeVerFisica(req, { created_by: damage.review_created_by }),
    ...flashFrom(req),
    ...VIEW_HELPERS,
    extraCss: EXTRA_CSS,
    extraJs: ["/js/flota-fotos.js?v=20261104a"],
  });
}

router.get("/flota/danios/:id", accesoFlota, async (req, res) => {
  try {
    const damage = await loadDanioVisible(req, res);
    if (!damage) return;
    renderDanio(req, res, { damage });
  } catch (err) {
    console.error("[Logística] Error cargando el daño:", err);
    res.status(500).send("Error cargando el daño");
  }
});

/**
 * Marca reparado un daño. Funciona como formulario normal (redirige) y por
 * fetch (responde JSON), que es como lo manda la página para reducir las
 * fotos en el teléfono antes de subirlas.
 */
router.post("/flota/danios/:id/reparar", requirePermission(REPARAR), recibirFotos, async (req, res) => {
  const responderErrores = (damage, values, errors, status) => (esFetch(req)
    ? res.status(status).json({ errors })
    : renderDanio(req, res, { damage, values, errors, status }));
  try {
    const id = parseId(req.params.id);
    const damage = id ? await physical.getDamage(id) : null;
    if (!damage) return esFetch(req) ? res.status(404).json({ errors: { general: "El daño ya no existe." } }) : notFound(res);
    const link = `${DANIOS}/${damage.id}`;
    if (damage.status !== "abierto") {
      const error = damage.status === "reparado" ? "Este daño ya estaba marcado como reparado." : "Este daño está anulado.";
      return esFetch(req) ? res.status(409).json({ errors: { general: error } }) : res.redirect(withFlash(link, { error }));
    }
    const archivos = archivosDe(req, "fotos");
    const { values, errors, ok } = physical.normalizeRepairInput(req.body, {
      today: todayInCountry(),
      reportedOn: damage.review_date,
      photoCount: archivos.length,
    });
    if (!ok) return responderErrores(damage, values, errors, 422);

    const fotos = [];
    for (const file of archivos) {
      try {
        fotos.push(await procesarArchivo(file));
      } catch (err) {
        if (err instanceof damagePhotos.PhotoError) return responderErrores(damage, values, { fotos: err.message }, 422);
        throw err;
      }
    }
    const reparado = await physical.repairDamage(damage.id, values, fotos, req.session.user.id);
    if (!reparado) {
      const error = "Alguien acaba de cambiar este daño. Revisa cómo quedó.";
      return esFetch(req) ? res.status(409).json({ errors: { general: error } }) : res.redirect(withFlash(link, { error }));
    }
    await logChange(req.session.user.id, `marcó reparado el daño «${damage.zone_label}» de ${damage.vehicle_plate}`, link);
    const destino = withFlash(link, { ok: "Daño marcado como reparado" });
    return esFetch(req) ? res.json({ ok: true, redirect: destino }) : res.redirect(destino);
  } catch (err) {
    console.error("[Logística] Error marcando el daño reparado:", err);
    const error = "No se pudo guardar la reparación. Vuelve a intentarlo.";
    return esFetch(req) ? res.status(500).json({ errors: { general: error } }) : res.status(500).send(error);
  } finally {
    await borrarTemporales(req);
  }
});

router.get("/flota/fotos/:id", accesoFlota, async (req, res) => {
  try {
    const id = parseId(req.params.id);
    const foto = id ? await physical.getPhoto(id) : null;
    if (!foto) return notFound(res);
    if (!puedeVerDanio(req, { review_created_by: foto.review_created_by, status: foto.damage_status })) {
      return res.status(403).send("No tienes permiso para ver esta foto");
    }
    await enviarImagen(res, foto.storage_path);
  } catch (err) {
    console.error("[Logística] Error entregando la foto:", err);
    res.status(500).send("Error cargando la foto");
  }
});

module.exports = router;
