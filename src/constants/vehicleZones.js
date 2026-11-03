/**
 * Zonas de la revisión física: los modelos 3D de minivan, camioneta pickup y
 * camión, como datos. El navegador (public/js/flota-modelo.js) arma cada
 * pieza a partir de `shapes`; en la revisión física cada daño se guarda con
 * el `code` de su zona, así que un código publicado no se renombra.
 *
 * Ejes, en metros: x hacia el frente del vehículo, y hacia arriba, z hacia
 * el lado izquierdo (el del conductor). El suelo está en y = 0. Ojo: en
 * three.js +z es la derecha; el visor invierte z al ubicar las piezas.
 *
 * Una forma es { type: 'box', size: [x, y, z], pos: [x, y, z], rotZ? } o
 * { type: 'wheel', radius, width, pos }, con un `mat` para el color:
 *   body (carrocería), glass, dark (plásticos y neumáticos), grille,
 *   light (faros), tail (focos traseros).
 * Las zonas del lado izquierdo se escriben una vez y el derecho sale en
 * espejo (z → -z, "izquierdo" → "derecho").
 */

const GROUPS = Object.freeze([
  { value: "frente", label: "Frente" },
  { value: "izquierdo", label: "Lado izquierdo (conductor)" },
  { value: "derecho", label: "Lado derecho" },
  { value: "atras", label: "Atrás" },
  { value: "arriba", label: "Arriba" },
]);

const box = (size, pos, mat = "body", extra = {}) => ({ type: "box", size, pos, mat, ...extra });
const wheel = (pos, radius, width) => ({ type: "wheel", radius, width, pos, mat: "dark" });

/**
 * Zona del lado izquierdo y su espejo del lado derecho. `fin` concuerda el
 * lado con la pieza: "o" (espejo izquierdo), "a" (puerta izquierda) o "as"
 * (ruedas traseras izquierdas).
 */
function pair(code, label, shapes, fin = "o") {
  const mirror = (s) => ({ ...s, pos: [s.pos[0], s.pos[1], -s.pos[2]] });
  return [
    { code: `${code}_izq`, label: `${label} izquierd${fin}`, group: "izquierdo", shapes },
    { code: `${code}_der`, label: `${label} derech${fin}`, group: "derecho", shapes: shapes.map(mirror) },
  ];
}

/** Par de piezas que no son de un costado (faros, focos): mismo grupo. */
function pairSameGroup(code, label, group, shapes, fin = "o") {
  return pair(code, label, shapes, fin).map((z) => ({ ...z, group }));
}

// ---------------------------------------------------------------------------
// Camioneta pickup, doble cabina (5,3 × 1,85 × 1,85 m)
// ---------------------------------------------------------------------------

function pickup() {
  const W = 1.85;
  const zr = W / 2;
  const zones = [
    { code: "parachoques_delantero", label: "Parachoques delantero", group: "frente", shapes: [box([0.2, 0.3, 1.86], [2.62, 0.5, 0], "dark")] },
    { code: "parrilla", label: "Parrilla", group: "frente", shapes: [box([0.05, 0.3, 1.1], [2.6, 0.82, 0], "grille")] },
    ...pairSameGroup("faro_delantero", "Faro delantero", "frente", [box([0.05, 0.15, 0.3], [2.6, 0.85, 0.7], "light")]),
    { code: "capo", label: "Capó", group: "frente", shapes: [box([1.06, 0.05, 1.7], [2.05, 1.07, 0])] },
    { code: "parabrisas", label: "Parabrisas", group: "frente", shapes: [box([0.04, 0.8, 1.62], [1.33, 1.45, 0], "glass", { rotZ: 0.45 })] },
    ...pair("tapabarro_delantero", "Tapabarro delantero", [box([1.06, 0.52, 0.04], [2.05, 0.8, zr + 0.01])]),
    ...pair("puerta_delantera", "Puerta delantera", [
      box([0.95, 0.62, 0.04], [1.0, 0.82, zr + 0.01]),
      box([0.78, 0.42, 0.04], [0.98, 1.38, zr - 0.08], "glass"),
    ], "a"),
    ...pair("puerta_trasera", "Puerta trasera", [
      box([0.92, 0.62, 0.04], [0.05, 0.82, zr + 0.01]),
      box([0.8, 0.42, 0.04], [0.05, 1.38, zr - 0.08], "glass"),
    ], "a"),
    ...pair("espejo", "Espejo", [box([0.12, 0.13, 0.2], [1.38, 1.3, zr + 0.12], "dark")]),
    ...pair("tolva_costado", "Costado de la tolva", [box([2.2, 0.55, 0.05], [-1.55, 0.82, zr - 0.02])]),
    ...pair("rueda_delantera", "Rueda delantera", [wheel([1.75, 0.38, zr - 0.13], 0.38, 0.28)], "a"),
    ...pair("rueda_trasera", "Rueda trasera", [wheel([-1.55, 0.38, zr - 0.13], 0.38, 0.28)], "a"),
    { code: "techo", label: "Techo", group: "arriba", shapes: [box([1.6, 0.05, 1.62], [0.4, 1.83, 0])] },
    { code: "tolva_piso", label: "Piso de la tolva", group: "arriba", shapes: [box([2.15, 0.04, 1.72], [-1.55, 0.62, 0], "dark")] },
    { code: "luneta", label: "Vidrio trasero de la cabina", group: "atras", shapes: [box([0.04, 0.55, 1.5], [-0.43, 1.42, 0], "glass")] },
    { code: "portalon", label: "Portalón", group: "atras", shapes: [box([0.05, 0.55, 1.8], [-2.66, 0.82, 0])] },
    { code: "parachoques_trasero", label: "Parachoques trasero", group: "atras", shapes: [box([0.16, 0.22, 1.86], [-2.74, 0.48, 0], "dark")] },
    ...pairSameGroup("foco_trasero", "Foco trasero", "atras", [box([0.05, 0.3, 0.12], [-2.69, 0.9, 0.86], "tail")]),
  ];
  const decor = [
    box([1.08, 0.56, 1.8], [2.05, 0.78, 0]), // frente bajo el capó
    box([1.95, 0.6, 1.83], [0.53, 0.8, 0]), // parte baja de la cabina
    box([1.55, 0.72, 1.6], [0.4, 1.45, 0], "glass"), // vidrios laterales
    box([0.08, 0.55, 1.83], [-0.48, 0.82, 0]), // frente de la tolva
    box([4.9, 0.18, 1.3], [0, 0.42, 0], "dark"), // chasis
  ];
  return { length: 5.4, width: W, height: 1.85, zones, decor };
}

// ---------------------------------------------------------------------------
// Minivan / furgón (5,0 × 1,95 × 2,1 m)
// ---------------------------------------------------------------------------

function minivan() {
  const W = 1.95;
  const zr = W / 2;
  const zones = [
    { code: "parachoques_delantero", label: "Parachoques delantero", group: "frente", shapes: [box([0.18, 0.32, 1.96], [2.52, 0.5, 0], "dark")] },
    { code: "parrilla", label: "Parrilla", group: "frente", shapes: [box([0.05, 0.28, 1.1], [2.52, 0.84, 0], "grille")] },
    ...pairSameGroup("faro_delantero", "Faro delantero", "frente", [box([0.05, 0.16, 0.34], [2.5, 0.92, 0.72], "light")]),
    { code: "capo", label: "Capó", group: "frente", shapes: [box([0.64, 0.05, 1.8], [2.2, 1.08, 0])] },
    { code: "parabrisas", label: "Parabrisas", group: "frente", shapes: [box([0.04, 0.98, 1.8], [1.66, 1.52, 0], "glass", { rotZ: 0.5 })] },
    ...pair("tapabarro_delantero", "Tapabarro delantero", [box([0.64, 0.56, 0.04], [2.2, 0.8, zr + 0.01])]),
    ...pair("puerta_delantera", "Puerta delantera", [
      box([1.0, 0.85, 0.04], [1.32, 0.95, zr + 0.01]),
      box([0.6, 0.45, 0.04], [1.15, 1.62, zr + 0.01], "glass"),
    ], "a"),
    ...pair("puerta_lateral", "Puerta lateral", [
      box([1.18, 0.85, 0.04], [0.2, 0.95, zr + 0.01]),
      box([1.0, 0.48, 0.04], [0.2, 1.62, zr + 0.01], "glass"),
    ], "a"),
    ...pair("costado_trasero", "Costado trasero", [
      box([2.0, 0.85, 0.04], [-1.42, 0.95, zr + 0.01]),
      box([1.75, 0.48, 0.04], [-1.42, 1.62, zr + 0.01], "glass"),
    ]),
    ...pair("espejo", "Espejo", [box([0.12, 0.17, 0.22], [1.78, 1.42, zr + 0.13], "dark")]),
    ...pair("rueda_delantera", "Rueda delantera", [wheel([1.92, 0.35, zr - 0.14], 0.35, 0.26)], "a"),
    ...pair("rueda_trasera", "Rueda trasera", [wheel([-1.58, 0.35, zr - 0.14], 0.35, 0.26)], "a"),
    { code: "techo", label: "Techo", group: "arriba", shapes: [box([3.92, 0.05, 1.88], [-0.52, 2.08, 0])] },
    { code: "puerta_trasera", label: "Puertas traseras", group: "atras", shapes: [
      box([0.04, 1.0, 1.84], [-2.5, 1.02, 0]),
      box([0.04, 0.48, 1.55], [-2.5, 1.74, 0], "glass"),
    ] },
    { code: "parachoques_trasero", label: "Parachoques trasero", group: "atras", shapes: [box([0.16, 0.25, 1.96], [-2.55, 0.48, 0], "dark")] },
    ...pairSameGroup("foco_trasero", "Foco trasero", "atras", [box([0.05, 0.42, 0.12], [-2.52, 1.08, 0.9], "tail")]),
  ];
  const decor = [
    box([0.64, 0.58, 1.9], [2.2, 0.79, 0]), // frente bajo el capó
    box([4.38, 0.58, 1.92], [-0.29, 0.79, 0]), // carrocería, bajo la línea del capó
    box([3.9, 0.98, 1.92], [-0.53, 1.57, 0]), // carrocería, desde el parabrisas hacia atrás
    box([4.7, 0.16, 1.3], [0, 0.42, 0], "dark"), // chasis
  ];
  return { length: 5.2, width: W, height: 2.1, zones, decor };
}

// ---------------------------------------------------------------------------
// Camión con caja (7,0 × 2,3 × 3,45 m)
// ---------------------------------------------------------------------------

function camion() {
  const W = 2.3;
  const zr = W / 2;
  const zones = [
    { code: "parachoques_delantero", label: "Parachoques delantero", group: "frente", shapes: [box([0.2, 0.35, 2.3], [3.52, 0.75, 0], "dark")] },
    { code: "parrilla", label: "Parrilla", group: "frente", shapes: [box([0.05, 0.62, 1.4], [3.46, 1.38, 0], "grille")] },
    ...pairSameGroup("faro_delantero", "Faro delantero", "frente", [box([0.05, 0.2, 0.38], [3.46, 1.15, 0.86], "light")]),
    { code: "parabrisas", label: "Parabrisas", group: "frente", shapes: [box([0.05, 0.82, 2.0], [3.42, 2.22, 0], "glass", { rotZ: 0.12 })] },
    ...pair("puerta", "Puerta", [
      box([1.1, 1.0, 0.04], [2.75, 1.45, zr - 0.04]),
      box([0.85, 0.6, 0.04], [2.78, 2.27, zr - 0.04], "glass"),
    ], "a"),
    ...pair("espejo", "Espejo", [box([0.1, 0.45, 0.12], [3.3, 2.15, zr + 0.18], "dark")]),
    ...pair("caja_costado", "Costado de la caja", [box([5.35, 2.3, 0.04], [-0.82, 2.25, zr + 0.01])]),
    ...pair("rueda_delantera", "Rueda delantera", [wheel([2.75, 0.5, zr - 0.2], 0.5, 0.32)], "a"),
    ...pair("rueda_trasera", "Ruedas traseras", [
      wheel([-2.2, 0.5, zr - 0.18], 0.5, 0.3),
      wheel([-2.2, 0.5, zr - 0.52], 0.5, 0.3),
    ], "as"),
    { code: "estanque_combustible", label: "Estanque de combustible", group: "izquierdo", shapes: [box([0.95, 0.42, 0.42], [1.2, 0.85, 0.78], "grille")] },
    { code: "techo_cabina", label: "Techo de la cabina", group: "arriba", shapes: [box([1.4, 0.05, 2.2], [2.72, 2.84, 0])] },
    { code: "caja_frente", label: "Frente de la caja", group: "arriba", shapes: [box([0.04, 0.55, 2.3], [1.87, 3.12, 0])] },
    { code: "caja_techo", label: "Techo de la caja", group: "arriba", shapes: [box([5.35, 0.05, 2.32], [-0.82, 3.42, 0])] },
    { code: "caja_puertas", label: "Puertas de la caja", group: "atras", shapes: [box([0.05, 2.3, 2.3], [-3.52, 2.25, 0])] },
    { code: "parachoques_trasero", label: "Parachoques trasero", group: "atras", shapes: [box([0.15, 0.2, 2.2], [-3.5, 0.82, 0], "dark")] },
    ...pairSameGroup("foco_trasero", "Foco trasero", "atras", [box([0.05, 0.15, 0.32], [-3.58, 0.98, 0.9], "tail")]),
  ];
  const decor = [
    box([1.42, 1.95, 2.24], [2.75, 1.85, 0]), // cabina
    box([5.35, 2.3, 2.3], [-0.82, 2.25, 0]), // caja
    box([6.9, 0.25, 1.0], [0, 0.75, 0], "dark"), // chasis
  ];
  return { length: 7.2, width: W, height: 3.45, zones, decor };
}

const MODELS = Object.freeze({
  minivan: minivan(),
  pickup: pickup(),
  camion: camion(),
});

/** Modelo de un tipo de vehículo, o null si el tipo no tiene modelo. */
function modelFor(kind) {
  return Object.prototype.hasOwnProperty.call(MODELS, kind) ? MODELS[kind] : null;
}

/** Zona de un tipo por su código. */
function zoneFor(kind, code) {
  const model = modelFor(kind);
  return model ? model.zones.find((z) => z.code === code) || null : null;
}

module.exports = {
  GROUPS,
  MODELS,
  modelFor,
  zoneFor,
};
