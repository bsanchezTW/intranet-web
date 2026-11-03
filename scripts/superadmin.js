#!/usr/bin/env node
/**
 * Recuperación de acceso desde el servidor: marca o quita a un superadmin.
 *
 *   node scripts/superadmin.js --pais CL --correo persona@transworld.cl
 *   node scripts/superadmin.js --pais PE --correo persona@transworld.pe --quitar
 *
 * Reemplaza al login de emergencia (AUTH_USER/AUTH_PASS), que se eliminó:
 * para recuperar la Gestión de Permisos hace falta acceso al servidor, no una
 * contraseña compartida. La cuenta debe existir y estar habilitada. El cambio
 * queda en perm_audit. Quitar no deja la intranet sin superadmin activo.
 */

const path = require("path");
const dotenv = require("dotenv");

const ROOT = path.join(__dirname, "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });
dotenv.config({ path: path.join(ROOT, ".env.local"), quiet: true });

function leerArg(nombre) {
  const i = process.argv.indexOf(nombre);
  return i >= 0 ? String(process.argv[i + 1] || "") : "";
}

const USO = "Uso: node scripts/superadmin.js --pais CL|PE --correo persona@dominio [--quitar]";
const PAIS = leerArg("--pais").toUpperCase();
const CORREO = leerArg("--correo");
if (!["CL", "PE"].includes(PAIS) || !CORREO) {
  console.error(USO);
  process.exit(1);
}
process.env.COUNTRY = PAIS;
require("../src/config/supabaseProjects").applyCountryPoolerUser(process.env);

const QUITAR = process.argv.includes("--quitar");
const db = require("../src/db");
const store = require("../src/services/permissions/store");
const { ensurePermissionSchema } = require("../src/services/permissions/permissionSchema");
const { markSuperadminByEmail } = require("../src/services/permissions/breakGlass");

(async () => {
  try {
    await ensurePermissionSchema();
    const user = await markSuperadminByEmail({ db, store, email: CORREO, remove: QUITAR });
    const nombre = [user.first_name, user.last_name].filter(Boolean).join(" ") || user.email;
    console.log(`${QUITAR ? "Ya no es superadmin" : "Superadmin"}: ${nombre} <${user.email}> (#${user.id}) en ${PAIS}.`);
    process.exitCode = 0;
  } catch (err) {
    console.error(err.message || err);
    process.exitCode = 1;
  } finally {
    await db.pool.end().catch(() => {});
  }
})();
