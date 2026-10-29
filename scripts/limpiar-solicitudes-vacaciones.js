#!/usr/bin/env node
/**
 * Deja las vacaciones de un país en blanco después de las pruebas: sin
 * solicitudes de la intranet y con sólo el historial importado.
 *
 *   node scripts/limpiar-solicitudes-vacaciones.js --country=PE [--borrar-usuario=614793]
 *   node scripts/limpiar-solicitudes-vacaciones.js --country=PE --borrar-usuario=614793 --confirmar --respaldo=limpieza.json
 *
 * Sin --confirmar sólo cuenta lo que borraría. Con --confirmar, en una sola
 * transacción:
 *   1. borra TODAS las solicitudes del país;
 *   2. borra el historial que no vino de una importación (MANUAL, ADJUSTMENT)
 *      y su bitácora;
 *   3. si se pide, borra a un colaborador de prueba con todo lo suyo
 *      (períodos, historial, referencias, ajustes, bitácora) y luego a él;
 *   4. pone used_days en cero —por definición son sólo días de solicitudes—
 *      y reconstruye historical_used_days y los bloques 15+15 de cada
 *      colaborador con reimputeHistoricalDays, la misma lógica de la app.
 *
 * No toca el historial importado, los lotes de importación, los ajustes de
 * saldo ni los saldos de referencia de los demás colaboradores.
 */

const fs = require("fs");
const path = require("path");
const dotenv = require("dotenv");
const logger = require("../src/utils/logger");
const { isValidCountryCode } = require("../src/config/country");
const {
  getCountryDbBinding,
  applyCountryPoolerUser,
} = require("../src/config/supabaseProjects");

const ROOT = path.join(__dirname, "..");

function parseArgs(argv) {
  const args = {};
  for (const arg of argv.slice(2)) {
    const match = arg.match(/^--([^=]+)(?:=(.*))?$/);
    if (match) args[match[1]] = match[2] ?? true;
  }
  return args;
}

const args = parseArgs(process.argv);
const country = String(args.country || "").trim().toUpperCase();
const usuarioABorrar = args["borrar-usuario"] ? Number(args["borrar-usuario"]) : null;

if (!isValidCountryCode(country) || (usuarioABorrar !== null && !Number.isInteger(usuarioABorrar))) {
  logger.error(
    "limpiar",
    "Uso: node scripts/limpiar-solicitudes-vacaciones.js --country=PE [--borrar-usuario=ID] [--confirmar]",
  );
  process.exit(1);
}

dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });
process.env.COUNTRY = country;
applyCountryPoolerUser(process.env);

const db = require("../src/db");
const balanceService = require("../src/services/vacations/vacationBalanceService");
const { HISTORY_ORIGIN } = require("../src/constants/vacationHistory");

// Sólo se borra a alguien cuyo nombre lo marque como cuenta de prueba: un id
// mal tipeado no puede llevarse por delante a una persona real.
const TEST_NAME_PATTERN = "%dummy%";

async function contar(client, sql, params) {
  const { rows } = await client.query(sql, params);
  return rows;
}

async function resumen(client, usuario) {
  const solicitudes = await contar(
    client,
    `SELECT status, COUNT(*)::int AS n FROM vacation_requests
      WHERE country_code = $1 GROUP BY status ORDER BY status`,
    [country],
  );
  const historial = await contar(
    client,
    `SELECT origin, (deleted_at IS NOT NULL) AS borrado, COUNT(*)::int AS n
       FROM vacation_history WHERE country_code = $1
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [country],
  );
  const [usados] = await contar(
    client,
    `SELECT COUNT(*)::int AS periodos, COALESCE(SUM(used_days), 0) AS dias
       FROM vacation_periods WHERE country_code = $1 AND used_days > 0`,
    [country],
  );
  return { solicitudes, historial, periodosConUsedDays: usados, usuario };
}

async function buscarUsuario(client) {
  if (usuarioABorrar === null) return null;
  const { rows } = await client.query(
    `SELECT id, first_name, last_name, email FROM users WHERE id = $1`,
    [usuarioABorrar],
  );
  const usuario = rows[0];
  if (!usuario) throw new Error(`No existe el usuario ${usuarioABorrar}.`);
  const { rows: [ok] } = await client.query(
    `SELECT (COALESCE(first_name, '') || ' ' || COALESCE(last_name, '')) ILIKE $2 AS es_prueba
       FROM users WHERE id = $1`,
    [usuarioABorrar, TEST_NAME_PATTERN],
  );
  if (!ok.es_prueba) {
    throw new Error(
      `El usuario ${usuarioABorrar} (${usuario.first_name} ${usuario.last_name}) no parece de prueba; no se borra.`,
    );
  }
  return usuario;
}

async function borrarUsuario(client, userId) {
  const ids = [userId];
  const q = async (sql) => (await client.query(sql, [ids])).rowCount;
  // De las hijas hacia el padre: con ON DELETE SET NULL, borrar primero al
  // usuario dejaría períodos y registros huérfanos.
  return {
    bitacora: await q("DELETE FROM vacation_history_audit WHERE user_id = ANY($1::int[])"),
    referencias: await q("DELETE FROM vacation_reference_balances WHERE user_id = ANY($1::int[])"),
    historial: await q("DELETE FROM vacation_history WHERE user_id = ANY($1::int[])"),
    ajustes: await q(
      `DELETE FROM vacation_balance_adjustments
        WHERE vacation_period_id IN (SELECT id FROM vacation_periods WHERE user_id = ANY($1::int[]))`,
    ),
    periodos: await q("DELETE FROM vacation_periods WHERE user_id = ANY($1::int[])"),
    usuario: await q("DELETE FROM users WHERE id = ANY($1::int[])"),
  };
}

async function main() {
  const binding = getCountryDbBinding(country);
  logger.info("limpiar", `${country} · schema=${binding.schema}`);

  const client = await db.getClient();
  try {
    const usuario = await buscarUsuario(client);
    console.log("Antes:", JSON.stringify(await resumen(client, usuario), null, 2));

    if (!args.confirmar) {
      console.log(
        "\nSeco: borraría todas las solicitudes, el historial que no sea IMPORTED" +
          (usuario ? ` y al usuario ${usuario.id}` : "") +
          ". Repite con --confirmar para hacerlo.",
      );
      return;
    }

    await client.query("BEGIN");

    const { rows: solicitudes } = await client.query(
      `SELECT * FROM vacation_requests WHERE country_code = $1 ORDER BY id FOR UPDATE`,
      [country],
    );
    const { rows: historialNoImportado } = await client.query(
      `SELECT * FROM vacation_history WHERE country_code = $1 AND origin <> $2 ORDER BY id FOR UPDATE`,
      [country, HISTORY_ORIGIN.IMPORTED],
    );
    if (args.respaldo) {
      const destino = path.resolve(String(args.respaldo));
      fs.writeFileSync(
        destino,
        JSON.stringify({ solicitudes, historialNoImportado, usuario }, null, 2),
      );
      console.log(`Respaldo: ${destino}`);
    }

    const { rowCount: solicitudesBorradas } = await client.query(
      "DELETE FROM vacation_requests WHERE country_code = $1",
      [country],
    );

    const idsHistorial = historialNoImportado.map((r) => r.id);
    const { rowCount: bitacoraBorrada } = await client.query(
      "DELETE FROM vacation_history_audit WHERE vacation_history_id = ANY($1::int[])",
      [idsHistorial],
    );
    const { rowCount: historialBorrado } = await client.query(
      "DELETE FROM vacation_history WHERE id = ANY($1::int[])",
      [idsHistorial],
    );

    const usuarioBorrado = usuario ? await borrarUsuario(client, usuario.id) : null;

    await client.query(
      `UPDATE vacation_periods SET used_days = 0, updated_at = NOW()
        WHERE country_code = $1 AND used_days <> 0`,
      [country],
    );
    // Sin solicitudes, los bloques 15+15 quedan sólo con lo del historial.
    const { rows: colaboradores } = await client.query(
      `SELECT DISTINCT user_id FROM vacation_periods
        WHERE country_code = $1 AND user_id IS NOT NULL ORDER BY user_id`,
      [country],
    );
    for (const { user_id: userId } of colaboradores) {
      await balanceService.reimputeHistoricalDays(userId, client);
    }

    await client.query("COMMIT");

    console.log("\nBorrado:", {
      solicitudes: solicitudesBorradas,
      historialNoImportado: historialBorrado,
      bitacoraDeEseHistorial: bitacoraBorrada,
      usuario: usuarioBorrado,
      colaboradoresRecalculados: colaboradores.length,
    });
    console.log("Después:", JSON.stringify(await resumen(client, null), null, 2));
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    logger.error("limpiar", err.stack || err.message);
    process.exit(1);
  });
