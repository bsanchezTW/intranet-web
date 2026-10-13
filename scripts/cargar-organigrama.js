#!/usr/bin/env node
/**
 * Carga el organigrama oficial de un país en work_areas: jerarquía, jefes,
 * miembros y orden. Cada país describe el suyo en scripts/organigramas/<país>.js.
 *
 *   node scripts/cargar-organigrama.js --pais CL             → muestra el plan
 *   node scripts/cargar-organigrama.js --pais PE --aplicar   → lo aplica en una transacción
 *
 * La forma de trabajar es la misma en todos los países: las áreas son
 * departamentos (no cargos), cada una con su jefe, que también es miembro del
 * área que dirige; las áreas cuelgan unas de otras y el orden de `hijas` es
 * el del organigrama oficial (se guarda en sort_order). Un área sin jefe
 * (`jefe: null`) escala sus solicitudes al jefe del área superior.
 *
 * Las áreas se buscan por nombre (sin acentos ni mayúsculas) y se reutilizan:
 * conservan su id, color y documentos. Sólo se crean las que faltan; una que
 * cambia de nombre se encuentra por `antes` y se renombra. Las
 * personas se buscan por primer nombre + inicio del apellido; si un nombre
 * calza con más de una persona el script se detiene sin tocar nada.
 *
 * `eliminar` lista áreas que dejan de existir (p. ej. cargos convertidos en
 * departamentos). Sólo se borran si quedan vacías: sin personas, sin áreas
 * dependientes y sin documentos; si no, el script se detiene sin tocar nada.
 *
 * Quien no figura en el organigrama queda donde está. Quien figura pero no tiene
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
function leerPais() {
  const i = process.argv.indexOf("--pais");
  const pais = String(i >= 0 ? process.argv[i + 1] || "" : "").toUpperCase();
  if (!["CL", "PE"].includes(pais)) {
    console.error("Indica el país: node scripts/cargar-organigrama.js --pais CL|PE [--aplicar]");
    process.exit(1);
  }
  return pais;
}

const PAIS = leerPais();
process.env.COUNTRY = PAIS;
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

const { arbol: ORGANIGRAMA, eliminar: ELIMINAR = [] } = require(`./organigramas/${PAIS.toLowerCase()}`);

// ===========================================================================
// Plan
// ===========================================================================

function sinEspacios(value) {
  return normalizeAreaName(value).replace(/\s+/g, "");
}

/** Recorre el árbol en orden: cada área llega después de su padre. */
function aplanar(nodo, padre = null, orden = null, lista = []) {
  lista.push({ ...nodo, padre, orden });
  (nodo.hijas || []).forEach((hija, i) => aplanar(hija, nodo.area, i + 1, lista));
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
  const [{ rows: areas }, { rows: users }, { rows: docs }] = await Promise.all([
    db.query("SELECT id, area_name, color, parent_area_id, manager_user_id, sort_order FROM work_areas"),
    db.query("SELECT id, first_name, last_name, role, work_area_id FROM users"),
    db.query("SELECT work_area_id, count(*)::int AS n FROM documents WHERE work_area_id IS NOT NULL GROUP BY work_area_id"),
  ]);
  const docsPorArea = new Map(docs.map((d) => [Number(d.work_area_id), d.n]));
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
    const existente =
      areaPorNombre.get(normalizeAreaName(nodo.area)) ||
      (nodo.antes && areaPorNombre.get(normalizeAreaName(nodo.antes))) ||
      null;
    const jefe = nodo.jefe ? resolver(nodo.jefe, nodo.area) : null;
    const miembros = [jefe, ...nodo.miembros.map((m) => resolver(m, nodo.area))].filter(Boolean);
    return { ...nodo, jefeNombre: nodo.jefe, existente, jefe, miembros };
  });

  const borrar = planBorrado(plan, areas, users, docsPorArea, areaPorNombre, ambiguos);

  return { plan, borrar, areaPorNombre, areaPorId, users, faltantes, ambiguos };
}

/**
 * Áreas de `eliminar` que todavía existen y por qué no se podrían borrar:
 * gente que se queda en ellas, áreas dependientes que el plan no reubica o
 * documentos (se borrarían en cascada).
 */
function planBorrado(plan, areas, users, docsPorArea, areaPorNombre, ambiguos) {
  const enPlan = new Set(plan.filter((n) => n.existente).map((n) => Number(n.existente.id)));
  const destinoDe = new Map();
  for (const nodo of plan) for (const u of nodo.miembros) destinoDe.set(Number(u.id), nodo.area);

  const borrar = ELIMINAR.map((nombre) => areaPorNombre.get(normalizeAreaName(nombre))).filter(Boolean);
  const idsBorrar = new Set(borrar.map((a) => Number(a.id)));

  return borrar.map((area) => {
    const id = Number(area.id);
    if (enPlan.has(id)) ambiguos.push(`«${area.area_name}» figura en el organigrama y también en eliminar`);
    const bloqueos = [];
    const quedan = users.filter((u) => Number(u.work_area_id) === id && !destinoDe.has(Number(u.id)));
    if (quedan.length) bloqueos.push(`le quedan ${quedan.map(nombreDe).join(", ")}`);
    const hijas = areas.filter(
      (a) => Number(a.parent_area_id) === id && !enPlan.has(Number(a.id)) && !idsBorrar.has(Number(a.id)),
    );
    if (hijas.length) bloqueos.push(`dependen de ella ${hijas.map((a) => a.area_name).join(", ")}`);
    const nDocs = docsPorArea.get(id) || 0;
    if (nDocs) bloqueos.push(`tiene ${nDocs} documento(s)`);
    return { area, bloqueos };
  });
}

/** Color de un área nueva: el de su nombre histórico o un tono claro del padre. */
function colorParaNueva(nombre, colorPadre) {
  const porNombre = resolveAreaColor(null, nombre);
  if (porNombre !== DEFAULT_COLOR) return porNombre;
  if (!colorPadre) return DEFAULT_COLOR;
  const { h, s } = hexToHsl(colorPadre);
  return hslToHex(h, s, 58);
}

function imprimirPlan({ plan, borrar, areaPorId, users }) {
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
      if (nodo.existente.area_name !== nodo.area) {
        lineas.push(`nombre: ${nodo.existente.area_name} → ${nodo.area}`);
      }
      const padreActual = nombreArea(nodo.existente.parent_area_id);
      const padreNuevo = nodo.padre || "ninguna";
      if (normalizeAreaName(padreActual) !== normalizeAreaName(padreNuevo)) {
        lineas.push(`depende de: ${padreActual} → ${padreNuevo}`);
      }
      const jefeNuevo = nodo.jefe ? nodo.jefe.id : null;
      if (Number(nodo.existente.manager_user_id || 0) !== Number(jefeNuevo || 0)) {
        lineas.push(`jefe: ${nombreUsuario(nodo.existente.manager_user_id)} → ${nombreUsuario(jefeNuevo)}`);
      }
      const ordenActual = nodo.existente.sort_order == null ? null : Number(nodo.existente.sort_order);
      if (ordenActual !== nodo.orden) {
        lineas.push(`orden: ${ordenActual ?? "sin orden"} → ${nodo.orden ?? "sin orden"}`);
      }
    }
    if (lineas.length) cambios += 1;
    const jefe = nodo.jefe
      ? nombreDe(nodo.jefe)
      : nodo.jefeNombre
        ? "SIN JEFE (no encontrado)"
        : "— (aprueba el área superior)";
    console.log(`${sangria}${nodo.area} · jefe ${jefe}${lineas.length ? `   [${lineas.join("; ")}]` : ""}`);
  }

  if (borrar.length) {
    console.log("");
    console.log("Áreas que se eliminan");
    console.log("─".repeat(72));
    for (const { area, bloqueos } of borrar) {
      cambios += 1;
      console.log(`  ${area.area_name}${bloqueos.length ? `   [NO SE PUEDE: ${bloqueos.join("; ")}]` : ""}`);
    }
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

async function aplicar({ plan, borrar }) {
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
        `UPDATE work_areas
            SET area_name = $1, parent_area_id = $2, manager_user_id = $3, sort_order = $4
          WHERE id = $5`,
        [nodo.area, padreId, nodo.jefe ? nodo.jefe.id : null, nodo.orden, id],
      );
      const ids = nodo.miembros.map((u) => u.id);
      if (ids.length) {
        await client.query("UPDATE users SET work_area_id = $1 WHERE id = ANY($2::int[])", [id, ids]);
      }
    }

    // Las que se eliminan pueden depender unas de otras: se descuelgan antes
    // de borrarlas para que el orden de borrado no importe.
    const idsBorrar = borrar.map((b) => Number(b.area.id));
    if (idsBorrar.length) {
      await client.query("UPDATE work_areas SET parent_area_id = NULL WHERE id = ANY($1::int[])", [idsBorrar]);
      await client.query("DELETE FROM work_areas WHERE id = ANY($1::int[])", [idsBorrar]);
      for (const { area } of borrar) logger.info("organigrama", `Área eliminada: ${area.area_name} (#${area.id})`);
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
    logger.error("organigrama", "Hay nombres ambiguos o repetidos; corrige el organigrama antes de seguir:");
    for (const linea of datos.ambiguos) console.log(`  ${linea}`);
    process.exitCode = 1;
    return;
  }

  const cambios = imprimirPlan(datos);

  const bloqueadas = datos.borrar.filter((b) => b.bloqueos.length);
  if (bloqueadas.length) {
    console.log("");
    logger.error("organigrama", "Hay áreas en eliminar que no quedan vacías; corrige el organigrama antes de seguir.");
    process.exitCode = 1;
    return;
  }

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
