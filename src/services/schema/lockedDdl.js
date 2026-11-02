/**
 * DDL de "crear si no existe" sin carreras entre procesos.
 *
 * CREATE TABLE / CREATE INDEX IF NOT EXISTS no son seguros si dos procesos los
 * corren a la vez sobre una base donde la tabla aún no existe: los dos ven que
 * falta y uno choca con el otro en los catálogos (23505 en pg_type o en el
 * índice). Pasa en el primer despliegue con varios procesos de Passenger: dos
 * peticiones simultáneas crean la misma tabla y una responde 500.
 *
 * Los módulos que crean su tabla al primer uso (sesiones, cupo del asistente,
 * tareas, correo de soporte) sólo tienen db.query, sin un cliente propio para
 * abrir una transacción. Por eso todo va en UNA consulta de varias sentencias:
 * Postgres la ejecuta como una sola transacción implícita, y el lock asesor
 * de transacción del principio pone en fila a los procesos hasta el final.
 * Es de transacción (no de sesión) porque el pooler en modo transacción no
 * conserva un lock de sesión. La consulta va sin parámetros: así pg usa el
 * protocolo simple, el único que admite varias sentencias.
 *
 * `lockKey` identifica el recurso (el nombre calificado de la tabla) y es el
 * mismo para todos los procesos; las sentencias las arma el código, nunca el
 * usuario.
 */

const LOCK_KEY = /^[a-z_][a-z0-9_.]*$/;

function lockedDdl(lockKey, statements) {
  if (!LOCK_KEY.test(String(lockKey || ""))) {
    throw new Error(`lockedDdl: clave de lock inválida "${lockKey}"`);
  }
  const list = (Array.isArray(statements) ? statements : [statements])
    .map((sql) => String(sql || "").trim().replace(/;+\s*$/, ""))
    .filter(Boolean);
  if (!list.length) throw new Error("lockedDdl: faltan sentencias");
  return [`SELECT pg_advisory_xact_lock(hashtext('${lockKey}'))`, ...list].join(";\n") + ";";
}

module.exports = { lockedDdl };
