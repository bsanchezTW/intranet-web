const express = require('express');
const multer = require('multer');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const db = require('../db');
const fileStorage = require('../services/fileStorage');
const requireRole = require('../middlewares/requireRole');
const { UPLOAD_LIMITS_BYTES } = require('../config/uploadLimits');
const { EVENTO_VIEW_COLUMNS } = require('../utils/schemaMappers');

const router = express.Router();
const WRITE_ROLES = ['admin'];

const EVENT_UPLOAD_TEMP_DIR = path.join(os.tmpdir(), 'transworld-intranet-events');
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    fs.mkdir(EVENT_UPLOAD_TEMP_DIR, { recursive: true })
      .then(() => cb(null, EVENT_UPLOAD_TEMP_DIR), cb);
  },
  filename: (_req, _file, cb) => {
    cb(null, `${Date.now()}-${crypto.randomUUID()}.upload`);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_LIMITS_BYTES.EVENT_MEDIA },
});

function createSlug(text) {
  return String(text || '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^\w\-]+/g, '')
    .replace(/\-\-+/g, '-');
}

function eventFieldsFromBody(body = {}) {
  const name = String(body.name ?? body.nombre ?? '').trim();
  const description = body.description ?? body.descripcion ?? null;
  return { name, description };
}

// Normaliza imágenes enviadas desde el front
function parseDirectUploadedImages(body) {
  if (!body) return [];
  let candidate = body.images || body.uploadedImages || body.fotos || body.photos;
  if (typeof candidate === 'string') {
    try { candidate = JSON.parse(candidate); } catch (e) { candidate = null; }
  }
  if (candidate && !Array.isArray(candidate) && typeof candidate === 'object') {
    candidate = [candidate];
  }
  if (!Array.isArray(candidate)) return [];

  return candidate
    .map((img) => {
      const secure_url = img.secure_url || img.url || img.secureUrl;
      const public_id = img.public_id || img.publicId;
      const resource_type = img.resource_type || 'image'; 
      return { secure_url, public_id, resource_type };
    })
    .filter((img) => img.secure_url && img.public_id);
}

// ==========================================
// RUTAS
// ==========================================

router.get('/', (req, res) => res.redirect('/marketing/eventos'));

router.get('/eventos', async (req, res) => {
  try {
    const { rows } = await db.query(`SELECT ${EVENTO_VIEW_COLUMNS} FROM events ORDER BY created_at DESC`);
    res.render('marketing/eventos', { titulo: 'Galería de Eventos', eventos: rows });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error cargando eventos');
  }
});

router.get('/eventos/nuevo', requireRole(...WRITE_ROLES), (req, res) => {
  res.render('marketing/eventos_nuevo', { titulo: 'Crear Nuevo Evento', error: null });
});

router.post('/eventos/nuevo', requireRole(...WRITE_ROLES), async (req, res) => {
  const { name, description } = eventFieldsFromBody(req.body);

  try {
    if (!name) {
      return res.render('marketing/eventos_nuevo', {
        titulo: 'Crear Nuevo Evento',
        error: 'El nombre del evento es obligatorio.',
      });
    }

    const slug = createSlug(name);
    if (!slug) {
      return res.render('marketing/eventos_nuevo', {
        titulo: 'Crear Nuevo Evento',
        error: 'El nombre no genera un identificador válido. Usa letras o números.',
      });
    }

    await db.queryRetryIdCollision(
      'INSERT INTO events (name, slug, description) VALUES ($1, $2, $3)',
      [name, slug, description],
    );
    res.redirect('/marketing/eventos');
  } catch (err) {
    console.error(err);
    const errorMsg = err.code === '23505' ? 'Ya existe un evento con ese nombre.' : 'Error al crear.';
    res.render('marketing/eventos_nuevo', { titulo: 'Crear Nuevo Evento', error: errorMsg });
  }
});

// GET DETALLE
router.get('/eventos/:slug', async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows } = await db.query(`SELECT ${EVENTO_VIEW_COLUMNS} FROM events WHERE slug = $1`, [slug]);
    if (rows.length === 0) return res.status(404).send('Evento no encontrado');

    const folder = `eventos/${slug}/`;

    // Obtener imágenes y videos locales
    const imagenes = await fileStorage.listFiles(folder);
    let todos = imagenes.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.render('marketing/evento_detalle', {
      titulo: rows[0].name,
      evento: rows[0],
      imagenes: todos
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar detalle');
  }
});


// SIGNATURE - Endpoint para obtener datos de subida
router.get('/eventos/:slug/fotos/signature', requireRole(...WRITE_ROLES), async (req, res) => {
  const { slug } = req.params;
  try {
    // Ya no se necesita firma para almacenamiento local
    res.json({
      timestamp: Math.round(Date.now() / 1000),
      folder: `eventos/${slug}`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error generando datos' });
  }
});

// ENDPOINT PARA SUBIR ARCHIVOS
router.post('/eventos/:slug/fotos/upload', requireRole(...WRITE_ROLES), upload.single('archivo'), async (req, res) => {
  const { slug } = req.params;
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No se subió archivo' });
    }

    const resourceType = fileStorage.getResourceType(req.file.originalname);
    const isVideo =
      resourceType === 'video' && req.file.mimetype?.startsWith('video/');
    const isImage =
      resourceType === 'image' && req.file.mimetype?.startsWith('image/');
    if (!isVideo && !isImage) {
      return res.status(400).json({ error: 'Solo se admiten imágenes o videos.' });
    }
    const maxBytes = isVideo
      ? UPLOAD_LIMITS_BYTES.EVENT_VIDEO
      : UPLOAD_LIMITS_BYTES.EVENT_IMAGE;
    if (req.file.size > maxBytes) {
      const maxMb = isVideo ? 100 : 10;
      return res.status(413).json({
        error: `El archivo supera el máximo de ${maxMb} MiB para este tipo.`,
      });
    }

    const folder = `eventos/${slug}`;
    const result = await fileStorage.saveFileFromPath(
      req.file.path,
      folder,
      req.file.originalname
    );

    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error al subir archivo' });
  } finally {
    if (req.file?.path) {
      await fs.unlink(req.file.path).catch((cleanupError) => {
        console.warn(
          '[Eventos] No se pudo limpiar el temporal de subida:',
          cleanupError.message || cleanupError,
        );
      });
    }
  }
});

// SUBIR - Compatibilidad con uploads directos
router.post('/eventos/:slug/fotos', requireRole(...WRITE_ROLES), upload.none(), async (req, res) => {
  const { slug } = req.params;
  const directFiles = parseDirectUploadedImages(req.body);

  if (directFiles.length > 0) {
    try {
      const firstImage = directFiles.find(f => (f.resource_type === 'image' || !f.resource_type));
      if (firstImage) {
        await db.query(
          `UPDATE events SET image = $1 WHERE slug = $2 AND (image IS NULL OR image = '')`,
          [firstImage.secure_url, slug]
        );
      }

      if (req.session.user && req.session.user.id) {
        await db.query(
          'INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
          [req.session.user.id, 'subió contenido multimedia', 'Galería de Eventos', `/marketing/eventos/${slug}`]
        );
      }
      return res.redirect(`/marketing/eventos/${slug}`);
    } catch (err) {
      console.error(err);
      return res.status(500).send('Error registrando multimedia');
    }
  }

  res.redirect(`/marketing/eventos/${slug}`);
});

// DEFINIR PORTADA
router.post('/eventos/:slug/portada', requireRole(...WRITE_ROLES), async (req, res) => {
  const { slug } = req.params;
  const { url_imagen } = req.body;
  try {
    await db.query('UPDATE events SET image = $1 WHERE slug = $2', [url_imagen, slug]);
    res.redirect(`/marketing/eventos/${slug}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al definir portada');
  }
});

// ELIMINAR FOTO O VIDEO
router.post('/eventos/:slug/fotos/eliminar', requireRole(...WRITE_ROLES), async (req, res) => {
  const { public_id, resource_type } = req.body; 
  const { slug } = req.params;
  
  try {
    await fileStorage.deleteFile(public_id);

    const { rows } = await db.query('SELECT image FROM events WHERE slug = $1', [slug]);
    if (rows.length > 0 && rows[0].image && rows[0].image.includes(public_id)) {
        await db.query('UPDATE events SET image = NULL WHERE slug = $1', [slug]);
    }
    res.redirect(`/marketing/eventos/${slug}`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error eliminando archivo');
  }
});

// ELIMINAR EVENTO COMPLETO
router.post('/eventos/:slug/eliminar', requireRole(...WRITE_ROLES), async (req, res) => {
  const { slug } = req.params;
  try {
    await fileStorage.deleteFolder(`eventos/${slug}`);
    
    await db.query('DELETE FROM events WHERE slug = $1', [slug]);
    res.redirect('/marketing/eventos');
  } catch (err) {
    console.error(err);
    res.status(500).send('Error eliminando evento');
  }
});

// RUTAS EDITAR
router.get('/eventos/:slug/editar', requireRole(...WRITE_ROLES), async (req, res) => {
  const { slug } = req.params;
  try {
    const { rows } = await db.query(`SELECT ${EVENTO_VIEW_COLUMNS} FROM events WHERE slug = $1`, [slug]);
    if (rows.length === 0) return res.status(404).send('Evento no encontrado');
    res.render('marketing/eventos_editar', { titulo: 'Editar Evento', evento: rows[0] });
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al cargar formulario de edición');
  }
});

router.post('/eventos/:slug/editar', requireRole(...WRITE_ROLES), async (req, res) => {
  const { slug } = req.params;
  const { name, description } = eventFieldsFromBody(req.body);
  try {
    if (!name) {
      return res.status(400).send('El nombre del evento es obligatorio');
    }
    await db.query('UPDATE events SET name = $1, description = $2 WHERE slug = $3', [name, description, slug]);
    if (req.session.user && req.session.user.id) {
      await db.query('INSERT INTO change_log (user_id, action, section, link_path) VALUES ($1, $2, $3, $4)',
        [req.session.user.id, 'editó información del evento', 'Galería de Eventos', `/marketing/eventos/${slug}`]);
    }
    res.redirect(`/marketing/eventos/${slug}?ok=Evento actualizado correctamente`);
  } catch (err) {
    console.error(err);
    res.status(500).send('Error al actualizar el evento');
  }
});

module.exports = router;
