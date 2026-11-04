/**
 * Zonas de la revisión física: los modelos 3D de minivan, camioneta pickup y
 * camión, como datos. El navegador (public/js/flota-modelo.js) arma cada
 * pieza a partir de `shapes`; en la revisión física cada daño se guarda con
 * el `code` de su zona, así que un código publicado no se renombra.
 *
 * Referencias: minivan = Maxus eDeliver 3 corta (4,56 × 1,78 × 1,90 m,
 * 2,91 m entre ejes), pickup = Mitsubishi L200 doble cabina 2024 (5,32 ×
 * 1,865 × 1,795 m, 3,13 m entre ejes) y camión de cabina avanzada con caja.
 *
 * Ejes, en metros: x hacia el frente del vehículo, y hacia arriba, z hacia
 * el lado izquierdo (el del conductor). El suelo está en y = 0. Ojo: en
 * three.js +z es la derecha; el visor invierte z al ubicar las piezas.
 *
 * Formas (`mat` es el color: body, glass, dark, grille, light, tail):
 *   { type: 'box', size: [x, y, z], pos: [x, y, z], rotZ? }
 *   { type: 'wheel', radius, width, pos }
 *   { type: 'extrude', plane, points, depth, at, bevel? }
 *     Un polígono extruido. plane 'side': puntos (x, y), se extruye a lo
 *     ancho (z) centrado en `at`; 'front': puntos (z, y), a lo largo (x)
 *     centrado en x = `at`; 'top': puntos (x, z), hacia arriba centrado en
 *     y = `at`. `bevel` redondea los bordes de la extrusión.
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

// ---------------------------------------------------------------------------
// Ayudas de dibujo (puras; devuelven datos)
// ---------------------------------------------------------------------------

const box = (size, pos, mat = "body", extra = {}) => ({ type: "box", size, pos, mat, ...extra });
const wheel = (pos, radius, width) => ({ type: "wheel", radius, width, pos, mat: "dark" });
const extrude = (plane, points, depth, at, mat = "body", bevel = 0) => ({
  type: "extrude", plane, points: points.map(([a, b]) => [round3(a), round3(b)]), depth, at, mat, ...(bevel ? { bevel } : {}),
});
/** Panel delgado pegado al costado izquierdo de una carrocería de ancho `w`. */
const sidePanel = (points, w, mat = "body") => extrude("side", points, 0.012, w / 2 + 0.008, mat);
/**
 * Vidrio del costado: un poco más afuera que los paneles, para que no
 * parpadee cuando queda sobre una puerta (dos caras en el mismo plano).
 */
const sideGlass = (points, w) => extrude("side", points, 0.012, w / 2 + 0.022, "glass");

function round3(n) {
  return Math.round(n * 1000) / 1000;
}

/**
 * Polígono con esquinas redondeadas: cada punto es [x, y] (esquina viva) o
 * [x, y, r] (redondeada con radio r, aproximado con una curva de Bézier).
 */
function rounded(pts) {
  const out = [];
  const n = pts.length;
  for (let i = 0; i < n; i += 1) {
    const [x, y, r] = pts[i];
    if (!r) { out.push([x, y]); continue; }
    const [ax, ay] = pts[(i - 1 + n) % n];
    const [bx, by] = pts[(i + 1) % n];
    const la = Math.hypot(ax - x, ay - y);
    const lb = Math.hypot(bx - x, by - y);
    const t = Math.min(r, la / 2, lb / 2);
    const s = [x + ((ax - x) / la) * t, y + ((ay - y) / la) * t];
    const e = [x + ((bx - x) / lb) * t, y + ((by - y) / lb) * t];
    for (let k = 0; k <= 4; k += 1) {
      const u = k / 4;
      out.push([
        (1 - u) ** 2 * s[0] + 2 * (1 - u) * u * x + u ** 2 * e[0],
        (1 - u) ** 2 * s[1] + 2 * (1 - u) * u * y + u ** 2 * e[1],
      ]);
    }
  }
  return out;
}

/**
 * Paso de rueda: arco de radio r con centro (cx, cy) que corta la línea
 * inferior de la carrocería en y = base. Va del lado delantero al trasero,
 * como se recorre el borde inferior del perfil.
 */
function arch(cx, cy, r, base) {
  const a0 = Math.asin(Math.max(-1, Math.min(1, (base - cy) / r)));
  const pts = [];
  for (let k = 0; k <= 12; k += 1) {
    const a = a0 + ((Math.PI - 2 * a0) * k) / 12;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return pts;
}

/** Banda de un arco (aletas de los pasos de rueda): de rIn a rOut. */
function archBand(cx, cy, rIn, rOut, base) {
  const fuera = arch(cx, cy, rOut, base);
  const dentro = arch(cx, cy, rIn, base).reverse();
  return [...fuera, ...dentro];
}

/**
 * Cinta que sigue una línea del perfil (capó, parabrisas, techo) con grosor
 * t hacia afuera. Los puntos van de atrás hacia adelante: así la normal de la
 * izquierda de cada tramo mira hacia arriba y hacia el frente.
 */
function ribbon(points, t) {
  const normal = (i) => {
    const [x0, y0] = points[Math.max(0, i - 1)];
    const [x1, y1] = points[Math.min(points.length - 1, i + 1)];
    const l = Math.hypot(x1 - x0, y1 - y0);
    return [-(y1 - y0) / l, (x1 - x0) / l];
  };
  const fuera = points.map(([x, y], i) => { const [nx, ny] = normal(i); return [x + nx * t, y + ny * t]; });
  return [...points, ...fuera.reverse()];
}

/** Espejo de una forma: del lado izquierdo al derecho. */
function mirrorShape(s) {
  if (s.type !== "extrude") return { ...s, pos: [s.pos[0], s.pos[1], -s.pos[2]] };
  if (s.plane === "side") return { ...s, at: -s.at };
  if (s.plane === "front") return { ...s, points: s.points.map(([z, y]) => [-z, y]) };
  return { ...s, points: s.points.map(([x, z]) => [x, -z]) };
}

/**
 * Zona del lado izquierdo y su espejo del lado derecho. `fin` concuerda el
 * lado con la pieza: "o" (espejo izquierdo), "a" (puerta izquierda) o "as"
 * (ruedas traseras izquierdas).
 */
function pair(code, label, shapes, fin = "o") {
  return [
    { code: `${code}_izq`, label: `${label} izquierd${fin}`, group: "izquierdo", shapes },
    { code: `${code}_der`, label: `${label} derech${fin}`, group: "derecho", shapes: shapes.map(mirrorShape) },
  ];
}

/** Par de piezas que no son de un costado (faros, focos): mismo grupo. */
function pairSameGroup(code, label, group, shapes, fin = "o") {
  return pair(code, label, shapes, fin).map((z) => ({ ...z, group }));
}

// ---------------------------------------------------------------------------
// Minivan / furgón Maxus (4,56 × 1,78 × 1,90 m; 2,91 m entre ejes)
// Capó corto y frente alto: parachoques del color de la carrocería con toma
// de aire negra, parrilla negra y faros grandes que suben al tapabarro. El
// parabrisas nace casi sobre la rueda delantera; ventanas en la puerta
// delantera, la corredera, el costado y atrás.
//
// La carrocería lleva bisel de BISEL: su cara lateral plana termina BISEL
// antes de la silueta, así que los paneles del costado se dibujan al menos
// eso por dentro (si no, flotan por fuera del pilar o del techo).
// ---------------------------------------------------------------------------

function minivan() {
  const W = 1.76;
  const R = 0.33; // rueda 195/70 R15
  const ejeD = 1.55;
  const ejeT = -1.36;
  const base = 0.3;
  const BISEL = 0.06;
  const cintura = 1.26; // borde inferior de las ventanas
  const ventanaArriba = 1.74;
  const perfil = rounded([
    [-2.26, base, 0.05],
    [-2.26, 1.86, 0.16],
    [0.95, 1.9, 0.24],
    [1.72, 1.02, 0.1],
    [2.18, 0.94, 0.14],
    [2.3, 0.66, 0.1],
    [2.26, base, 0.05],
  ]);
  const cuerpo = [...perfil, ...arch(ejeD, R, 0.45, base), ...arch(ejeT, R, 0.45, base)];
  // Línea del parabrisas (de [0.95, 1.9] a [1.72, 1.02]) y la del pilar, ya
  // por dentro de la cara lateral.
  const parabrisasY = (x) => 1.9 - (x - 0.95) * 1.143;
  const pilarY = (x) => parabrisasY(x) - 0.1;
  const pilarX = (y) => 0.95 + (1.9 - 0.1 - y) / 1.143;

  const zones = [
    { code: "parachoques_delantero", label: "Parachoques delantero", group: "frente", shapes: [
      box([0.14, 0.34, W - 0.04], [2.25, 0.47, 0]),
      box([0.03, 0.1, 0.9], [2.325, 0.42, 0], "dark"), // toma de aire
    ] },
    { code: "parrilla", label: "Parrilla", group: "frente", shapes: [box([0.03, 0.17, 0.86], [2.252, 0.8, 0], "dark", { rotZ: 0.4 })] },
    ...pairSameGroup("faro_delantero", "Faro delantero", "frente", [
      box([0.04, 0.13, 0.4], [2.222, 0.85, 0.63], "light", { rotZ: 0.4 }),
      box([0.3, 0.1, 0.03], [2.1, 0.88, W / 2 - BISEL / 2], "light", { rotZ: 0.2 }), // se abre hacia el tapabarro
    ]),
    { code: "capo", label: "Capó", group: "frente", shapes: [extrude("side", ribbon([[1.74, 1.02], [1.98, 0.99], [2.16, 0.95]], 0.025), W - 0.16, 0)] },
    { code: "parabrisas", label: "Parabrisas", group: "frente", shapes: [extrude("side", ribbon([[0.97, 1.878], [1.35, 1.444], [1.7, 1.044]], 0.025), W - 0.16, 0, "glass")] },
    ...pair("tapabarro_delantero", "Tapabarro delantero", [sidePanel(rounded([
      [1.74, 0.8], [1.88, 0.7], [1.97, 0.58], [2.2, 0.58], [2.22, 0.68, 0.04], [2.12, 0.88, 0.04], [1.76, 0.95],
    ]), W)]),
    ...pair("puerta_delantera", "Puerta delantera", [
      sidePanel(rounded([
        [0.96, 0.36], [1.07, 0.36], [1.16, 0.62], [1.33, 0.76], [1.52, 0.8], [1.68, 0.79],
        [1.68, pilarY(1.68) + 0.02], [pilarX(cintura - 0.02), cintura - 0.02], [0.96, cintura - 0.02, 0.03],
      ]), W),
      sideGlass(rounded([
        [0.99, cintura + 0.02], [pilarX(cintura + 0.02) - 0.03, cintura + 0.02],
        [pilarX(ventanaArriba) - 0.02, ventanaArriba, 0.03], [0.99, ventanaArriba, 0.03],
      ]), W),
    ], "a"),
    ...pair("puerta_lateral", "Puerta lateral", [
      sidePanel(rounded([[-0.44, 0.36, 0.03], [0.92, 0.36, 0.03], [0.92, 1.8, 0.05], [-0.44, 1.8, 0.05]]), W),
      sideGlass(rounded([[-0.38, cintura + 0.02, 0.04], [0.86, cintura + 0.02, 0.04], [0.86, ventanaArriba, 0.05], [-0.38, ventanaArriba, 0.05]]), W),
    ], "a"),
    ...pair("costado_trasero", "Costado trasero", [
      sidePanel(rounded([
        [-2.18, 0.36], [-1.81, 0.36], [-1.68, 0.64], [-1.36, 0.78], [-1.04, 0.64], [-0.91, 0.36], [-0.48, 0.36],
        [-0.48, 1.8, 0.05], [-2.18, 1.8, 0.1],
      ]), W),
      sideGlass(rounded([[-2.06, cintura + 0.02, 0.05], [-0.54, cintura + 0.02, 0.04], [-0.54, ventanaArriba, 0.05], [-1.96, ventanaArriba, 0.1]]), W),
    ]),
    ...pair("espejo", "Espejo", [box([0.1, 0.18, 0.2], [1.6, 1.2, W / 2 + 0.11], "dark")]),
    ...pair("rueda_delantera", "Rueda delantera", [wheel([ejeD, R, W / 2 - 0.15], R, 0.21)], "a"),
    ...pair("rueda_trasera", "Rueda trasera", [wheel([ejeT, R, W / 2 - 0.15], R, 0.21)], "a"),
    { code: "techo", label: "Techo", group: "arriba", shapes: [extrude("side", ribbon([[-2.1, 1.875], [-0.6, 1.89], [0.82, 1.9]], 0.025), W - 0.2, 0)] },
    { code: "puerta_trasera", label: "Puertas traseras", group: "atras", shapes: [
      extrude("front", rounded([[-0.78, 0.4, 0.04], [0.78, 0.4, 0.04], [0.78, 1.78, 0.1], [-0.78, 1.78, 0.1]]), 0.012, -2.276),
      // Vidrio un poco más afuera que la puerta, para que no parpadee.
      extrude("front", rounded([[-0.68, cintura + 0.02, 0.04], [0.68, cintura + 0.02, 0.04], [0.64, 1.7, 0.06], [-0.64, 1.7, 0.06]]), 0.012, -2.292, "glass"),
    ] },
    { code: "parachoques_trasero", label: "Parachoques trasero", group: "atras", shapes: [box([0.12, 0.22, W - 0.02], [-2.28, 0.42, 0], "dark")] },
    ...pairSameGroup("foco_trasero", "Foco trasero", "atras", [box([0.04, 0.42, 0.1], [-2.275, 1.08, W / 2 - 0.12], "tail")]),
  ];
  const decor = [
    extrude("side", cuerpo, W, 0, "body", BISEL),
    // Aletas de los pasos de rueda.
    ...[ejeD, ejeT].flatMap((x) => [1, -1].map((lado) => extrude("side", archBand(x, R, 0.45, 0.5, base), 0.03, lado * (W / 2 + 0.005), "dark"))),
    box([4.1, 0.14, 1.3], [0, 0.32, 0], "dark"), // piso y chasis
  ];
  return { length: 4.6, width: W, height: 1.9, zones, decor, bodies: [{ outline: perfil, bevel: BISEL, half: W / 2 }] };
}

// ---------------------------------------------------------------------------
// Camioneta pickup: Mitsubishi L200 doble cabina 2024 (5,32 × 1,865 ×
// 1,795 m; 3,13 m entre ejes). Capó largo y alto, parrilla grande al frente,
// cabina doble más angosta que la carrocería y tolva con aletas marcadas.
// ---------------------------------------------------------------------------

function pickup() {
  const W = 1.83;
  const R = 0.395; // rueda 265/60 R18
  const ejeD = 1.71;
  const ejeT = -1.47;
  const base = 0.47;
  const cabinaAtras = -0.96; // la cabina doble termina justo antes de la rueda trasera
  const tolvaFrente = -1.0;
  const cintura = 1.17; // línea bajo los vidrios
  const anchoVidrios = 1.6;
  // Línea del parabrisas, de [0.42, 1.79] a [1.16, 1.15].
  const parabrisasY = (x) => 1.79 - (x - 0.42) * 0.865;

  // Frente y parte baja de la cabina, hasta la línea de cintura.
  const frente = [
    ...rounded([
      [cabinaAtras, base, 0.04],
      [cabinaAtras, cintura + 0.02, 0.04],
      [1.16, cintura - 0.02],
      [2.42, 1.12, 0.16],
      [2.64, 1.04, 0.08],
      [2.67, 0.66, 0.05],
      [2.6, base - 0.02, 0.05],
    ]),
    ...arch(ejeD, R, 0.49, base),
  ];
  const siluetaFrente = frente.slice(0, frente.length - 13);
  // Vidrios y techo de la cabina doble.
  const cabina = rounded([
    [cabinaAtras + 0.02, cintura - 0.02],
    [cabinaAtras + 0.02, 1.66, 0.1],
    [-0.82, 1.78, 0.12],
    [0.42, 1.79, 0.16],
    [1.17, cintura - 0.02],
  ]);
  // Costado de la tolva con su paso de rueda: de atrás abajo, sube, avanza
  // por el borde superior, baja al frente y vuelve por abajo saltando la rueda.
  const tolva = [
    [-2.66, 0.58], [-2.66, 1.14], [tolvaFrente, 1.14], [tolvaFrente, 0.58],
    ...arch(ejeT, R, 0.5, 0.58),
  ];
  // Tapabarro delantero: sobre la aleta de la rueda, hasta la línea del capó
  // (por dentro del bisel, como todos los paneles del costado).
  const tapabarro = [
    [1.22, 0.62],
    ...arch(ejeD, R, 0.58, 0.62).reverse(),
    [2.56, 0.64], [2.58, 0.98], [2.4, 1.065], [1.22, 1.09],
  ];

  const zones = [
    { code: "parachoques_delantero", label: "Parachoques delantero", group: "frente", shapes: [
      extrude("front", rounded([[-0.93, 0.44, 0.04], [0.93, 0.44, 0.04], [0.9, 0.68, 0.08], [-0.9, 0.68, 0.08]]), 0.14, 2.62, "dark"),
    ] },
    { code: "parrilla", label: "Parrilla", group: "frente", shapes: [
      extrude("front", rounded([[-0.5, 0.7, 0.06], [0.5, 0.7, 0.06], [0.58, 0.98, 0.04], [-0.58, 0.98, 0.04]]), 0.02, 2.68, "grille"),
    ] },
    ...pairSameGroup("faro_delantero", "Faro delantero", "frente", [
      extrude("front", rounded([[0.58, 0.95, 0.02], [0.9, 0.93, 0.03], [0.9, 1.06, 0.03], [0.6, 1.07, 0.02]]), 0.04, 2.645, "light"),
    ]),
    { code: "capo", label: "Capó", group: "frente", shapes: [extrude("side", ribbon([[1.18, 1.155], [1.8, 1.145], [2.4, 1.125]], 0.025), W - 0.2, 0)] },
    { code: "parabrisas", label: "Parabrisas", group: "frente", shapes: [extrude("side", ribbon([[0.44, 1.775], [0.8, 1.464], [1.15, 1.16]], 0.025), anchoVidrios - 0.06, 0, "glass")] },
    ...pair("tapabarro_delantero", "Tapabarro delantero", [sidePanel(tapabarro, W)]),
    ...pair("puerta_delantera", "Puerta delantera", [
      sidePanel(rounded([[0.24, base + 0.06, 0.04], [1.16, base + 0.06], [1.16, cintura - 0.07], [0.24, cintura - 0.06, 0.04]]), W),
      extrude("side", rounded([[0.28, cintura + 0.03], [1.04, cintura + 0.03], [0.46, 1.7, 0.03], [0.28, 1.7, 0.04]]), 0.012, anchoVidrios / 2 + 0.006, "glass"),
    ], "a"),
    ...pair("puerta_trasera", "Puerta trasera", [
      sidePanel(rounded([[cabinaAtras + 0.06, base + 0.06, 0.04], [0.21, base + 0.06], [0.21, cintura - 0.06], [cabinaAtras + 0.06, cintura - 0.05, 0.06]]), W),
      extrude("side", rounded([[-0.86, cintura + 0.03], [0.18, cintura + 0.03], [0.18, 1.7, 0.03], [-0.78, 1.7, 0.08]]), 0.012, anchoVidrios / 2 + 0.006, "glass"),
    ], "a"),
    ...pair("espejo", "Espejo", [box([0.16, 0.15, 0.22], [1.05, 1.3, W / 2 + 0.11], "dark")]),
    ...pair("tolva_costado", "Costado de la tolva", [extrude("side", tolva, 0.06, W / 2 - 0.03)]),
    ...pair("rueda_delantera", "Rueda delantera", [wheel([ejeD, R, 0.785], R, 0.27)], "a"),
    ...pair("rueda_trasera", "Rueda trasera", [wheel([ejeT, R, 0.785], R, 0.27)], "a"),
    { code: "techo", label: "Techo", group: "arriba", shapes: [extrude("side", ribbon([[-0.86, 1.765], [-0.2, 1.785], [0.4, 1.787]], 0.025), anchoVidrios - 0.1, 0)] },
    { code: "tolva_piso", label: "Piso de la tolva", group: "arriba", shapes: [box([1.58, 0.04, W - 0.14], [-1.83, 0.86, 0], "dark")] },
    { code: "luneta", label: "Vidrio trasero de la cabina", group: "atras", shapes: [
      extrude("front", rounded([[-0.56, 1.24, 0.05], [0.56, 1.24, 0.05], [0.5, 1.62, 0.06], [-0.5, 1.62, 0.06]]), 0.012, cabinaAtras + 0.012, "glass"),
    ] },
    { code: "portalon", label: "Portalón", group: "atras", shapes: [box([0.06, 0.52, W - 0.08], [-2.63, 0.88, 0])] },
    { code: "parachoques_trasero", label: "Parachoques trasero", group: "atras", shapes: [box([0.16, 0.18, W + 0.02], [-2.72, 0.54, 0], "dark")] },
    ...pairSameGroup("foco_trasero", "Foco trasero", "atras", [box([0.04, 0.34, 0.1], [-2.675, 0.92, W / 2 - 0.06], "tail")]),
  ];
  const decor = [
    extrude("side", frente, W, 0, "body", 0.05),
    extrude("side", cabina, anchoVidrios, 0, "body", 0.03), // pilares pintados; los vidrios van encima
    box([0.06, 0.5, W - 0.08], [tolvaFrente - 0.03, 0.88, 0]), // frente de la tolva
    // Aletas negras de los pasos de rueda.
    ...[1, -1].flatMap((lado) => [
      extrude("side", archBand(ejeD, R, 0.49, 0.57, base), 0.05, lado * (W / 2 - 0.01), "dark"),
      extrude("side", archBand(ejeT, R, 0.5, 0.58, 0.58), 0.05, lado * (W / 2 + 0.005), "dark"),
    ]),
    // Pisaderas.
    ...[1, -1].map((lado) => box([2.0, 0.05, 0.16], [0.1, 0.44, lado * (W / 2 + 0.02)], "dark")),
    box([4.9, 0.18, 1.2], [0, 0.42, 0], "dark"), // chasis
  ];
  return {
    length: 5.42, width: W, height: 1.8, zones, decor,
    bodies: [
      { outline: siluetaFrente, bevel: 0.05, half: W / 2 },
      { outline: cabina, bevel: 0.03, half: anchoVidrios / 2 },
    ],
  };
}

// ---------------------------------------------------------------------------
// Camión de cabina avanzada con caja (7,2 × 2,3 × 3,45 m)
// ---------------------------------------------------------------------------

function camion() {
  const W = 2.3;
  const R = 0.5;
  const ejeD = 2.78;
  const ejeT = -2.2;
  const cab = 2.2; // ancho de la cabina
  const perfilCabina = [
    ...rounded([
      [2.04, 0.66, 0.04],
      [2.04, 2.7, 0.12],
      [3.26, 2.74, 0.22],
      [3.48, 2.5, 0.08],
      [3.53, 1.72, 0.04],
      [3.55, 0.98, 0.06],
      [3.5, 0.66, 0.04],
    ]),
    ...arch(ejeD, R, 0.6, 0.66),
  ];
  const siluetaCabina = perfilCabina.slice(0, perfilCabina.length - 13);
  const parabrisasX = (y) => 3.48 + ((2.5 - y) / 0.78) * 0.05;

  const zones = [
    { code: "parachoques_delantero", label: "Parachoques delantero", group: "frente", shapes: [box([0.2, 0.34, W], [3.56, 0.8, 0], "dark")] },
    { code: "parrilla", label: "Parrilla", group: "frente", shapes: [
      extrude("front", rounded([[-0.7, 1.1, 0.05], [0.7, 1.1, 0.05], [0.7, 1.6, 0.05], [-0.7, 1.6, 0.05]]), 0.02, 3.565, "grille"),
    ] },
    ...pairSameGroup("faro_delantero", "Faro delantero", "frente", [
      extrude("front", rounded([[0.76, 1.04, 0.03], [1.02, 1.04, 0.03], [1.02, 1.28, 0.03], [0.76, 1.28, 0.03]]), 0.03, 3.56, "light"),
    ]),
    { code: "parabrisas", label: "Parabrisas", group: "frente", shapes: [
      extrude("side", [[parabrisasX(1.76) + 0.012, 1.76], [parabrisasX(2.46) + 0.012, 2.46], [parabrisasX(2.46) + 0.04, 2.46], [parabrisasX(1.76) + 0.04, 1.76]], cab - 0.24, 0, "glass"),
    ] },
    ...pair("puerta", "Puerta", [
      sidePanel(rounded([[2.24, 1.2, 0.04], [3.3, 1.2, 0.04], [3.38, 1.92], [2.24, 1.92]]), cab),
      sidePanel(rounded([[2.3, 1.98, 0.04], [3.38, 1.98], [3.34, 2.5, 0.06], [2.3, 2.5, 0.06]]), cab, "glass"),
    ], "a"),
    ...pair("espejo", "Espejo", [box([0.08, 0.45, 0.1], [3.36, 2.12, cab / 2 + 0.22], "dark")]),
    ...pair("caja_costado", "Costado de la caja", [box([5.35, 2.3, 0.04], [-0.82, 2.25, W / 2 + 0.01])]),
    ...pair("rueda_delantera", "Rueda delantera", [wheel([ejeD, R, W / 2 - 0.2], R, 0.32)], "a"),
    ...pair("rueda_trasera", "Ruedas traseras", [
      wheel([ejeT, R, W / 2 - 0.18], R, 0.3),
      wheel([ejeT, R, W / 2 - 0.52], R, 0.3),
    ], "as"),
    { code: "estanque_combustible", label: "Estanque de combustible", group: "izquierdo", shapes: [box([0.95, 0.42, 0.42], [1.2, 0.85, 0.78], "grille")] },
    { code: "techo_cabina", label: "Techo de la cabina", group: "arriba", shapes: [extrude("side", ribbon([[2.1, 2.7], [2.7, 2.725], [3.2, 2.735]], 0.025), cab - 0.22, 0)] },
    { code: "caja_frente", label: "Frente de la caja", group: "arriba", shapes: [box([0.04, 0.55, W], [1.87, 3.12, 0])] },
    { code: "caja_techo", label: "Techo de la caja", group: "arriba", shapes: [box([5.35, 0.05, W + 0.02], [-0.82, 3.42, 0])] },
    { code: "caja_puertas", label: "Puertas de la caja", group: "atras", shapes: [box([0.05, 2.3, W], [-3.52, 2.25, 0])] },
    { code: "parachoques_trasero", label: "Parachoques trasero", group: "atras", shapes: [box([0.15, 0.2, 2.2], [-3.5, 0.82, 0], "dark")] },
    ...pairSameGroup("foco_trasero", "Foco trasero", "atras", [box([0.05, 0.15, 0.32], [-3.58, 0.98, 0.9], "tail")]),
  ];
  const decor = [
    extrude("side", perfilCabina, cab, 0, "body", 0.08),
    box([5.35, 2.3, W], [-0.82, 2.25, 0]), // caja
    box([6.9, 0.25, 1.0], [0, 0.75, 0], "dark"), // chasis
    ...[1, -1].map((lado) => extrude("side", archBand(ejeD, R, 0.6, 0.66, 0.66), 0.04, lado * (cab / 2 + 0.005), "dark")),
  ];
  return { length: 7.2, width: W, height: 3.45, zones, decor, bodies: [{ outline: siluetaCabina, bevel: 0.08, half: cab / 2 }] };
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

/**
 * Esquinas [min, max] de una forma en coordenadas del vehículo, para los
 * tests (que todo quepa en sus medidas).
 */
function shapeBounds(s) {
  const pts = [];
  if (s.type === "box") {
    const [sx, sy, sz] = s.size;
    for (const dx of [-1, 1]) for (const dy of [-1, 1]) for (const dz of [-1, 1]) {
      pts.push([s.pos[0] + (dx * sx) / 2, s.pos[1] + (dy * sy) / 2, s.pos[2] + (dz * sz) / 2]);
    }
  } else if (s.type === "wheel") {
    pts.push([s.pos[0] - s.radius, s.pos[1] - s.radius, s.pos[2] - s.width / 2]);
    pts.push([s.pos[0] + s.radius, s.pos[1] + s.radius, s.pos[2] + s.width / 2]);
  } else {
    const h = s.depth / 2; // el bisel queda dentro de la extrusión
    for (const [a, b] of s.points) {
      for (const d of [-h, h]) {
        if (s.plane === "side") pts.push([a, b, s.at + d]);
        else if (s.plane === "front") pts.push([s.at + d, b, a]);
        else pts.push([a, s.at + d, b]);
      }
    }
  }
  const min = [0, 1, 2].map((i) => Math.min(...pts.map((p) => p[i])));
  const max = [0, 1, 2].map((i) => Math.max(...pts.map((p) => p[i])));
  return { min, max };
}

module.exports = {
  GROUPS,
  MODELS,
  modelFor,
  zoneFor,
  mirrorShape,
  shapeBounds,
};
