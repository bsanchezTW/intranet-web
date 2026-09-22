#!/usr/bin/env node
/**
 * Elenco de prueba para demostrar el módulo de vacaciones de Perú.
 *
 *   node scripts/demo-vacaciones.js --country=PE --sembrar
 *   node scripts/demo-vacaciones.js --country=PE --excel
 *   node scripts/demo-vacaciones.js --country=PE --estado
 *   node scripts/demo-vacaciones.js --country=PE --limpiar
 *
 * Crea colaboradores ficticios elegidos para que cada caso del módulo se vea en
 * pantalla —el que cuadra con el Excel de RR.HH., el que todavía no cumple el
 * año, el que tiene el historial mal cargado— y genera un Excel de importación
 * que calza con ellos, con filas buenas y filas rotas a propósito.
 *
 * Todo lo que siembra queda marcado (correo `demo.*@demo.invalid`, documentos
 * 90000001+) y `--limpiar` lo borra entero: colaboradores, períodos,
 * solicitudes, historial, ajustes, bitácora y lotes de importación. No toca
 * ninguna fila que no haya creado él mismo.
 *
 * Los colaboradores se crean SIN contraseña: sirven para verlos desde la
 * gestión de RR.HH., no para iniciar sesión.
 */

const path = require("path");
const fs = require("fs");
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
const DEMO_FILE_TAG = "DEMO-";
const EXCEL_NAME = "DEMO-vacaciones-historicas.xlsx";

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
const { buildWorkbook } = require("../src/services/exports/excelWorkbook");
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
 * Cada persona demuestra un caso distinto del módulo. El campo `historial` se
 * carga por el importador de Excel, no por aquí: la gracia de la demostración
 * es verlo entrar.
 */
const ELENCO = [
  {
    doc: "90000001",
    nombre: "Ana",
    apellido: "Pérez Quispe",
    ingreso: ingresoHace(8, 6),
    caso: "El caso de la reunión: mucha antigüedad y casi todo ya gozado.",
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
    // 45 días contra 30 generados. Los meses van dentro de su año de servicio
    // para que las filas sean válidas: el error que se quiere mostrar es el
    // exceso, no una fecha anterior al ingreso.
    historial: [
      { anio: 0, mes: "Enero", dias: 25 },
      { anio: 0, mes: "Abril", dias: 20 },
    ],
  },
];

/** Filas rotas a propósito, para que la vista previa muestre cada error. */
const FILAS_CON_ERROR = [
  { documento: "90009999", nombre: "No existe en la intranet", anio: -2, mes: "Marzo", dias: 10 },
  { documento: "", nombre: "Sin documento", anio: -2, mes: "Marzo", dias: 10 },
  { documento: "90000001", nombre: "Ana Pérez Quispe", anio: -2, mes: "Marzoo", dias: 10 },
  { documento: "90000002", nombre: "Luis Quispe Mamani", anio: -1, mes: "Mayo", dias: 0 },
  { documento: "90000003", nombre: "Rosa Ccahuana Flores", anio: -30, mes: "Abril", dias: 10 },
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
    const saldo = await balanceService.getBalanceSummary(id);
    logger.info(
      "demo",
      `${persona.nombre} ${persona.apellido} (#${id}, doc ${persona.doc}) ` +
        `ingreso ${persona.ingreso} · genera ${saldo.generatedDays} · ${persona.caso}`,
    );
  }

  console.log("");
  logger.info("demo", `${ELENCO.length} colaboradores de prueba creados, sin historial todavía.`);
  logger.info("demo", "Siguiente: --excel, y luego impórtalo desde la intranet.");
}

function correoDemo(persona) {
  const slug = `${persona.nombre}.${persona.apellido.split(" ")[0]}`
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
  return `demo.${slug}${DEMO_EMAIL_SUFFIX}`;
}

// ===========================================================================
// Excel de importación
// ===========================================================================

async function generarExcel() {
  const anioActual = Number(todayInCountry().slice(0, 4));
  const filas = [];

  for (const persona of ELENCO) {
    for (const h of persona.historial) {
      filas.push({
        documento: persona.doc,
        nombre: `${persona.nombre} ${persona.apellido}`,
        anio: anioActual - h.anio,
        mes: h.mes,
        dias: h.dias,
        desde: "",
        hasta: "",
        observacion: "Vacaciones registradas en Excel",
      });
    }
  }

  // Un duplicado exacto de la primera fila: la vista previa lo marca en ámbar
  // y por defecto no lo importa.
  if (filas.length > 0) filas.push({ ...filas[0] });

  for (const rota of FILAS_CON_ERROR) {
    filas.push({
      documento: rota.documento,
      nombre: rota.nombre,
      anio: rota.anio < -25 ? 1900 : anioActual + rota.anio,
      mes: rota.mes,
      dias: rota.dias,
      desde: "",
      hasta: "",
      observacion: "",
    });
  }

  const buffer = await buildWorkbook([
    {
      name: "Historial",
      columns: [
        { header: "documento", key: "documento", width: 14 },
        { header: "nombre", key: "nombre", width: 30 },
        { header: "anio", key: "anio", width: 10 },
        { header: "mes", key: "mes", width: 14 },
        { header: "dias", key: "dias", width: 10 },
        { header: "desde", key: "desde", width: 14 },
        { header: "hasta", key: "hasta", width: 14 },
        { header: "observacion", key: "observacion", width: 36 },
      ],
      rows: filas,
    },
  ]);

  const destino = path.join(ROOT, EXCEL_NAME);
  fs.writeFileSync(destino, buffer);

  const buenas = filas.length - FILAS_CON_ERROR.length;
  logger.info("demo", `Excel escrito en ${destino}`);
  logger.info(
    "demo",
    `${filas.length} filas: ${buenas - 1} válidas, 1 duplicada y ${FILAS_CON_ERROR.length} con error.`,
  );
  logger.info(
    "demo",
    "Súbelo en RRHH › Vacaciones › Importar historial y revisa la vista previa antes de confirmar.",
  );
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

  const excel = path.join(ROOT, EXCEL_NAME);
  if (fs.existsSync(excel)) {
    fs.unlinkSync(excel);
    logger.info("demo", `${EXCEL_NAME} eliminado.`);
  }
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

/** Lotes de importación generados por este script. */
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
  if (args.excel) return generarExcel();
  if (args.estado) return estado();
  if (args.limpiar) return limpiar();

  console.log(`
Elenco de prueba del módulo de vacaciones de Perú.

  --sembrar   Crea 5 colaboradores ficticios, cada uno con un caso distinto
  --excel     Genera ${EXCEL_NAME} para importarlo desde la intranet
  --estado    Muestra el saldo de cada uno en la consola
  --limpiar   Borra todo lo que creó el script, incluido el Excel

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
