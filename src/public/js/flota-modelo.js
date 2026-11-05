/**
 * Visor 3D de la revisión física (Gestión de flota).
 *
 * Arma el modelo del vehículo a partir de los datos de
 * src/constants/vehicleZones.js (JSON en la página): cada zona es un grupo de
 * piezas que se puede tocar. Se gira arrastrando, se acerca con la rueda o
 * pellizcando, y hay botones de vista. La lista de zonas de la página
 * funciona igual sin 3D (sin WebGL o si el CDN no responde).
 *
 * Expone window.flotaModelo para la revisión física:
 *   seleccionar(code)          marca una zona (y gira hasta su lado)
 *   marcar(code, estado)       'danio' | 'nuevo' | 'reparado' | null
 *   capturar(vista, opciones)  JPEG (data URL) del modelo desde esa vista, en
 *                              fondo blanco y sin la zona elegida resaltada
 *   listo                      true cuando el 3D cargó
 * y emite "flota:zona" ({ code, label, group }) al elegir una zona y
 * "flota:modelo-listo" cuando el 3D está dibujado.
 *
 * Sólo dibuja cuando algo cambia, para no gastar batería en el celular.
 */

const THREE_URL = "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js";

const COLORES = {
  body: 0xe9edf3,
  glass: 0x3a4a5f,
  dark: 0x2f343c,
  grille: 0x8c96a4,
  light: 0xf7efc4,
  tail: 0xc0392b,
};
const COLOR_SELECCION = 0x2f6fe0;
const COLOR_DANIO = 0xd64545;
const COLOR_NUEVO = 0xe8930c;
const COLOR_REPARADO = 0x2e9d5b;

// Los datos ponen el lado izquierdo en +z; en three.js (x adelante, y arriba)
// +z es la derecha, así que las piezas se ubican con z invertida y el lado
// izquierdo queda en -z.
//
// Vistas: ángulo alrededor del vehículo (0 = frente) y altura de la cámara.
// La general mira el frente y el lado del conductor.
const VISTAS = {
  general: { az: -Math.PI / 4, el: 0.34 },
  frente: { az: 0, el: 0.16 },
  atras: { az: Math.PI, el: 0.16 },
  izquierdo: { az: -Math.PI / 2, el: 0.12 },
  derecho: { az: Math.PI / 2, el: 0.12 },
  arriba: { az: -Math.PI / 2, el: 1.38 },
};

const raiz = document.querySelector("[data-modelo]");
if (raiz) iniciar(raiz);

function iniciar(raiz) {
  const datos = JSON.parse(document.getElementById(raiz.dataset.datos).textContent);
  const zonas = new Map(datos.model.zones.map((z) => [z.code, z]));
  const grupos = new Map(datos.groups.map((g) => [g.value, g.label]));
  const lienzo = raiz.querySelector("[data-modelo-lienzo]");
  const aviso = raiz.querySelector("[data-modelo-aviso]");
  const etiqueta = raiz.querySelector("[data-modelo-etiqueta]");
  const panel = document.querySelector("[data-zona-panel]");
  const botonesZona = [...document.querySelectorAll("[data-zona]")];
  const botonesVista = [...raiz.querySelectorAll("[data-vista]")];

  let visor = null; // se llena cuando carga el 3D
  let seleccionada = null;
  const estados = new Map();

  function seleccionar(code, { mover = false } = {}) {
    const zona = zonas.get(code);
    if (!zona) return;
    seleccionada = code;
    botonesZona.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.zona === code)));
    if (panel) {
      panel.querySelector("[data-zona-nombre]").textContent = zona.label;
      panel.querySelector("[data-zona-grupo]").textContent = grupos.get(zona.group) || "";
      panel.hidden = false;
    }
    if (visor) {
      visor.pintar();
      if (mover) visor.irA(zona.group);
    }
    document.dispatchEvent(new CustomEvent("flota:zona", { detail: { code, label: zona.label, group: zona.group } }));
  }

  botonesZona.forEach((b) => b.addEventListener("click", () => seleccionar(b.dataset.zona, { mover: true })));

  window.flotaModelo = {
    seleccionar: (code) => seleccionar(code, { mover: true }),
    marcar(code, estado) {
      if (estado) estados.set(code, estado);
      else estados.delete(code);
      botonesZona.filter((b) => b.dataset.zona === code).forEach((b) => {
        if (estado) b.dataset.estado = estado;
        else delete b.dataset.estado;
      });
      if (visor) visor.pintar();
    },
    capturar: (vista, opciones) => (visor ? visor.capturar(vista, opciones) : null),
    get listo() { return Boolean(visor); },
  };

  function fallo(texto) {
    lienzo.hidden = true;
    botonesVista.forEach((b) => { b.disabled = true; });
    aviso.textContent = texto;
    aviso.hidden = false;
  }

  import(THREE_URL)
    .then((THREE) => {
      try {
        visor = crearVisor(THREE, { datos, lienzo, etiqueta, zonas, estados, getSeleccionada: () => seleccionada, onTocar: (code) => seleccionar(code) });
      } catch (err) {
        console.error("[flota-modelo]", err);
        fallo("Este navegador no puede mostrar el modelo 3D. Elige la zona en la lista.");
        return;
      }
      botonesVista.forEach((b) => b.addEventListener("click", () => {
        botonesVista.forEach((o) => o.setAttribute("aria-pressed", String(o === b)));
        visor.irA(b.dataset.vista);
      }));
      raiz.classList.add("is-listo");
      document.dispatchEvent(new CustomEvent("flota:modelo-listo"));
    })
    .catch((err) => {
      console.error("[flota-modelo]", err);
      fallo("No se pudo cargar el modelo 3D. Revisa la conexión o elige la zona en la lista.");
    });
}

function crearVisor(THREE, { datos, lienzo, etiqueta, zonas, estados, getSeleccionada, onTocar }) {
  const { model } = datos;
  const renderer = new THREE.WebGLRenderer({ canvas: lienzo, antialias: true, alpha: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x8a96a8, 2.2));
  const sol = new THREE.DirectionalLight(0xffffff, 2.4);
  sol.position.set(6, 9, 5);
  scene.add(sol);
  const contraluz = new THREE.DirectionalLight(0xffffff, 0.9);
  contraluz.position.set(-6, 4, -5);
  scene.add(contraluz);

  // Sombra suave bajo el vehículo.
  const sombra = new THREE.Mesh(
    new THREE.CircleGeometry(1, 48),
    new THREE.MeshBasicMaterial({ color: 0x0b1a33, transparent: true, opacity: 0.08, depthWrite: false }),
  );
  sombra.rotation.x = -Math.PI / 2;
  sombra.scale.set(model.length * 0.62, model.width * 0.95, 1);
  sombra.position.y = 0.002;
  scene.add(sombra);

  const bordes = new THREE.LineBasicMaterial({ color: 0x1d2633, transparent: true, opacity: 0.28 });

  function material(mat) {
    return new THREE.MeshStandardMaterial({
      color: COLORES[mat] ?? COLORES.body,
      roughness: mat === "glass" ? 0.25 : 0.62,
      metalness: mat === "glass" || mat === "grille" ? 0.35 : 0.08,
      emissive: mat === "light" ? 0x5c5530 : 0x000000,
    });
  }

  function pieza(s) {
    let geo;
    let mesh;
    if (s.type === "wheel") {
      geo = new THREE.CylinderGeometry(s.radius, s.radius, s.width, 28);
      geo.rotateX(Math.PI / 2);
      mesh = new THREE.Mesh(geo, material("dark"));
      const llanta = new THREE.Mesh(
        new THREE.CylinderGeometry(s.radius * 0.55, s.radius * 0.55, s.width + 0.012, 20).rotateX(Math.PI / 2),
        material("grille"),
      );
      mesh.add(llanta);
    } else if (s.type === "extrude") {
      return perfil(s);
    } else {
      geo = new THREE.BoxGeometry(...s.size);
      mesh = new THREE.Mesh(geo, material(s.mat));
      if (s.rotZ) mesh.rotation.z = s.rotZ;
    }
    mesh.position.set(s.pos[0], s.pos[1], -s.pos[2]);
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25), bordes));
    return mesh;
  }

  // Polígono extruido (carrocería, paneles, cintas). El bisel no agranda la
  // silueta: bevelOffset negativo la mantiene en sus medidas.
  const A_LO_LARGO = new THREE.Matrix4().set(0, 0, 1, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 0, 1);
  const HACIA_ARRIBA = new THREE.Matrix4().set(1, 0, 0, 0, 0, 0, 1, 0, 0, -1, 0, 0, 0, 0, 0, 1);
  function perfil(s) {
    const bisel = s.bevel || 0;
    const nucleo = Math.max(s.depth - 2 * bisel, 0.001);
    const geo = new THREE.ExtrudeGeometry(new THREE.Shape(s.points.map(([a, b]) => new THREE.Vector2(a, b))), {
      depth: nucleo,
      bevelEnabled: bisel > 0,
      bevelThickness: bisel,
      bevelSize: bisel,
      bevelOffset: -bisel,
      bevelSegments: 3,
      curveSegments: 4,
    });
    geo.translate(0, 0, -nucleo / 2);
    // 'side' ya está a lo ancho; 'front' y 'top' se giran. En todos, la z de
    // los datos (izquierda) queda en -z de three.js.
    if (s.plane === "front") geo.applyMatrix4(A_LO_LARGO);
    if (s.plane === "top") geo.applyMatrix4(HACIA_ARRIBA);
    const mesh = new THREE.Mesh(geo, material(s.mat));
    if (s.plane === "side") mesh.position.z = -s.at;
    else if (s.plane === "front") mesh.position.x = s.at;
    else mesh.position.y = s.at;
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 35), bordes));
    return mesh;
  }

  for (const s of model.decor) scene.add(pieza(s));

  // Cada zona es un grupo; sus mallas guardan el código para el raycast.
  const zonaMeshes = new Map();
  const tocables = [];
  for (const z of model.zones) {
    const grupo = new THREE.Group();
    const mallas = [];
    for (const s of z.shapes) {
      const m = pieza(s);
      grupo.add(m);
      m.traverse((o) => {
        if (o.isMesh) {
          o.userData.zona = z.code;
          o.userData.colorBase = o.material.color.getHex();
          mallas.push(o);
          tocables.push(o);
        }
      });
    }
    zonaMeshes.set(z.code, mallas);
    scene.add(grupo);
  }

  // --- Cámara en coordenadas esféricas alrededor del vehículo -------------
  const objetivo = new THREE.Vector3(0, model.height * 0.42, 0);
  // Distancia que encuadra el vehículo entero según el tamaño del lienzo: en
  // un celular vertical manda el ancho, en escritorio el alto. El zoom del
  // usuario multiplica esa distancia.
  const ZOOM_MIN = 0.5;
  const ZOOM_MAX = 1.8;
  let distancia = Math.max(model.length, model.height * 1.6) * 1.55;
  const camara = { ...VISTAS.general, zoom: 1 };

  function encuadrar() {
    const vfov = THREE.MathUtils.degToRad(camera.fov);
    const hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const radio = Math.hypot(model.length, model.width) / 2; // de lado a lado, en cualquier giro
    const porAncho = radio / Math.tan(hfov / 2);
    const porAlto = (model.height * 0.75 + radio * 0.35) / Math.tan(vfov / 2);
    distancia = Math.max(porAncho, porAlto) * 1.08;
  }

  function aplicarCamara(c = camara) {
    const el = Math.min(Math.max(c.el, 0.02), 1.4);
    const r = distancia * c.zoom;
    camera.position.set(
      objetivo.x + r * Math.cos(el) * Math.cos(c.az),
      objetivo.y + r * Math.sin(el),
      objetivo.z + r * Math.cos(el) * Math.sin(c.az),
    );
    camera.lookAt(objetivo);
  }

  let pendiente = false;
  function dibujar() {
    if (pendiente) return;
    pendiente = true;
    requestAnimationFrame(() => {
      pendiente = false;
      aplicarCamara();
      renderer.render(scene, camera);
    });
  }

  let animacion = null;
  function irA(vista) {
    const destino = VISTAS[vista] || VISTAS.general;
    const desde = { az: camara.az, el: camara.el };
    // Gira por el camino corto.
    let daz = destino.az - desde.az;
    daz = Math.atan2(Math.sin(daz), Math.cos(daz));
    const t0 = performance.now();
    const dur = 450;
    if (animacion) cancelAnimationFrame(animacion);
    const paso = (t) => {
      const k = Math.min((t - t0) / dur, 1);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      camara.az = desde.az + daz * e;
      camara.el = desde.el + (destino.el - desde.el) * e;
      aplicarCamara();
      renderer.render(scene, camera);
      animacion = k < 1 ? requestAnimationFrame(paso) : null;
    };
    animacion = requestAnimationFrame(paso);
  }

  // --- Colores según selección, daño y paso del mouse ---------------------
  let sobre = null;
  function colorear({ limpio = false } = {}) {
    const sel = limpio ? null : getSeleccionada();
    const encima = limpio ? null : sobre;
    for (const [code, mallas] of zonaMeshes) {
      const estado = estados.get(code);
      for (const m of mallas) {
        let color = m.userData.colorBase;
        if (estado === "danio") color = COLOR_DANIO;
        else if (estado === "nuevo") color = COLOR_NUEVO;
        else if (estado === "reparado") color = COLOR_REPARADO;
        if (code === sel) color = COLOR_SELECCION;
        m.material.color.setHex(color);
        m.material.emissive.setHex(code === encima && code !== sel ? 0x1c3d7a : m.userData.colorBase === COLORES.light ? 0x5c5530 : 0x000000);
      }
    }
  }

  function pintar() {
    colorear();
    dibujar();
  }

  // --- Gestos -------------------------------------------------------------
  const raycaster = new THREE.Raycaster();
  const puntero = new THREE.Vector2();
  function zonaEn(clientX, clientY) {
    const r = lienzo.getBoundingClientRect();
    puntero.x = ((clientX - r.left) / r.width) * 2 - 1;
    puntero.y = -((clientY - r.top) / r.height) * 2 + 1;
    raycaster.setFromCamera(puntero, camera);
    const hit = raycaster.intersectObjects(tocables, false)[0];
    return hit ? hit.object.userData.zona : null;
  }

  const punteros = new Map();
  let arrastre = 0;
  let pinza = null;

  lienzo.addEventListener("pointerdown", (e) => {
    lienzo.setPointerCapture(e.pointerId);
    punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
    arrastre = 0;
    if (punteros.size === 2) {
      const [a, b] = [...punteros.values()];
      pinza = { d: Math.hypot(a.x - b.x, a.y - b.y), zoom: camara.zoom };
    }
    if (animacion) { cancelAnimationFrame(animacion); animacion = null; }
  });

  lienzo.addEventListener("pointermove", (e) => {
    const previo = punteros.get(e.pointerId);
    if (!previo) {
      // Mouse sin botón: resalta la zona y muestra su nombre.
      if (e.pointerType === "mouse") {
        const code = zonaEn(e.clientX, e.clientY);
        if (code !== sobre) {
          sobre = code;
          lienzo.style.cursor = code ? "pointer" : "grab";
          pintar();
        }
        if (code) {
          const r = lienzo.getBoundingClientRect();
          etiqueta.textContent = zonas.get(code).label;
          etiqueta.style.transform = `translate(${e.clientX - r.left + 14}px, ${e.clientY - r.top + 12}px)`;
          etiqueta.hidden = false;
        } else {
          etiqueta.hidden = true;
        }
      }
      return;
    }
    const dx = e.clientX - previo.x;
    const dy = e.clientY - previo.y;
    punteros.set(e.pointerId, { x: e.clientX, y: e.clientY });
    arrastre += Math.abs(dx) + Math.abs(dy);
    if (punteros.size === 2 && pinza) {
      const [a, b] = [...punteros.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      camara.zoom = Math.min(Math.max(pinza.zoom * (pinza.d / Math.max(d, 1)), ZOOM_MIN), ZOOM_MAX);
    } else if (punteros.size === 1) {
      // El vehículo sigue a la mano: arrastrar a la derecha lo gira a la derecha.
      camara.az += dx * 0.0085;
      camara.el = Math.min(Math.max(camara.el + dy * 0.006, 0.02), 1.4);
    }
    etiqueta.hidden = true;
    dibujar();
  });

  function soltar(e) {
    if (!punteros.has(e.pointerId)) return;
    const eraToque = punteros.size === 1 && arrastre < 6;
    punteros.delete(e.pointerId);
    if (punteros.size < 2) pinza = null;
    if (eraToque && e.type === "pointerup") {
      const code = zonaEn(e.clientX, e.clientY);
      if (code) onTocar(code);
    }
  }
  lienzo.addEventListener("pointerup", soltar);
  lienzo.addEventListener("pointercancel", soltar);
  lienzo.addEventListener("pointerleave", () => {
    if (sobre) { sobre = null; pintar(); }
    etiqueta.hidden = true;
  });
  lienzo.addEventListener("wheel", (e) => {
    e.preventDefault();
    camara.zoom = Math.min(Math.max(camara.zoom * (e.deltaY > 0 ? 1.08 : 0.92), ZOOM_MIN), ZOOM_MAX);
    dibujar();
  }, { passive: false });

  // --- Tamaño -------------------------------------------------------------
  function ajustar() {
    const { clientWidth: w, clientHeight: h } = lienzo;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    encuadrar();
    dibujar();
  }
  new ResizeObserver(ajustar).observe(lienzo);
  ajustar();
  pintar();

  /**
   * JPEG del modelo desde una vista, a tamaño fijo y en fondo blanco (para el
   * PDF), con los daños marcados y sin la zona elegida. No mueve la cámara
   * del usuario: dibuja, lee y vuelve a dejar todo como estaba.
   */
  function capturar(vista, { ancho = 1200, alto = 720, calidad = 0.9 } = {}) {
    const v = VISTAS[vista] || VISTAS.general;
    const guardada = { ...camara };
    const ratio = renderer.getPixelRatio();
    renderer.setPixelRatio(1);
    renderer.setSize(ancho, alto, false);
    camera.aspect = ancho / alto;
    camera.updateProjectionMatrix();
    encuadrar();
    renderer.setClearColor(0xffffff, 1);
    colorear({ limpio: true });
    aplicarCamara({ ...v, zoom: 0.86 }); // un poco más cerca: el vehículo llena la imagen
    renderer.render(scene, camera);
    const url = renderer.domElement.toDataURL("image/jpeg", calidad);
    renderer.setClearColor(0x000000, 0);
    renderer.setPixelRatio(ratio);
    camara.az = guardada.az;
    camara.el = guardada.el;
    camara.zoom = guardada.zoom;
    ajustar();
    pintar();
    return url;
  }

  return { irA, pintar, capturar };
}
