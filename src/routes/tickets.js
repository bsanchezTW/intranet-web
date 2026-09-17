const express = require("express");
const router = express.Router();
const db = require("../db");
const { sendMail } = require("../services/mailer");
const { MAIL_SENDERS } = require("../constants/mailSenders");
const { isAdministrador } = require("../constants/roles");
const multer = require('multer');
const {
  ticketStatusFromDb,
  mapTicketReplyForView,
} = require("../utils/schemaMappers");
const holidayService = require("../services/vacations/holidayService");
const {
  countBusinessMinutes,
  formatBusinessDuration,
  getLocalDateOnly,
  getTZ,
} = require("../utils/businessHours");
const { getCurrentCountry } = require("../config/country");
const { UPLOAD_LIMITS_BYTES } = require("../config/uploadLimits");
const { APP_CATALOGS } = require("../constants/appCatalogs");
const { listAppsByCatalog } = require("../services/appCatalogService");
const requireSupportAgent = require("../middlewares/requireSupportAgent");
const receiveTicketAttachments = require("../middlewares/receiveTicketAttachments");
const {
  createSupportTicket,
  saveTicketAttachment,
  ticketMailHtml: generarHtmlCorreo,
  ticketMailText: generarTextoCorreo,
  notifyTicketTeam,
} = require("../services/tickets/ticketService");
const { normalizeTicketPriority } = require("../services/tickets/ticketRules");
const {
  DEFAULT_TICKET_CATEGORY,
  normalizeTicketCategory,
} = require("../constants/ticketCategories");
const { safeTicketRedirect, ticketModalUrl } = require("../utils/ticketRedirect");
const {
  listSupportAgents,
  isSupportAgent,
  getAgentById,
} = require("../services/tickets/supportTeam");

const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: UPLOAD_LIMITS_BYTES.TICKET_ATTACHMENT },
});

/**
 * Las marcas de tiempo se guardan en UTC y se muestran en la hora local de la
 * instancia. La zona sale de la configuración de país, no de un literal: Chile
 * es America/Santiago y Perú America/Lima.
 *
 * Va interpolada (no como parámetro) porque AT TIME ZONE exige un literal en el
 * plan de la consulta; el valor proviene de una lista cerrada en
 * config/country.js, nunca de entrada del usuario.
 */
function localTs(column, alias) {
  return `${column} AT TIME ZONE 'UTC' AT TIME ZONE '${getTZ()}' AS ${alias}`;
}

function ticketListSql() {
  return `
      SELECT t.id,
             t.title,
             t.category,
             t.priority,
             t.status,
             t.requester_name,
             t.requester_email,
             t.read_by_admin,
             t.read_by_user,
             t.assigned_to,
             ${localTs("t.created_at", "created_at")},
             ${localTs(
               "(SELECT MAX(created_at) FROM ticket_replies WHERE ticket_id = t.id)",
               "fecha_ultima_respuesta",
             )}
      FROM support_tickets t
`;
}

const NOTIFICATION_COUNT_TTL_MS = 30 * 1000;

function getNotificationCacheKey(user, esAgente) {
  const scope = esAgente ? "soporte" : user.email || user.username;
  return `${esAgente ? "soporte" : "user"}:${scope || "anonymous"}`;
}

function invalidateNotificationCount(req) {
  if (req.session) delete req.session.ticketNotifications;
}


// ==========================================
// HELPERS: ASIGNACIÓN Y REDIRECCIÓN
// ==========================================

/**
 * Traduce la decisión del modal ("¿tomar este ticket?") a un nombre para
 * `assigned_to`.
 *
 * - `yo`        → el agente que está guardando
 * - `otro`      → otro integrante de Informática, validado contra el equipo
 * - `mantener`  → no se toca la columna (devuelve null)
 *
 * Asignar a alguien fuera del área se rechaza aquí y no sólo en el <select>:
 * el formulario es editable desde el navegador.
 */
async function resolveAssignment(req) {
  const modo = String(req.body.assign_mode || "").trim();

  if (modo === "mantener") return { assignedTo: null };

  if (modo === "otro") {
    const agente = await getAgentById(req.body.assign_to);
    if (!agente) {
      return { error: "La persona seleccionada no pertenece a Informática." };
    }
    return { assignedTo: agente.name };
  }

  if (modo === "yo") {
    const agente = await getAgentById(req.session.user.id);
    if (!agente) {
      return { error: "Tu usuario ya no pertenece a Informática." };
    }
    return { assignedTo: agente.name };
  }

  return { error: "Debes indicar quién se hace cargo del ticket." };
}

// ==========================================
// RUTAS DEL MÓDULO
// ==========================================

router.get("/", (req, res) => {
  res.render("sistemas/index", { titulo: "Sistemas", user: req.session.user });
});

router.get("/tickets/notificaciones/count", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.json({ count: 0 });

  res.set("Cache-Control", "no-store");
  const userEmail = user.email || user.username;

  // El contador de la mesa de ayuda es para quien la atiende (Informática);
  // el resto sólo cuenta sus propios tickets sin leer.
  let esAgente = false;
  try {
    esAgente = await isSupportAgent(user);
  } catch (err) {
    console.error("Error resolviendo equipo de soporte:", err);
  }

  const cacheKey = getNotificationCacheKey(user, esAgente);
  const cached = req.session.ticketNotifications;
  if (
    cached &&
    cached.key === cacheKey &&
    cached.expiresAt > Date.now()
  ) {
    return res.json({ count: cached.count, cached: true });
  }

  try {
    let sql = "";
    let params = [];

    if (esAgente) {
      sql = `SELECT COUNT(*) FROM support_tickets WHERE read_by_admin = FALSE`;
    } else {
      sql = `SELECT COUNT(*) FROM support_tickets WHERE (requester_email = $1 OR requester_name = $1) AND read_by_user = FALSE`;
      params = [userEmail];
    }

    const { rows } = await db.query(sql, params);
    const count = parseInt(rows[0].count, 10) || 0;
    req.session.ticketNotifications = {
      key: cacheKey,
      count,
      expiresAt: Date.now() + NOTIFICATION_COUNT_TTL_MS,
    };
    res.json({ count, cached: false });
  } catch (err) {
    console.error("Error contando notificaciones:", err);
    res.json({ count: 0 });
  }
});

router.get("/tickets", async (req, res) => {
  const user = req.session.user;
  if (!user) return res.redirect("/login");

  const userEmail = user.email || user.username;

  let sql = "";
  let params = [];

  if (isAdministrador(user.role)) {
    sql = `${ticketListSql()} ORDER BY t.created_at DESC`;
  } else {
    sql = `${ticketListSql()} WHERE t.requester_email = $1 OR t.requester_name = $1 ORDER BY t.created_at DESC`;
    params = [userEmail];
  }

  try {
    // La autoayuda encabeza la página, así que se pide en paralelo con los
    // tickets: si el catálogo falla, la ticketera sigue cargando.
    const [{ rows: results }, supportApps, puedeGestionar] = await Promise.all([
      db.query(sql, params),
      listAppsByCatalog(APP_CATALOGS.SUPPORT).catch((err) => {
        console.error("Error al cargar apps de autoayuda:", err);
        return [];
      }),
      isSupportAgent(user).catch(() => false),
    ]);

    let holidaySet = new Set();
    const ticketsWithResponse = results.filter(
      (t) => t.created_at && t.fecha_ultima_respuesta,
    );
    if (ticketsWithResponse.length > 0) {
      const rangeStart = ticketsWithResponse.reduce((min, t) => {
        const d = getLocalDateOnly(new Date(t.created_at));
        return d < min ? d : min;
      }, getLocalDateOnly(new Date(ticketsWithResponse[0].created_at)));
      const rangeEnd = ticketsWithResponse.reduce((max, t) => {
        const d = getLocalDateOnly(new Date(t.fecha_ultima_respuesta));
        return d > max ? d : max;
      }, getLocalDateOnly(new Date(ticketsWithResponse[0].fecha_ultima_respuesta)));
      // Los feriados que descuenta el SLA son los del país de la instancia.
      holidaySet = await holidayService.getHolidaySet(
        getCurrentCountry(),
        rangeStart,
        rangeEnd,
      );
    }

    const tickets = results.map((ticket) => {
      if (!ticket.created_at || !ticket.fecha_ultima_respuesta) {
        return { ...ticket, tiempo_respuesta: "-", tiempo_respuesta_minutos: null };
      }
      const minutos = countBusinessMinutes(
        ticket.created_at,
        ticket.fecha_ultima_respuesta,
        holidaySet,
      );
      return {
        ...ticket,
        tiempo_respuesta: formatBusinessDuration(minutos),
        tiempo_respuesta_minutos: minutos,
      };
    });

    res.render("sistemas/tickets", {
      titulo: "Soporte",
      tickets,
      supportApps,
      appCatalog: APP_CATALOGS.SUPPORT,
      canManageTickets: puedeGestionar,
      user: user,
      ok: req.query.ok,
      extraCss: ["/css/apps.css?v=20260916m", "/css/tickets.css?v=20260916g"],
      extraJs: ["/js/tickets-list.js"],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error consultando tickets");
  }
});

// El alta de tickets es sólo en modal: no hay página propia. La ruta existe
// para que /tickets/nuevo no caiga en el detalle (/tickets/:id).
router.get("/tickets/nuevo", (req, res) => {
  res.status(404).render("404", { titulo: "Página no encontrada" });
});

router.post("/tickets/crear", receiveTicketAttachments(), async (req, res) => {
  if (!req.session.user) return res.redirect("/login");

  try {
    // Los archivos llegan con el formulario y se suben recién cuando el ticket
    // existe, con el nombre <N° de ticket>_1, _2…
    const result = await createSupportTicket({
      user: req.session.user,
      title: req.body.title ?? req.body.titulo,
      description: req.body.description ?? req.body.descripcion,
      category: req.body.category ?? req.body.categoria,
      priority: req.body.priority ?? req.body.prioridad,
      files: req.files || [],
    });
    if (!result.ok) return res.status(400).send(result.error);

    invalidateNotificationCount(req);
    res.redirect(ticketModalUrl(result.id));
  } catch (err) {
    console.error(err);
    res.status(500).send("Error al procesar el ticket.");
  }
});

router.get("/tickets/signature", async (req, res) => {
  if (!req.session.user)
    return res.status(403).json({ error: "No autorizado" });
  try {
    const timestamp = Math.round(Date.now() / 1000);
    const folder = "tickets_adjuntos";
    return res.json({ timestamp, folder });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Error firma" });
  }
});

// UPLOAD: recibir archivos y guardarlos localmente
router.post('/tickets/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.session || !req.session.user) return res.status(403).json({ error: 'No autorizado' });
    if (!req.file) return res.status(400).json({ error: 'No se subió archivo' });

    // Las respuestas de Soporte adjuntan también planillas y texto: sin filtro de tipo.
    const saved = await saveTicketAttachment(req.file, {
      anyType: true,
      ticketId: req.body.ticket_id,
      fileIndex: req.body.index,
    });
    if (!saved.ok) return res.status(400).json({ error: saved.error });

    const tipo = req.file.mimetype.startsWith('video/') ? 'video' : req.file.mimetype.startsWith('image/') ? 'image' : 'raw';
    return res.json({ secure_url: saved.attachment.url, public_id: saved.publicId, resource_type: tipo });
  } catch (err) {
    console.error('Error subiendo archivo ticket:', err);
    return res.status(500).json({ error: 'Error subiendo archivo' });
  }
});

// ADMIN: ACTUALIZAR TICKET
/**
 * Gestión de un ticket por parte de Informática.
 *
 * Antes el estado era un desplegable libre y la asignación un botón aparte, así
 * que se podía gestionar un ticket dejándolo "sin asignar". Ahora la asignación
 * es parte del guardado —el modal obliga a resolver quién lo toma— y el estado
 * lo deduce la acción: guardar deja el ticket En curso y cerrar lo cierra. No se
 * produce `pending_close`; las filas históricas en ese estado siguen viviendo su
 * ciclo con /confirmar y /rechazar.
 */
router.post(
  "/tickets/:id/actualizar",
  requireSupportAgent(),
  async (req, res) => {
    const { id } = req.params;
    const category =
      normalizeTicketCategory(req.body.category ?? req.body.categoria) || DEFAULT_TICKET_CATEGORY;
    const priority = normalizeTicketPriority(req.body.priority ?? req.body.prioridad);
    const { mensaje_respuesta, adjuntos_data } = req.body;
    const cerrar = String(req.body.accion || "") === "cerrar";
    const status = cerrar ? "closed" : "in_progress";

    try {
      const asignacion = await resolveAssignment(req);
      if (asignacion.error) return res.status(400).send(asignacion.error);

      let sql = `UPDATE support_tickets SET category = $1, priority = $2, status = $3`;
      const params = [category, priority, status];

      if (asignacion.assignedTo !== null) {
        params.push(asignacion.assignedTo);
        sql += `, assigned_to = $${params.length}`;
      }
      // Cerrar deja fecha de cierre; reactivar limpia el pendiente heredado.
      sql += cerrar
        ? `, closed_at = NOW(), auto_closed = FALSE`
        : `, resolved_at = NULL, closed_at = NULL`;
      params.push(id);
      sql += ` WHERE id = $${params.length}`;

      await db.query(sql, params);

      const tieneMensaje =
        mensaje_respuesta && mensaje_respuesta.trim().length > 0;
      const tieneAdjuntos = adjuntos_data && adjuntos_data.length > 2;

      if (tieneMensaje || tieneAdjuntos) {
        await db.query(
          `INSERT INTO ticket_replies (ticket_id, message, sender, attachments, created_at) VALUES ($1, $2, $3, $4, NOW())`,
          [id, mensaje_respuesta, "Support", adjuntos_data || "[]"],
        );
      }

      await db.query(
        "UPDATE support_tickets SET read_by_user = FALSE WHERE id = $1",
        [id],
      );

      const { rows: ticket } = await db.query(
        "SELECT requester_email, title FROM support_tickets WHERE id = $1",
        [id],
      );
      if (ticket.length > 0) {
        const asunto = `Actualización del ticket #${id} — ${ticket[0].title}`;
        let cuerpo = `Hola,\n\nSe ha actualizado tu ticket. Nuevo estado: ${ticketStatusFromDb(status).toUpperCase()}.\n`;
        if (asignacion.assignedTo) {
          cuerpo += `\nResponsable: ${asignacion.assignedTo}.`;
        }
        if (tieneMensaje) cuerpo += `\n\nMensaje: "${mensaje_respuesta}"`;

        sendMail({
          to: ticket[0].requester_email,
          subject: asunto,
          heading: "Actualización de tu ticket",
          cta: { href: `/sistemas/tickets?ticket=${id}`, label: "Ver ticket" },
          text: generarTextoCorreo(cuerpo, adjuntos_data),
          html: generarHtmlCorreo(cuerpo, adjuntos_data),
          senderName: MAIL_SENDERS.support,
        }).catch(console.error);
      }

      invalidateNotificationCount(req);
      res.redirect(safeTicketRedirect(req.body.redirect_to, id));
    } catch (err) {
      console.error(err);
      res.status(500).send("Error actualizando ticket");
    }
  },
);

// USUARIO: CONFIRMAR SOLUCIÓN
router.post("/tickets/:id/confirmar", async (req, res) => {
  const { id } = req.params;
  const user = req.session.user;
  try {
    const { rows } = await db.query(
      "SELECT requester_email FROM support_tickets WHERE id = $1",
      [id],
    );
    if (rows.length === 0 || rows[0].requester_email !== user.email)
      return res.status(403).send("No tienes permiso.");

    await db.query(
      `UPDATE support_tickets SET status = 'closed', closed_at = NOW(), auto_closed = FALSE WHERE id = $1`,
      [id],
    );
    res.redirect(ticketModalUrl(id));
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// USUARIO: RECHAZAR SOLUCIÓN
router.post("/tickets/:id/rechazar", async (req, res) => {
  const { id } = req.params;
  const user = req.session.user;
  try {
    const { rows } = await db.query(
      "SELECT requester_email, title FROM support_tickets WHERE id = $1",
      [id],
    );
    if (rows.length === 0 || rows[0].requester_email !== user.email)
      return res.status(403).send("No tienes permiso.");

    await db.query(
      `UPDATE support_tickets SET status = 'open', resolved_at = NULL, read_by_admin = FALSE WHERE id = $1`,
      [id],
    );
    await db.query(
      `INSERT INTO ticket_replies (ticket_id, message, sender, created_at) VALUES ($1, $2, $3, NOW())`,
      [
        id,
        "El usuario ha rechazado la solución y el ticket se ha reabierto.",
        "System",
      ],
    );

    notifyTicketTeam({
      subject: `Ticket reabierto #${id} — ${rows[0].title}`,
      heading: "Ticket reabierto",
      cta: { href: ticketModalUrl(id), label: "Ver ticket" },
      text: `El usuario rechazó la solución y reabrió el ticket ${id}`,
      html: generarHtmlCorreo(
        `El usuario rechazó la solución y reabrió el ticket ${id}`,
        null,
      ),
    });
    res.redirect(ticketModalUrl(id));
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

// USUARIO/ADMIN: RESPONDER TICKET
router.post("/tickets/:id/responder", async (req, res) => {
  const { id } = req.params;
  const { mensaje_respuesta, adjuntos_data } = req.body;
  const user = req.session.user;

  try {
    const { rows: results } = await db.query(
      `SELECT requester_email, title FROM support_tickets WHERE id = $1`,
      [id],
    );
    if (results.length === 0)
      return res.status(404).send("Ticket no encontrado");
    const ticket = results[0];

    // Quien firma como "Soporte" es el área de Informática, no cualquier
    // administrador: un admin de otra área que comente lo hace como usuario.
    const isAgent = await isSupportAgent(user);
    const isOwner = user.email === ticket.requester_email;
    if (!isAgent && !isOwner) return res.status(403).send("Sin permiso.");

    let remitenteNombre = isAgent
      ? "Soporte"
      : user.nombre || user.username || user.first_name;
    let asuntoEmail = `Nueva respuesta en el ticket #${id} — ${ticket.title}`;

    await db.query(
      `INSERT INTO ticket_replies (ticket_id, message, sender, attachments, created_at) VALUES ($1, $2, $3, $4, NOW())`,
      [id, mensaje_respuesta, isAgent ? "Support" : remitenteNombre, adjuntos_data || "[]"],
    );

    if (isAgent) {
      await db.query("UPDATE support_tickets SET read_by_user = FALSE WHERE id = $1", [
        id,
      ]);
    } else {
      await db.query("UPDATE support_tickets SET read_by_admin = FALSE WHERE id = $1", [
        id,
      ]);
    }

    const cuerpo = `Nueva respuesta de ${remitenteNombre}:\n\n${mensaje_respuesta}`;
    const mailBody = {
      subject: asuntoEmail,
      heading: isAgent ? "Nueva respuesta de Soporte" : "Nueva respuesta del usuario",
      cta: { href: ticketModalUrl(id), label: "Ver ticket" },
      text: generarTextoCorreo(cuerpo, adjuntos_data),
      html: generarHtmlCorreo(cuerpo, adjuntos_data),
    };
    if (isAgent) {
      if (ticket.requester_email) {
        sendMail({
          ...mailBody,
          to: ticket.requester_email,
          senderName: MAIL_SENDERS.support,
        }).catch(console.error);
      }
    } else {
      notifyTicketTeam(mailBody);
    }

    invalidateNotificationCount(req);
    res.redirect(safeTicketRedirect(req.body.redirect_to, id));
  } catch (err) {
    console.error(err);
    res.status(500).send("Error procesando respuesta.");
  }
});

// Ya no hay ruta "tomar ticket": la asignación dejó de ser un botón suelto y
// forma parte de /actualizar, para que no se pueda gestionar un ticket sin
// dejarlo asignado.

// DETALLE TICKET
router.get("/tickets/:id", async (req, res) => {
  const { id } = req.params;
  const user = req.session.user;

  // Un ticket se ve sólo en el modal de la lista: abierto directamente, lleva ahí.
  if (req.query.modal !== "true") {
    return /^\d+$/.test(id)
      ? res.redirect(ticketModalUrl(id))
      : res.status(404).render("404", { titulo: "No encontrado" });
  }

  const sqlTicket = `
    SELECT id, title, description, category, priority, status,
           requester_name, requester_email, attachments, read_by_admin, read_by_user,
           assigned_to, auto_closed,
           ${localTs("created_at", "created_at")},
           ${localTs("resolved_at", "fecha_resolucion")},
           ${localTs("closed_at", "fecha_cierre")}
    FROM support_tickets WHERE id = $1
  `;

  const sqlRespuestas = `
    SELECT id, message, sender, file_url, file_name, file_type, attachments,
           ${localTs("created_at", "fecha")}
    FROM ticket_replies
    WHERE ticket_id = $1
    ORDER BY created_at ASC
  `;

  try {
    const { rows: ticketResults } = await db.query(sqlTicket, [id]);
    if (ticketResults.length === 0)
      return res.status(404).render("404", { titulo: "No encontrado" });

    if (
      !isAdministrador(user.role) &&
      ticketResults[0].requester_email !== user.email
    )
      return res.status(403).send("No tienes permisos.");

    // Gestionar es del área, no del rol: el panel de TI sólo aparece para
    // Informática. Un administrador de otra área ve el ticket, no lo opera.
    const puedeGestionar = await isSupportAgent(user);
    const agentes = puedeGestionar ? await listSupportAgents() : [];

    const { rows: respuestasResults } = await db.query(sqlRespuestas, [id]);

    if (puedeGestionar) {
      await db.query("UPDATE support_tickets SET read_by_admin = TRUE WHERE id = $1", [
        id,
      ]);
    } else if (ticketResults[0].requester_email === user.email) {
      await db.query("UPDATE support_tickets SET read_by_user = TRUE WHERE id = $1", [
        id,
      ]);
    }
    invalidateNotificationCount(req);

    const isModal = req.query.modal === 'true';

    res.render("sistemas/tickets_detalle", {
      titulo: `Ticket #${id}`,
      ticket: ticketResults[0],
      respuestas: respuestasResults.map(mapTicketReplyForView),
      user: user,
      canManageTickets: puedeGestionar,
      supportAgents: agentes,
      backTo: safeTicketRedirect(req.query.volver, id),
      layout: isModal ? false : "layout",
      isModal: isModal,
      extraCss: isModal ? [] : ["/css/tickets.css?v=20260916g"],
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error");
  }
});

module.exports = router;
