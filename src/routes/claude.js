const express = require("express");
const logger = require("../utils/logger");
const claudeService = require("../services/claudeService");
const requireFeature = require("../middlewares/requireFeature");
const receiveTicketAttachments = require("../middlewares/receiveTicketAttachments");
const { isAdministrador } = require("../constants/roles");
const { getFeatures } = require("../config/features");
const { guideForUser } = require("../constants/intranetGuide");
const {
  STATUS_LABELS,
  buildToolDefinitions,
  createToolExecutor,
  sanitizePage,
  buildContextPrompt,
  buildCatalogPrompt,
} = require("../services/assistant/assistantTools");
const { searchPeople, searchDocuments, searchEvents } = require("../services/assistant/directorySearch");
const {
  MAX_MESSAGE_CHARS,
  getHistory,
  appendExchange,
  appendToLastAssistantMessage,
  clearConversation,
} = require("../services/assistant/assistantConversation");
const assistantTickets = require("../services/assistant/assistantTickets");
const { createSupportTicket, listOpenTicketsForUser } = require("../services/tickets/ticketService");
const { isAreaManager } = require("../services/expenses/areaManager");
const { isFinanceApprover } = require("../services/expenses/financeTeam");
const { canManageRrhh } = require("../services/access/staffAccess");
const { listAppsByCatalog } = require("../services/appCatalogService");
const { ticketModalUrl } = require("../utils/ticketRedirect");

const router = express.Router();

router.use((req, res, next) => {
  if (!req.session || !req.session.user) {
    return res.status(401).json({ error: "No autenticado" });
  }
  next();
});

/** Mismo criterio que requireExpenseReviewer; un fallo de BD cuenta como "no revisa". */
async function resolveExpenseReviewer(user, { isAdmin, features }) {
  if (!features.expenseRequests) return false;
  if (isAdmin) return true;
  try {
    return (await isFinanceApprover(user)) || (await isAreaManager(user));
  } catch (err) {
    console.error("[Asistente] Error resolviendo revisor de gastos:", err.message);
    return false;
  }
}

// GET /claude - Abre el asistente sobre el inicio
router.get("/", (req, res) => {
  res.redirect("/?openClaude=1");
});

// GET /claude/api/conversation - La conversación de esta sesión
router.get("/api/conversation", (req, res) => {
  res.json({
    messages: getHistory(req.session),
    // El navegador descarta los adjuntos guardados en otra sesión.
    sessionKey: assistantTickets.assistantSessionId(req.session),
  });
});

// DELETE /claude/api/conversation - Empezar de nuevo
router.delete("/api/conversation", (req, res) => {
  clearConversation(req.session);
  assistantTickets.clearTicketDraft(req.session);
  res.json({ success: true });
});

// POST /claude/api/ticket-draft/:id/confirm - El usuario crea el ticket del borrador
router.post(
  "/api/ticket-draft/:id/confirm",
  requireFeature("supportTickets"),
  receiveTicketAttachments({ maxFiles: assistantTickets.MAX_CHAT_ATTACHMENTS, json: true }),
  async (req, res) => {
    const draft = assistantTickets.getTicketDraft(req.session, req.params.id);
    if (!draft) {
      return res.status(404).json({
        error: "Este borrador ya no está disponible. Pídele al asistente que lo arme de nuevo.",
      });
    }

    try {
      const result = await createSupportTicket({
        user: req.session.user,
        title: draft.title,
        description: draft.description,
        category: draft.category,
        priority: draft.priority,
        files: req.files || [],
      });
      if (!result.ok) return res.status(400).json({ error: result.error });

      assistantTickets.clearTicketDraft(req.session);
      appendToLastAssistantMessage(
        req.session,
        `Ticket #${result.id} creado: [ver ticket](${ticketModalUrl(result.id)}).`,
      );
      // El contador de tickets de la barra se recalcula en la próxima consulta.
      delete req.session.ticketNotifications;
      res.json({
        id: result.id,
        url: ticketModalUrl(result.id),
        failedAttachments: result.failedAttachments,
      });
    } catch (error) {
      console.error("[Asistente] Error creando ticket:", error);
      res.status(500).json({ error: "No se pudo crear el ticket. Intenta de nuevo." });
    }
  },
);

// DELETE /claude/api/ticket-draft/:id - Descartar el borrador
router.delete("/api/ticket-draft/:id", requireFeature("supportTickets"), (req, res) => {
  if (assistantTickets.getTicketDraft(req.session, req.params.id)) {
    assistantTickets.clearTicketDraft(req.session);
  }
  res.json({ success: true });
});

// POST /claude/api/chat - Un turno del asistente (respuesta en streaming SSE)
router.post("/api/chat", async (req, res) => {
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!message) {
    return res.status(400).json({ error: "Escribe una pregunta." });
  }
  if (message.length > MAX_MESSAGE_CHARS) {
    return res
      .status(400)
      .json({ error: `El mensaje es demasiado largo (máximo ${MAX_MESSAGE_CHARS} caracteres).` });
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  const sse = (payload) => res.write(`data: ${JSON.stringify(payload)}\n\n`);

  try {
    // Catálogo filtrado por features y permisos, página actual y tools. Va en
    // el system prompt, no en el mensaje guardado.
    const sessionUser = req.session.user;
    const features = res.locals.features || getFeatures();
    const supportTickets = Boolean(features.supportTickets);
    const isAdmin = isAdministrador(sessionUser.role);
    const isExpenseReviewer = await resolveExpenseReviewer(sessionUser, { isAdmin, features });
    const guide = guideForUser({
      features,
      isAdmin,
      isExpenseReviewer,
      canManageRrhh: await canManageRrhh(sessionUser),
      workAreaId: sessionUser.work_area_id,
    });
    const page = sanitizePage(req.body.page);
    // Los archivos siguen en el navegador; el modelo sólo conoce sus nombres.
    const chatAttachments = supportTickets
      ? assistantTickets.sanitizeChatAttachments(req.body.attachments)
      : null;
    const toolExecutor = createToolExecutor({
      entries: guide,
      currentPath: page.path,
      searchPeople,
      searchDocuments,
      searchEvents,
      selfHelp: supportTickets ? () => listAppsByCatalog("support") : null,
      tickets: supportTickets
        ? {
            attachmentCount: chatAttachments.length,
            saveDraft: (input) => {
              const saved = assistantTickets.saveTicketDraft(req.session, input);
              return saved.ok ? { ok: true, draft: assistantTickets.publicDraft(saved.draft) } : saved;
            },
            listMine: () => listOpenTicketsForUser(sessionUser),
          }
        : null,
    });

    const history = getHistory(req.session).map(({ role, content }) => ({ role, content }));
    const result = await claudeService.runAssistantTurn([...history, { role: "user", content: message }], {
      system: claudeService.buildSystemPrompt({
        catalog: buildCatalogPrompt(guide),
        context: buildContextPrompt({
          entries: guide,
          page,
          user: sessionUser,
          isAdmin,
          isExpenseReviewer,
          features,
          attachments: chatAttachments,
        }),
      }),
      tools: buildToolDefinitions(guide, { supportTickets }),
      executeTool: toolExecutor.execute,
      onEvent: (ev) => {
        if (ev.type === "tool") {
          sse({ type: "status", text: STATUS_LABELS[ev.name] || "Consultando…" });
          return;
        }
        sse(ev);
      },
    });

    // Consumo por turno, para comparar costos antes y después de cada ajuste.
    const { usage } = result;
    logger.info(
      "asistente",
      `usuario=${sessionUser.id} rondas=${result.rounds} entrada=${usage.input_tokens} ` +
        `salida=${usage.output_tokens} cache_leida=${usage.cache_read_input_tokens} ` +
        `cache_escrita=${usage.cache_creation_input_tokens}`,
    );

    // Antes de res.end(): express-session guarda la sesión al cerrar la respuesta.
    if (result.text.trim()) {
      appendExchange(req.session, message, result.text);
    }
    sse({ type: "done", navigate: toolExecutor.getNavigation(), ...toolExecutor.getActions() });
  } catch (error) {
    console.error("[Asistente] Error:", error);
    sse({ type: "error", error: "No pude responder en este momento. Intenta de nuevo." });
  }
  res.end();
});

module.exports = router;
