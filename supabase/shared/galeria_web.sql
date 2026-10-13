-- Aplicar una vez en el proyecto INTRANET (SQL Editor o supabase db query). Lo mismo queda en schema.sql.
-- Galería en la web pública de eventos (eventos.transworld.cl). Idempotente.
--
-- "Público" en la galería significa "lo ven Chile y Perú"; eso no lo publica en
-- internet. Un álbum sale a la web solo si alguien marca visible_web, y nunca
-- si es privado. La web lee con la clave publicable (rol anon):
--   · public.galeria_web()            álbumes marcados y sus archivos
--   · política galeria_web_lectura    firmar/leer solo archivos de esos álbumes
BEGIN;

ALTER TABLE shared.events
  ADD COLUMN IF NOT EXISTS visible_web boolean NOT NULL DEFAULT false;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'events_web_no_privado') THEN
    ALTER TABLE shared.events
      ADD CONSTRAINT events_web_no_privado CHECK (NOT (is_private AND visible_web));
  END IF;
END$$;

-- Las vistas de país expanden `*` al crearse: se recrean para incluir visible_web.
CREATE OR REPLACE VIEW chile.events
  WITH (security_invoker = true) AS
  SELECT * FROM shared.events
  WHERE is_private = false OR country_code = 'CL'
  WITH CHECK OPTION;

CREATE OR REPLACE VIEW peru.events
  WITH (security_invoker = true) AS
  SELECT * FROM shared.events
  WHERE is_private = false OR country_code = 'PE'
  WITH CHECK OPTION;

CREATE OR REPLACE FUNCTION public.galeria_web_album_visible(p_slug text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = shared, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1 FROM shared.events e
    WHERE e.slug = p_slug AND e.visible_web AND NOT e.is_private
  );
$$;

CREATE OR REPLACE FUNCTION public.galeria_web()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = shared, storage, pg_temp
AS $$
  SELECT COALESCE(jsonb_agg(album ORDER BY creado DESC), '[]'::jsonb)
  FROM (
    SELECT e.created_at AS creado, jsonb_build_object(
      'slug', e.slug,
      'nombre', e.name,
      'descripcion', e.description,
      'pais', e.country_code,
      'creado', to_char(e.created_at, 'YYYY-MM-DD"T"HH24:MI:SS'),
      'portada', e.image,
      'archivos', (
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
          'bucket', o.bucket_id,
          'ruta', o.name,
          'tipo', o.metadata->>'mimetype',
          'creado', to_char(o.created_at, 'YYYY-MM-DD"T"HH24:MI:SS')
        ) ORDER BY o.created_at, o.name), '[]'::jsonb)
        FROM storage.objects o
        WHERE o.bucket_id IN ('intranet-content', 'intranet-content-pe')
          AND left(o.name, char_length('eventos/' || e.slug || '/')) = 'eventos/' || e.slug || '/'
          AND (o.metadata->>'mimetype' LIKE 'image/%' OR o.metadata->>'mimetype' LIKE 'video/%')
      )
    ) AS album
    FROM shared.events e
    WHERE e.visible_web AND NOT e.is_private
  ) q;
$$;

ALTER FUNCTION public.galeria_web_album_visible(text) OWNER TO postgres;
ALTER FUNCTION public.galeria_web() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.galeria_web_album_visible(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.galeria_web() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.galeria_web_album_visible(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.galeria_web() TO anon, authenticated, service_role;

DROP POLICY IF EXISTS galeria_web_lectura ON storage.objects;
CREATE POLICY galeria_web_lectura ON storage.objects
  FOR SELECT TO anon
  USING (
    bucket_id IN ('intranet-content', 'intranet-content-pe')
    AND left(name, char_length('eventos/')) = 'eventos/'
    AND public.galeria_web_album_visible(split_part(name, '/', 2))
  );

COMMIT;
