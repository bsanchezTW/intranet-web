/**
 * Limitador de ventana fija en memoria.
 *
 *   const limiter = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5 });
 *   limiter.hit(key)     → { allowed, remaining, retryAfterMs } (cuenta el intento)
 *   limiter.check(key)   → igual, sin contar
 *   limiter.reset(key)   → olvida la clave (p. ej. tras un login correcto)
 *
 * Límite: vive en el proceso. Con varios procesos cada uno cuenta por su lado,
 * así que el tope efectivo es max × procesos. Sirve para frenar fuerza bruta y
 * abuso; lo que no puede fallar (los intentos contra un código) se cuenta en
 * la base.
 */

const MAX_KEYS = 50000;

function createRateLimiter({ windowMs, max, now = () => Date.now() }) {
  if (!(windowMs > 0) || !(max > 0)) {
    throw new Error("createRateLimiter: windowMs y max deben ser positivos");
  }
  const buckets = new Map();

  function prune(at) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= at) buckets.delete(key);
    }
  }

  function current(key, at) {
    const bucket = buckets.get(key);
    if (bucket && bucket.resetAt > at) return bucket;
    return null;
  }

  function result(bucket, at) {
    const count = bucket ? bucket.count : 0;
    const allowed = count <= max;
    return {
      allowed,
      remaining: Math.max(0, max - count),
      retryAfterMs: allowed || !bucket ? 0 : bucket.resetAt - at,
    };
  }

  function hit(key) {
    const at = now();
    let bucket = current(key, at);
    if (!bucket) {
      if (buckets.size >= MAX_KEYS) prune(at);
      // Si aun así no hay espacio, se descarta la más antigua: mejor olvidar
      // un contador que crecer sin tope con claves inventadas.
      if (buckets.size >= MAX_KEYS) buckets.delete(buckets.keys().next().value);
      bucket = { count: 0, resetAt: at + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    return result(bucket, at);
  }

  function check(key) {
    const at = now();
    const bucket = current(key, at);
    // Sin contar: ya bloqueado si se alcanzó el tope.
    if (!bucket) return result(null, at);
    const blocked = bucket.count >= max;
    return {
      allowed: !blocked,
      remaining: Math.max(0, max - bucket.count),
      retryAfterMs: blocked ? bucket.resetAt - at : 0,
    };
  }

  function reset(key) {
    buckets.delete(key);
  }

  function clear() {
    buckets.clear();
  }

  return { hit, check, reset, clear, size: () => buckets.size };
}

module.exports = { createRateLimiter };
