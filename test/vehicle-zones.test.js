const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { GROUPS, MODELS, modelFor, zoneFor, mirrorShape, shapeBounds } = require("../src/constants/vehicleZones");
const { VEHICLE_KINDS } = require("../src/constants/vehicleChecklist");

const MATS = new Set(["body", "glass", "dark", "grille", "light", "tail"]);
const GRUPOS = new Set(GROUPS.map((g) => g.value));

function validShape(s) {
  const nums = (arr, n) => Array.isArray(arr) && arr.length === n && arr.every(Number.isFinite);
  if (!MATS.has(s.mat)) return false;
  if (s.type === "extrude") {
    return ["side", "front", "top"].includes(s.plane)
      && Array.isArray(s.points) && s.points.length >= 3 && s.points.every((p) => nums(p, 2))
      && s.depth > 0 && Number.isFinite(s.at)
      && (s.bevel == null || (s.bevel > 0 && 2 * s.bevel < s.depth));
  }
  if (!nums(s.pos, 3)) return false;
  if (s.type === "box") return nums(s.size, 3) && s.size.every((v) => v > 0) && (s.rotZ == null || Number.isFinite(s.rotZ));
  if (s.type === "wheel") return s.radius > 0 && s.width > 0;
  return false;
}

/** Área con signo (fórmula del cordón): 0 si el polígono está degenerado. */
function area(points) {
  let a = 0;
  for (let i = 0; i < points.length; i += 1) {
    const [x0, y0] = points[i];
    const [x1, y1] = points[(i + 1) % points.length];
    a += x0 * y1 - x1 * y0;
  }
  return a / 2;
}

describe("revisión física — modelos de los tres tipos", () => {
  it("cada tipo de vehículo tiene su modelo", () => {
    for (const { value } of VEHICLE_KINDS) assert.ok(modelFor(value), value);
    assert.equal(modelFor("automovil"), null);
    assert.equal(modelFor("toString"), null);
  });

  for (const [kind, model] of Object.entries(MODELS)) {
    describe(kind, () => {
      it("tiene entre 20 y 35 zonas con código único y snake_case", () => {
        assert.ok(model.zones.length >= 20 && model.zones.length <= 35, `${model.zones.length} zonas`);
        const codes = model.zones.map((z) => z.code);
        assert.equal(new Set(codes).size, codes.length, "códigos repetidos");
        for (const c of codes) assert.match(c, /^[a-z]+(_[a-z]+)*$/);
        const labels = model.zones.map((z) => z.label);
        assert.equal(new Set(labels).size, labels.length, "nombres repetidos");
      });

      it("cada zona tiene grupo y al menos una pieza bien formada", () => {
        for (const z of model.zones) {
          assert.ok(GRUPOS.has(z.group), `${z.code}: grupo ${z.group}`);
          assert.ok(z.shapes.length > 0, z.code);
          for (const s of z.shapes) assert.ok(validShape(s), `${z.code}: ${JSON.stringify(s)}`);
        }
        for (const s of model.decor) assert.ok(validShape(s), JSON.stringify(s));
      });

      it("todos los lados tienen zonas y la izquierda y la derecha van en espejo", () => {
        for (const g of GRUPOS) assert.ok(model.zones.some((z) => z.group === g), `${kind} sin zonas en ${g}`);
        for (const izq of model.zones.filter((z) => z.code.endsWith("_izq"))) {
          const der = zoneFor(kind, izq.code.replace(/_izq$/, "_der"));
          assert.ok(der, `${izq.code} sin pareja`);
          assert.match(izq.label, /izquierd[oa]s?$/);
          assert.match(der.label, /derech[oa]s?$/);
          assert.deepEqual(der.shapes, izq.shapes.map(mirrorShape));
          // Una pieza del lado izquierdo está a la izquierda (z > 0).
          for (const s of izq.shapes) assert.ok(shapeBounds(s).max[2] > 0, `${izq.code} no está a la izquierda`);
        }
      });

      it("los polígonos extruidos no están degenerados", () => {
        for (const s of [...model.decor, ...model.zones.flatMap((z) => z.shapes)]) {
          if (s.type === "extrude") assert.ok(Math.abs(area(s.points)) > 1e-4, JSON.stringify(s).slice(0, 120));
        }
      });

      it("las piezas caben dentro de las medidas del vehículo", () => {
        const margen = 0.35; // espejos y parachoques sobresalen un poco
        for (const z of model.zones) {
          for (const s of z.shapes) {
            const { min, max } = shapeBounds(s);
            assert.ok(min[0] >= -model.length / 2 - margen && max[0] <= model.length / 2 + margen, `${z.code} x`);
            assert.ok(min[1] >= 0 && max[1] <= model.height + margen, `${z.code} y`);
            assert.ok(min[2] >= -model.width / 2 - margen && max[2] <= model.width / 2 + margen, `${z.code} z`);
          }
        }
      });
    });
  }

  it("las zonas que se repiten entre modelos se llaman igual", () => {
    for (const code of ["parachoques_delantero", "parachoques_trasero", "parabrisas", "espejo_izq", "rueda_delantera_der", "foco_trasero_izq"]) {
      const labels = new Set(Object.keys(MODELS).map((k) => zoneFor(k, code)?.label));
      assert.equal(labels.size, 1, code);
    }
  });
});
