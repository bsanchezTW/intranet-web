const express = require("express");
const router = express.Router();

const db = require("../db");
const requireRole = require("../middlewares/requireRole");
const service = require("../services/costCenters/costCenterService");
const { formatNationalId } = require("../utils/nationalId");
const { getDocumentConfig } = require("../config/country");

/**
 * RR.HH. · Centros de costo.
 *
 * Se monta bajo /RRHH/centros-costo. Mismo contrato que el resto del módulo:
 * formulario POST, redirect y flash en el querystring.
 *
 * Ojo con la distinción que da sentido a toda la pantalla: el área agrupa a las
 * personas (una sola por colaborador, define quién aprueba) y el centro de
 * costo agrupa el gasto (uno o dos, define a qué bolsillo se carga).
 */

const BASE = "/RRHH/centros-costo";

function redirectOk(res, msg) {
  return res.redirect(`${BASE}?ok=1&msg=${encodeURIComponent(msg)}`);
}

function redirectError(res, msg) {
  return res.redirect(`${BASE}?error=${encodeURIComponent(msg)}`);
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

/** Resuelve un resultado { ok, error } del servicio a un redirect con flash. */
function resolver(res, result, mensajeOk) {
  if (!result.ok) return redirectError(res, result.error);
  return redirectOk(res, mensajeOk);
}

router.get("/", async (req, res) => {
  try {
    const [centros, peopleResult] = await Promise.all([
      service.listCostCentersWithMembers(),
      db.query(
        `SELECT u.id, u.first_name, u.last_name, u.national_id,
                w.area_name,
                COUNT(uc.cost_center_id)::int AS centros_asignados
           FROM users u
           LEFT JOIN work_areas w ON w.id = u.work_area_id
           LEFT JOIN user_cost_centers uc ON uc.user_id = u.id
          WHERE u.is_intranet_user = TRUE
          GROUP BY u.id, u.first_name, u.last_name, u.national_id, w.area_name
          ORDER BY u.last_name ASC NULLS LAST, u.first_name ASC`,
      ),
    ]);

    const people = peopleResult.rows.map((row) => ({
      id: row.id,
      nombre:
        [row.first_name, row.last_name].filter(Boolean).join(" ").trim() ||
        `Usuario ${row.id}`,
      areaName: row.area_name || null,
      documento: formatNationalId(row.national_id),
      centrosAsignados: row.centros_asignados,
      // Con el tope alcanzado el nombre sigue en la lista pero no se puede
      // elegir: ocultarlo haría pensar que el colaborador no existe.
      alTope: row.centros_asignados >= service.MAX_COST_CENTERS_PER_USER,
    }));

    const sinCentro = people.filter((p) => p.centrosAsignados === 0).length;

    res.render("RRHH/centros_costo", {
      titulo: "Centros de costo",
      centros,
      people,
      sinCentro,
      maxPorUsuario: service.MAX_COST_CENTERS_PER_USER,
      documentoLabel: getDocumentConfig().label,
      ...flashFrom(req),
      user: req.session.user,
      extraCss: ["/css/areas.css?v=20260916m", "/css/gastos.css?v=20260916m", "/css/procesos.css?v=20260916m"],
      extraJs: ["/js/ac-cards.js?v=20260916m", "/js/centros-costo.js?v=20260916m"],
    });
  } catch (err) {
    console.error("[Centros de costo] Error listando:", err);
    res.status(500).send("Error consultando los centros de costo");
  }
});

router.post("/", requireRole.administrador(), async (req, res) => {
  try {
    const result = await service.createCostCenter({
      code: req.body.code,
      name: req.body.name,
    });
    return resolver(res, result, "Centro de costo creado.");
  } catch (err) {
    console.error("[Centros de costo] Error creando:", err);
    return redirectError(res, "No se pudo crear el centro de costo.");
  }
});

router.post("/:id", requireRole.administrador(), async (req, res) => {
  try {
    const result = await service.updateCostCenter(req.params.id, {
      code: req.body.code,
      name: req.body.name,
      // Un checkbox ausente significa desmarcado, no "sin cambios".
      active: req.body.active === "on" || req.body.active === "true",
    });
    return resolver(res, result, "Centro de costo actualizado.");
  } catch (err) {
    console.error("[Centros de costo] Error actualizando:", err);
    return redirectError(res, "No se pudo actualizar el centro de costo.");
  }
});

router.post("/:id/estado", requireRole.administrador(), async (req, res) => {
  const activar = req.body.active === "true";
  try {
    const result = await service.setCostCenterActive(req.params.id, activar);
    return resolver(
      res,
      result,
      activar ? "Centro de costo reactivado." : "Centro de costo desactivado.",
    );
  } catch (err) {
    console.error("[Centros de costo] Error cambiando estado:", err);
    return redirectError(res, "No se pudo cambiar el estado del centro.");
  }
});

router.post("/:id/eliminar", requireRole.administrador(), async (req, res) => {
  try {
    const result = await service.deleteCostCenter(req.params.id);
    return resolver(res, result, "Centro de costo eliminado.");
  } catch (err) {
    console.error("[Centros de costo] Error eliminando:", err);
    return redirectError(res, "No se pudo eliminar el centro de costo.");
  }
});

router.post("/:id/miembros", requireRole.administrador(), async (req, res) => {
  // El modal manda una casilla por persona; el envío de un solo valor también
  // llega aquí y assignUsers lo trata igual.
  const userIds = [].concat(req.body.user_id || []);
  try {
    const result = await service.assignUsers(req.params.id, userIds);
    if (!result.ok) {
      return redirectError(res, result.error || result.fallos[0]);
    }

    const parcial = result.asignados < result.total;
    const cuantos =
      result.asignados === 1
        ? "Colaborador asignado al centro de costo."
        : `${result.asignados} colaboradores asignados al centro de costo.`;
    // Cuando alguien se queda fuera (por ejemplo por el tope de centros) hay
    // que decirlo: el resto sí entró y el conteo de la tarjeta va a cuadrar.
    return redirectOk(
      res,
      parcial ? `${cuantos} ${result.fallos[0]}` : cuantos,
    );
  } catch (err) {
    console.error("[Centros de costo] Error asignando colaborador:", err);
    return redirectError(res, "No se pudo asignar el colaborador.");
  }
});

router.post(
  "/:id/miembros/:userId/quitar",
  requireRole.administrador(),
  async (req, res) => {
    try {
      const result = await service.removeUser(req.params.id, req.params.userId);
      return resolver(res, result, "Colaborador quitado del centro de costo.");
    } catch (err) {
      console.error("[Centros de costo] Error quitando colaborador:", err);
      return redirectError(res, "No se pudo quitar el colaborador.");
    }
  },
);

module.exports = router;
