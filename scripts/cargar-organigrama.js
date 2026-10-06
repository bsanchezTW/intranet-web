#!/usr/bin/env node
/**
 * Carga el organigrama de Chile en work_areas: jerarquía, jefes y miembros.
 *
 *   node scripts/cargar-organigrama.js             → muestra el plan, no escribe
 *   node scripts/cargar-organigrama.js --aplicar   → lo aplica en una transacción
 *
 * Las áreas se buscan por nombre (sin acentos ni mayúsculas) y se reutilizan:
 * conservan su id, color y documentos. Sólo se crean las que faltan. Las
 * personas se buscan por primer nombre + inicio del apellido; si un nombre
 * calza con más de una persona el script se detiene sin tocar nada.
 *
 * Quien no figura en ORGANIGRAMA queda donde está. Quien figura pero no tiene
 * cuenta se informa y se omite: volver a correr el script después de crearla
 * lo ubica. Correrlo dos veces seguidas no cambia nada la segunda.
 */

const path = require("path");
const dotenv = require("dotenv");
const logger = require("../src/utils/logger");
const { applyCountryPoolerUser } = require("../src/config/supabaseProjects");

const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });
process.env.COUNTRY = "CL";
applyCountryPoolerUser(process.env);

const db = require("../src/db");
const {
  normalizeAreaName,
  hexToHsl,
  hslToHex,
  resolveAreaColor,
  DEFAULT_COLOR,
} = require("../src/constants/workAreas");
const { isIdPrimaryKeyCollision } = require("../src/utils/idCollision");

const APLICAR = process.argv.includes("--aplicar");

// El jefe también queda como miembro del área que dirige: así sus propias
// solicitudes suben al jefe del área superior.
const ORGANIGRAMA = {
  area: "Gerencia",
  jefe: "Luciano Fernández",
  miembros: ["Teresa Garretón"],
  hijas: [
    {
      area: "Finanzas",
      jefe: "Pablo Soto",
      miembros: ["Fernanda Contreras"],
      hijas: [
        {
          // Tesorería y RRHH. El nombre se mantiene: es el que habilita la
          // Administración de RRHH a sus administradores.
          area: "Recursos Humanos",
          jefe: "Marcela Manzano",
          miembros: [
            "Francisco Aguilera",
            "María Marcatinco",
            "Herta Schlegel",
            "María Angélica San Martín",
            "Ester Rosas",
          ],
        },
        {
          area: "Contabilidad",
          jefe: "Paula Serrano",
          miembros: ["Eduardo Zamora", "Nicolás Flores"],
        },
        {
          area: "Informática",
          jefe: "Sebastián Quiroga",
          miembros: ["Daniel Chiappe"],
        },
        {
          area: "Control y Gestión",
          jefe: "Rubén Haro",
          miembros: ["Sofía Garrido"],
        },
        {
          area: "Logística",
          jefe: "Loreto Carvallo",
          miembros: [],
          hijas: [
            {
              area: "Bodega",
              jefe: "Carlos Fuentes",
              miembros: [
                "Angelo Molina",
                "Ricardo Pérez",
                "Freddy Panicide",
                "Richard Gómez",
                "Carlos Becerra",
                "Luis Arce",
                "Gino Moyano",
                "Henry González",
              ],
            },
            {
              area: "Operaciones y Facturación",
              jefe: "Corina Pino",
              miembros: ["Javier Poveda", "Jessica Ibaceta", "Rosa Valdés"],
            },
          ],
        },
      ],
    },
    {
      area: "Eléctrica",
      jefe: "Jorge De Geyter",
      miembros: ["Gabriel Villa", "David González", "Santiago Lozada"],
    },
    {
      area: "Comercial",
      jefe: "Vicente Fernández",
      miembros: [],
      hijas: [
        {
          area: "Cableado y Conectividad",
          jefe: "Sandra Dittmar",
          miembros: ["Luis Torres", "Cristofer Velásquez"],
        },
        {
          area: "Ventas",
          jefe: "Ledwin Pacheco",
          miembros: [
            "Alan Cerda",
            "Andrés Freire",
            "Hernán Sánchez",
            "Hernán Avendaño",
            "Nicolás González",
            "Marisol Martel",
            "Angelo Crisóstomo",
          ],
        },
        {
          area: "Tecnología",
          jefe: "Williams Araya",
          miembros: ["Javier Salgado", "Álvaro Alzola"],
        },
        {
          area: "Marketing",
          jefe: "Erick Novoa",
          miembros: ["Fermín Varas", "Felipe Reyes"],
        },
      ],
    },
    {
      area: "Seguridad Industrial",
      jefe: "Andrea Fernández",
      miembros: ["Fausto Tanzella", "Sergio Temperoni"],
    },
  ],
};

// ===========================================================================
// Plan
// ===========================================================================

function sinEspacios(value) {
  return normalizeAreaName(value).replace(/\s+/g, "");
}

/** Recorre el árbol en orden: cada área llega después de su padre. */
function aplanar(nodo, padre = null, lista = []) {
  lista.push({ ...nodo, padre });
  for (const hija of nodo.hijas || []) aplanar(hija, nodo.area, lista);
  return lista;
}

/**
 * "Nombre Apellido" → usuario. Calza el primer nombre exacto y el apellido
 * por prefijo, sin acentos ni espacios ("De Geyter" = "DeGeyter Soto").
 */
function crearBuscador(users) {
  return function buscar(nombreCompleto) {
    const [nombre, ...resto] = String(nombreCompleto).trim().split(/\s+/);
    const n = normalizeAreaName(nombre);
    const a = sinEspacios(resto.join(" "));
    const hits = users.filter((u) => {
      const primerNombre = normalizeAreaName(u.first_name).split(/\s+/)[0] || "";
      return primerNombre === n && sinEspacios(u.last_name).startsWith(a);
    });
    return hits;
  };
}

function nombreDe(u) {
  return [u.first_name, u.last_name].filter(Boolean).join(" ");
}

async function armarPlan() {
  const [{ rows: areas }, { rows: users }] = await Promise.all([
    db.query("SELECT id, area_name, color, parent_area_id, manager_user_id FROM work_areas"),
    db.query("SELECT id, first_name, last_name, role, work_area_id FROM users"),
  ]);
  const areaPorNombre = new Map(areas.map((a) => [normalizeAreaName(a.area_name), a]));
  const areaPorId = new Map(areas.map((a) => [Number(a.id), a]));
  const buscar = crearBuscador(users);

  const nodos = aplanar(ORGANIGRAMA);
  const faltantes = [];
  const ambiguos = [];
  const asignadas = new Map(); // userId → área destino (detecta duplicados)

  function resolver(nombre, areaDestino) {
    const hits = buscar(nombre);
    if (hits.length === 0) {
      faltantes.push(`${nombre} (${areaDestino})`);
      return null;
    }
    if (hits.length > 1) {
      ambiguos.push(`${nombre}: ${hits.map((h) => `${nombreDe(h)} #${h.id}`).join(", ")}`);
      return null;
    }
    const user = hits[0];
    const previa = asignadas.get(user.id);
    if (previa && previa !== areaDestino) {
      ambiguos.push(`${nombre} aparece en «${previa}» y en «${areaDestino}»`);
    }
    asignadas.set(user.id, areaDestino);
    return user;
  }

  const plan = nodos.map((nodo) => {
    const existente = areaPorNombre.get(normalizeAreaName(nodo.area)) || null;
    const jefe = resolver(nodo.jefe, nodo.area);
    const miembros = [jefe, ...nodo.miembros.map((m) => resolver(m, nodo.area))].filter(Boolean);
    return { ...nodo, existente, jefe, miembros };
  });

  return { plan, areaPorNombre, areaPorId, users, faltantes, ambiguos };
}

/** Color de un área nueva: el de su nombre histórico o un tono claro del padre. */
function colorParaNueva(nombre, colorPadre) {
  const porNombre = resolveAreaColor(null, nombre);
  if (porNombre !== DEFAULT_COLOR) return porNombre;
  if (!colorPadre) return DEFAULT_COLOR;
  const { h, s } = hexToHsl(colorPadre);
  return hslToHex(h, s, 58);
}

function imprimirPlan({ plan, areaPorId, users }) {
  const nombreArea = (id) => (id ? areaPorId.get(Number(id))?.area_name || `#${id}` : "ninguna");
  const nombreUsuario = (id) => {
    if (!id) return "sin jefe";
    const u = users.find((x) => Number(x.id) === Number(id));
    return u ? nombreDe(u) : `#${id}`;
  };
  let cambios = 0;

  console.log("");
  console.log("Áreas");
  console.log("─".repeat(72));
  for (const nodo of plan) {
    const sangria = "  ".repeat(profundidad(plan, nodo));
    const lineas = [];
    if (!nodo.existente) {
      lineas.push("se crea");
    } else {
      const padreActual = nombreArea(nodo.existente.parent_area_id);
      const padreNuevo = nodo.padre || "ninguna";
      if (normalizeAreaName(padreActual) !== normalizeAreaName(padreNuevo)) {
        lineas.push(`depende de: ${padreActual} → ${padreNuevo}`);
      }
      const jefeNuevo = nodo.jefe ? nodo.jefe.id : null;
      if (Number(nodo.existente.manager_user_id || 0) !== Number(jefeNuevo || 0)) {
        lineas.push(`jefe: ${nombreUsuario(nodo.existente.manager_user_id)} → ${nombreUsuario(jefeNuevo)}`);
      }
    }
    if (lineas.length) cambios += 1;
    const jefe = nodo.jefe ? nombreDe(nodo.jefe) : "SIN JEFE (no encontrado)";
    console.log(`${sangria}${nodo.area} · jefe ${jefe}${lineas.length ? `   [${lineas.join("; ")}]` : ""}`);
  }

  console.log("");
  console.log("Personas que cambian de área");
  console.log("─".repeat(72));
  let movidas = 0;
  for (const nodo of plan) {
    for (const u of nodo.miembros) {
      const destinoId = nodo.existente ? Number(nodo.existente.id) : null;
      if (destinoId && Number(u.work_area_id) === destinoId) continue;
      movidas += 1;
      console.log(`  ${nombreDe(u).padEnd(36)} ${nombreArea(u.work_area_id).padEnd(20)} → ${nodo.area}`);
    }
  }
  if (!movidas) console.log("  (ninguna)");

  const enPlan = new Set(plan.flatMap((n) => n.miembros.map((u) => Number(u.id))));
  const fuera = users.filter((u) => !enPlan.has(Number(u.id)));
  console.log("");
  console.log("No figuran en el organigrama (se quedan donde están)");
  console.log("─".repeat(72));
  for (const u of fuera) {
    console.log(`  ${nombreDe(u).padEnd(36)} ${nombreArea(u.work_area_id)}${u.role === "Deshabilitado" ? "  (deshabilitado)" : ""}`);
  }

  return cambios + movidas;
}

function profundidad(plan, nodo) {
  let d = 0;
  let actual = nodo;
  while (actual && actual.padre) {
    d += 1;
    actual = plan.find((n) => n.area === actual.padre);
  }
  return d;
}

// ===========================================================================
// Aplicar
// ===========================================================================

async function insertarArea(client, nombre, color) {
  for (let intento = 0; intento < 8; intento += 1) {
    await client.query("SAVEPOINT nueva_area");
    try {
      const { rows } = await client.query(
        "INSERT INTO work_areas (area_name, color) VALUES ($1, $2) RETURNING id, area_name, color",
        [nombre, color],
      );
      await client.query("RELEASE SAVEPOINT nueva_area");
      return rows[0];
    } catch (err) {
      await client.query("ROLLBACK TO SAVEPOINT nueva_area");
      if (!isIdPrimaryKeyCollision(err)) throw err;
    }
  }
  throw new Error(`No se pudo generar un id libre para «${nombre}».`);
}

async function aplicar({ plan }) {
  const client = await db.getClient();
  try {
    await client.query("BEGIN");

    // Primero existen todas las áreas, después se cuelgan: así el orden de
    // los UPDATE no importa y ningún padre falta a mitad de camino.
    const idPorNombre = new Map();
    const colorPorNombre = new Map();
    for (const nodo of plan) {
      let area = nodo.existente;
      if (!area) {
        area = await insertarArea(client, nodo.area, colorParaNueva(nodo.area, colorPorNombre.get(nodo.padre)));
        logger.info("organigrama", `Área creada: ${area.area_name} (#${area.id})`);
      }
      idPorNombre.set(nodo.area, Number(area.id));
      colorPorNombre.set(nodo.area, resolveAreaColor(area.color, area.area_name));
    }

    for (const nodo of plan) {
      const id = idPorNombre.get(nodo.area);
      const padreId = nodo.padre ? idPorNombre.get(nodo.padre) : null;
      await client.query(
        "UPDATE work_areas SET parent_area_id = $1, manager_user_id = $2 WHERE id = $3",
        [padreId, nodo.jefe ? nodo.jefe.id : null, id],
      );
      const ids = nodo.miembros.map((u) => u.id);
      if (ids.length) {
        await client.query("UPDATE users SET work_area_id = $1 WHERE id = ANY($2::int[])", [id, ids]);
      }
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

// ===========================================================================

async function main() {
  const datos = await armarPlan();

  if (datos.ambiguos.length) {
    logger.error("organigrama", "Hay nombres ambiguos o repetidos; corrige ORGANIGRAMA antes de seguir:");
    for (const linea of datos.ambiguos) console.log(`  ${linea}`);
    process.exitCode = 1;
    return;
  }

  const cambios = imprimirPlan(datos);

  if (datos.faltantes.length) {
    console.log("");
    console.log("Sin cuenta en la intranet (se omiten)");
    console.log("─".repeat(72));
    for (const linea of datos.faltantes) console.log(`  ${linea}`);
  }

  console.log("");
  if (!cambios) {
    logger.info("organigrama", "La base ya coincide con el organigrama. Nada que aplicar.");
    return;
  }
  if (!APLICAR) {
    logger.info("organigrama", "Vista previa: no se escribió nada. Corre con --aplicar para guardar.");
    return;
  }
  await aplicar(datos);
  logger.info("organigrama", "Organigrama aplicado.");
}

main()
  .then(() => process.exit(process.exitCode || 0))
  .catch((err) => {
    logger.error("organigrama", err);
    process.exit(1);
  });
