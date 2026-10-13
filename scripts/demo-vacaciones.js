#!/usr/bin/env node
/**
 * Elenco de prueba para demostrar el módulo de vacaciones de Perú.
 *
 *   node scripts/demo-vacaciones.js --country=PE --sembrar
 *   node scripts/demo-vacaciones.js --country=PE --estado
 *   node scripts/demo-vacaciones.js --country=PE --limpiar
 *
 * Crea colaboradores ficticios elegidos para que cada caso del módulo se vea en
 * pantalla —el que cuadra con la planilla de RR.HH., el que todavía no cumple
 * el año, el que tiene el historial mal cargado— con parte de su historial ya
 * registrado y saldos de referencia para conciliar. Uno queda sin historial a
 * propósito, para probar la carga por lotes desde su ficha.
 *
 * Todo lo que siembra queda marcado (correo `demo.*@demo.invalid`, documentos
 * 90000001+) y `--limpiar` lo borra entero: colaboradores, períodos,
 * solicitudes, historial, referencias, ajustes y bitácora. No toca ninguna
 * fila que no haya creado él mismo.
 *
 * Los colaboradores se crean SIN contraseña: sirven para verlos desde la
 * gestión de RR.HH., no para iniciar sesión.
 */

const path = require("path");
const dotenv = require("dotenv");
const logger = require("../src/utils/logger");
const { isValidCountryCode } = require("../src/config/country");
const {
  getCountryDbBinding,
  applyCountryPoolerUser,
} = require("../src/config/supabaseProjects");

const ROOT = path.join(__dirname, "..");

// --- marcas del elenco de prueba -------------------------------------------
// Dominio reservado por la RFC 2606: ningún correo real puede terminar así, de
// modo que el borrado no puede llevarse por delante a una persona de verdad.
const DEMO_EMAIL_SUFFIX = "@demo.invalid";
const DEMO_DOC_PREFIX = "9000"; // documentos 9000xxxx, fuera de cualquier DNI real
// Lotes del importador Excel (ya retirado) que sembraban versiones anteriores
// de este script: --limpiar los sigue borrando.
const DEMO_FILE_TAG = "DEMO-";

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) args[match[1]] = match[2] ?? true;
  }
  return args;
}

const args = parseArgs(process.argv);
const country = String(args.country || "PE").trim().toUpperCase();

if (!isValidCountryCode(country)) {
  logger.error("demo", "Uso: node scripts/demo-vacaciones.js --country=PE --sembrar");
  process.exit(1);
}
if (country !== "PE") {
  logger.error("demo", "El elenco de prueba es del módulo de Perú (--country=PE).");
  process.exit(1);
}

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });
process.env.COUNTRY = country;
applyCountryPoolerUser(process.env);

const db = require("../src/db");
const balanceService = require("../src/services/vacations/vacationBalanceService");
const reportService = require("../src/services/vacations/vacationReportService");
const historyService = require("../src/services/vacations/vacationHistoryService");
const referenceService = require("../src/services/vacations/vacationReferenceService");
const { parseMonth } = require("../src/constants/vacationHistory");
const { todayInCountry } = require("../src/utils/vacationDateUtils");

// ===========================================================================
// El elenco
// ===========================================================================

/** Fecha de ingreso a N años y M meses de hoy, para que el caso no envejezca. */
function ingresoHace(anios, meses = 0) {
  const [y, m, d] = todayInCountry().split("-").map(Number);
  let mes = m - meses;
  let anio = y - anios;
  while (mes <= 0) {
    mes += 12;
    anio -= 1;
  }
  const dia = Math.min(d, 28); // evita el 29, 30 y 31 en meses cortos
  return `${anio}-${String(mes).padStart(2, "0")}-${String(dia).padStart(2, "0")}`;
}

/**
 * Cada persona demuestra un caso distinto del módulo. `historial` se registra
 * al sembrar, salvo en quien tiene `cargarAMano`: esas filas se imprimen para
 * cargarlas desde su ficha con «Cargar salidas». `referencia` es el saldo que
 * tendría anotado RR.HH. hoy (null = sin referencia).
 */
const ELENCO = [
  {
    doc: "90000001",
    nombre: "Ana",
    apellido: "Pérez Quispe",
    ingreso: ingresoHace(8, 6),
    caso: "El caso de la reunión: mucha antigüedad y casi todo ya gozado.",
    referencia: 60,
    historial: [
      { anio: 6, mes: "Marzo", dias: 15 },
      { anio: 6, mes: "Octubre", dias: 10 },
      { anio: 5, mes: "Abril", dias: 15 },
      { anio: 5, mes: "Diciembre", dias: 20 },
      { anio: 4, mes: "Febrero", dias: 30 },
      { anio: 3, mes: "Julio", dias: 30 },
      { anio: 2, mes: "Enero", dias: 30 },
      { anio: 1, mes: "Setiembre", dias: 30 },
    ],
  },
  {
    doc: "90000002",
    nombre: "Luis",
    apellido: "Quispe Mamani",
    ingreso: ingresoHace(2, 3),
    caso: "Los «2 años y 3 meses, 60 días acumulados» que mencionó RR.HH.",
    cargarAMano: true,
    referencia: 38,
    historial: [
      { anio: 1, mes: "Julio", dias: 15 },
      { anio: 1, mes: "Noviembre", dias: 7 },
    ],
  },
  {
    doc: "90000003",
    nombre: "Rosa",
    apellido: "Ccahuana Flores",
    ingreso: ingresoHace(3, 1),
    caso: "Sin historial previo: se ve el estado vacío y el saldo completo.",
    historial: [],
  },
  {
    doc: "90000004",
    nombre: "Jorge",
    apellido: "Medina Salas",
    ingreso: ingresoHace(0, 7),
    caso: "Todavía no cumple el año: no puede pedir días, solo acumula trunco.",
    historial: [],
  },
  {
    doc: "90000005",
    nombre: "Elena",
    apellido: "Vargas Ríos",
    ingreso: ingresoHace(1, 2),
    caso: "Historial que supera lo generado: dispara la alerta roja del resumen.",
    // La planilla decía 0: la referencia no cuadra y el resumen lo marca.
    referencia: 0,
    // 45 días contra 30 generados. Los meses van dentro de su año de servicio
    // para que las filas sean válidas: el error que se quiere mostrar es el
    // exceso, no una fecha anterior al ingreso.
    historial: [
      { anio: 0, mes: "Enero", dias: 25 },
      { anio: 0, mes: "Abril", dias: 20 },
    ],
  },
];

// ===========================================================================
// Sembrar
// ===========================================================================

async function sembrar() {
  const existentes = await idsDemo();
  if (existentes.length > 0) {
    logger.warn(
      "demo",
      `Ya hay ${existentes.length} colaborador(es) de prueba. Corre --limpiar antes de volver a sembrar.`,
    );
    return;
  }

  const { rows: areas } = await db.query(
    "SELECT id FROM work_areas ORDER BY id ASC LIMIT 1",
  );
  const areaId = areas[0] ? areas[0].id : null;

  const anioActual = Number(todayInCountry().slice(0, 4));
  const pendientesAMano = [];

  for (const persona of ELENCO) {
    const { rows } = await db.queryRetryIdCollision(
      `INSERT INTO users
         (first_name, last_name, email, role, email_confirmed, is_intranet_user,
          must_change_password, work_area_id, hire_date, national_id, work_days_per_week)
       VALUES ($1, $2, $3, 'Usuario', false, true, true, $4, $5, $6, 5)
       RETURNING id`,
      [
        persona.nombre,
        persona.apellido,
        correoDemo(persona),
        areaId,
        persona.ingreso,
        persona.doc,
      ],
    );
    const id = rows[0].id;
    await balanceService.recalculatePeriods(id);

    const filas = persona.historial.map((h) => ({
      month: `${anioActual - h.anio}-${String(parseMonth(h.mes)).padStart(2, "0")}`,
      days: String(h.dias),
      observation: "Planilla de RR.HH. (demo)",
    }));
    if (persona.cargarAMano) {
      pendientesAMano.push({ persona, filas });
    } else if (filas.length > 0) {
      const res = await historyService.createHistoryBatch({ userId: id, rows: filas, actorId: null });
      if (!res.ok) logger.warn("demo", `${persona.nombre}: ${res.errors.join(" ")}`);
    }
    if (persona.referencia != null) {
      await referenceService.createReference({
        userId: id,
        asOfDate: todayInCountry(),
        expectedDays: persona.referencia,
        note: "Planilla de RR.HH. (demo)",
        actorId: null,
      });
    }

    const saldo = await balanceService.getBalanceSummary(id);
    logger.info(
      "demo",
      `${persona.nombre} ${persona.apellido} (#${id}, doc ${persona.doc}) ` +
        `ingreso ${persona.ingreso} · genera ${saldo.generatedDays} · ${persona.caso}`,
    );
  }

  console.log("");
  logger.info("demo", `${ELENCO.length} colaboradores de prueba creados.`);
  for (const { persona, filas } of pendientesAMano) {
    logger.info(
      "demo",
      `Para probar la carga por lotes, abre la ficha de ${persona.nombre} ${persona.apellido} ` +
        `y carga: ${filas.map((f) => `${f.month} · ${f.days} d`).join(", ")}.`,
    );
  }
}

function correoDemo(persona) {
  const slug = `${persona.nombre}.${persona.apellido.split(" ")[0]}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return `demo.${slug}${DEMO_EMAIL_SUFFIX}`;
}

// ===========================================================================
// Estado
// ===========================================================================

async function estado() {
  const ids = await idsDemo();
  if (ids.length === 0) {
    logger.warn("demo", "No hay colaboradores de prueba. Corre --sembrar primero.");
    return;
  }

  const { rows } = await reportService.buildTeamReport();
  const demo = rows.filter((r) => ids.includes(r.id));

  console.log("");
  console.log(
    pad("Colaborador", 26) +
      pad("Ingreso", 12) +
      pad("Genera", 8) +
      pad("Histór.", 9) +
      pad("Intranet", 10) +
      pad("Saldo", 8) +
      pad("Trunco", 8) +
      "A liquidar",
  );
  console.log("─".repeat(94));
  for (const r of demo) {
    console.log(
      pad(r.name, 26) +
        pad(r.hireDateFmt, 12) +
        pad(r.generatedDays, 8) +
        pad(r.historicalUsedDays, 9) +
        pad(r.approvedUsedDays, 10) +
        pad(r.availableDays, 8) +
        pad(r.truncoDays, 8) +
        String(r.severanceDays) +
        (r.overDrawn ? "   ← historial mayor que lo generado" : ""),
    );
  }
  console.log("");
}

function pad(value, width) {
  return String(value).padEnd(width, " ");
}

// ===========================================================================
// Limpiar
// ===========================================================================

async function limpiar() {
  const ids = await idsDemo();
  const lotes = await lotesDemo();

  if (ids.length === 0 && lotes.length === 0) {
    logger.info("demo", "No hay nada de prueba que borrar.");
    return;
  }

  const client = await db.getClient();
  const borrados = {};
  try {
    await client.query("BEGIN");

    // De las hijas hacia el padre: si se borran los usuarios primero, las FK
    // con ON DELETE SET NULL dejarían períodos y solicitudes huérfanos.
    if (ids.length > 0) {
      borrados.bitacora = await borrar(
        client,
        "DELETE FROM vacation_history_audit WHERE user_id = ANY($1::int[])",
        ids,
      );
      borrados.referencias = await borrar(
        client,
        "DELETE FROM vacation_reference_balances WHERE user_id = ANY($1::int[])",
        ids,
      );
      borrados.historial = await borrar(
        client,
        "DELETE FROM vacation_history WHERE user_id = ANY($1::int[])",
        ids,
      );
      borrados.ajustes = await borrar(
        client,
        `DELETE FROM vacation_balance_adjustments
          WHERE vacation_period_id IN (
            SELECT id FROM vacation_periods WHERE user_id = ANY($1::int[]))`,
        ids,
      );
      borrados.solicitudes = await borrar(
        client,
        "DELETE FROM vacation_requests WHERE user_id = ANY($1::int[])",
        ids,
      );
      borrados.periodos = await borrar(
        client,
        "DELETE FROM vacation_periods WHERE user_id = ANY($1::int[])",
        ids,
      );
      borrados.colaboradores = await borrar(
        client,
        "DELETE FROM users WHERE id = ANY($1::int[])",
        ids,
      );
    }

    if (lotes.length > 0) {
      // El lote puede haber tocado a alguien que no es del elenco; sus filas se
      // marcan como borradas en vez de desaparecer, para no perder trazabilidad.
      await client.query(
        `UPDATE vacation_history SET deleted_at = NOW()
          WHERE import_batch_id = ANY($1::int[]) AND deleted_at IS NULL`,
        [lotes],
      );
      borrados.lotes = await borrar(
        client,
        "DELETE FROM vacation_history_imports WHERE id = ANY($1::int[])",
        lotes,
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    client.release();
    throw err;
  }
  client.release();

  for (const [que, cuantos] of Object.entries(borrados)) {
    if (cuantos > 0) logger.info("demo", `${que}: ${cuantos} fila(s) borradas`);
  }
  logger.info("demo", "Elenco de prueba eliminado.");
}

async function borrar(client, sql, params) {
  const res = await client.query(sql, [params]);
  return res.rowCount || 0;
}

/** Ids de los colaboradores de prueba. Nunca toca un correo real. */
async function idsDemo() {
  const { rows } = await db.query(
    `SELECT id FROM users
      WHERE email LIKE $1 AND national_id LIKE $2
      ORDER BY id`,
    [`%${DEMO_EMAIL_SUFFIX}`, `${DEMO_DOC_PREFIX}%`],
  );
  return rows.map((r) => r.id);
}

/** Lotes del importador que dejaron versiones anteriores de este script. */
async function lotesDemo() {
  const { rows } = await db.query(
    "SELECT id FROM vacation_history_imports WHERE file_name LIKE $1",
    [`${DEMO_FILE_TAG}%`],
  );
  return rows.map((r) => r.id);
}

// ===========================================================================

async function main() {
  const binding = getCountryDbBinding(country);
  logger.info("demo", `Perú · schema=${binding.schema}`);

  if (args.sembrar) return sembrar();
  if (args.estado) return estado();
  if (args.limpiar) return limpiar();

  console.log(`
Elenco de prueba del módulo de vacaciones de Perú.

  --sembrar   Crea 5 colaboradores ficticios, cada uno con un caso distinto
  --estado    Muestra el saldo de cada uno en la consola
  --limpiar   Borra todo lo que creó el script

Ejemplo:
  node scripts/demo-vacaciones.js --country=PE --sembrar
`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("demo", err);
    process.exit(1);
  });
