-- Vaciar las galerías de eventos para liberar cuota de Storage.
-- Se corre a mano en el SQL Editor del proyecto INTRANET, un paso a la vez.
--
-- Las fotos y videos de cada evento están en eventos/<slug>/ en los buckets
-- intranet-content (Chile) e intranet-content-pe (Perú). Los eventos en sí
-- (shared.events) no se tocan; los que se vacíen quedan sin portada.
--
-- NO usar DELETE FROM storage.objects: Supabase lo bloquea, y si se fuerza
-- solo borra la fila, no el archivo. El archivo sigue ocupando cuota y ya no
-- se puede borrar desde la API. Por eso el paso 2 borra a través de la API de
-- Storage (pg_net), que elimina el archivo y la fila.


-- ═══ PASO 1 · Ver qué ocupa espacio (solo lectura) ═══════════════════════════

-- 1a. Por carpeta de primer nivel, para ver si las galerías son el problema.
SELECT bucket_id,
       split_part(name, '/', 1)                          AS carpeta,
       count(*)                                          AS archivos,
       pg_size_pretty(sum((metadata->>'size')::bigint))  AS tamano
FROM storage.objects
GROUP BY 1, 2
ORDER BY sum((metadata->>'size')::bigint) DESC NULLS LAST;

-- 1b. Por galería de evento, de la más pesada a la más liviana.
SELECT bucket_id,
       split_part(name, '/', 2)                                         AS galeria,
       count(*)                                                         AS archivos,
       count(*) FILTER (WHERE metadata->>'mimetype' LIKE 'video/%')     AS videos,
       pg_size_pretty(sum((metadata->>'size')::bigint))                 AS tamano,
       pg_size_pretty(sum((metadata->>'size')::bigint)
         FILTER (WHERE metadata->>'mimetype' LIKE 'video/%'))           AS tamano_videos
FROM storage.objects
WHERE bucket_id IN ('intranet-content', 'intranet-content-pe')
  AND name LIKE 'eventos/%'
GROUP BY 1, 2
ORDER BY sum((metadata->>'size')::bigint) DESC NULLS LAST;


-- ═══ PASO 2 · Borrar ═════════════════════════════════════════════════════════
-- Antes de correrlo:
--   · Pega la Secret key (Settings → API Keys) en lugar de PEGA_AQUI_LA_SECRET_KEY.
--     sirven sb_secret_... o la service_role legacy. No guardes la consulta
--     con la clave puesta.
--   · Descomenta los filtros si no quieres borrar todas las galerías.
-- Encola un DELETE por archivo; pg_net los envía en segundo plano en unos
-- segundos o minutos, según la cantidad.

CREATE EXTENSION IF NOT EXISTS pg_net;

WITH cfg AS (
  SELECT 'https://dgadjvptxhotjylwsglx.supabase.co' AS url,
         'PEGA_AQUI_LA_SECRET_KEY'                  AS clave
),
objetivo AS (
  SELECT o.bucket_id, o.name
  FROM storage.objects o
  WHERE o.bucket_id IN ('intranet-content', 'intranet-content-pe')
    AND o.name LIKE 'eventos/%'
    -- AND o.bucket_id = 'intranet-content'                    -- solo Chile
    -- AND split_part(o.name, '/', 2) IN ('slug-1', 'slug-2')  -- solo esas galerías
    -- AND o.metadata->>'mimetype' LIKE 'video/%'              -- solo videos
    AND o.name ~ '^[A-Za-z0-9._/-]+$'  -- nombres que no necesitan codificarse en la URL
),
encolados AS (
  SELECT net.http_delete(
           url := cfg.url || '/storage/v1/object/' || objetivo.bucket_id || '/' || objetivo.name,
           headers := CASE
             WHEN cfg.clave LIKE 'sb_secret_%' THEN jsonb_build_object('apikey', cfg.clave)
             ELSE jsonb_build_object('apikey', cfg.clave,
                                     'Authorization', 'Bearer ' || cfg.clave)
           END,
           timeout_milliseconds := 60000
         ) AS request_id
  FROM objetivo CROSS JOIN cfg
  WHERE cfg.clave <> 'PEGA_AQUI_LA_SECRET_KEY'
)
SELECT count(*) AS borrados_encolados FROM encolados;


-- ═══ PASO 3 · Revisar el resultado ═══════════════════════════════════════════

-- 3a. Respuestas de la API. 200 = borrado. 402 o un mensaje de "restricted" /
--     "exceed_..._quota" = el proyecto está restringido y Supabase no deja
--     borrar ni por la API (ver nota al final). 401/403 = clave equivocada.
--     Si sale vacío, espera unos segundos y vuelve a correrlo.
SELECT status_code,
       count(*)                 AS respuestas,
       min(left(content, 200))  AS ejemplo
FROM net._http_response
WHERE created > now() - interval '1 hour'
GROUP BY status_code
ORDER BY status_code;

-- 3b. Lo que quedó en las galerías (vuelve a correr el 1b para ver tamaños).
--     Si quedan archivos con nombres raros (espacios, tildes), el paso 2 los
--     saltó: bórralos desde Storage en el dashboard.
SELECT bucket_id, name
FROM storage.objects
WHERE bucket_id IN ('intranet-content', 'intranet-content-pe')
  AND name LIKE 'eventos/%'
ORDER BY 1, 2
LIMIT 200;

-- Nota: si el paso 3a responde 402 / restricted, la restricción por cuota está
-- bloqueando la API de Storage. Hay que subir el plan temporalmente (o pedir a
-- soporte que levante la restricción), repetir el paso 2 y luego volver a bajar
-- el plan. El uso que muestra el dashboard puede tardar en actualizarse.
