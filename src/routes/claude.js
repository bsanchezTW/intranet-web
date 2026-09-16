const express = require("express");
const logger = require("../utils/logger");
const claudeService = require("../services/claudeService");
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
const { searchPeople, searchDocuments } = require("../services/assistant/directorySearch");
const {
  MAX_MESSAGE_CHARS,
  getHistory,
  appendExchange,
  clearConversation,
} = require("../services/assistant/assistantConversation");
const { isAreaManager } = require("../services/expenses/areaManager");
const { isFinanceApprover } = require("../services/expenses/financeTeam");
const { canManageRrhh } = require("../services/access/staffAccess");

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
  res.json({ messages: getHistory(req.session) });
});

// DELETE /claude/api/conversation - Empezar de nuevo
router.delete("/api/conversation", (req, res) => {
  clearConversation(req.session);
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
    const toolExecutor = createToolExecutor({
      entries: guide,
      currentPath: page.path,
      searchPeople,
      searchDocuments,
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
        }),
      }),
      tools: buildToolDefinitions(guide),
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
    sse({ type: "done", navigate: toolExecutor.getNavigation() });
  } catch (error) {
    console.error("[Asistente] Error:", error);
    sse({ type: "error", error: "No pude responder en este momento. Intenta de nuevo." });
  }
  res.end();
});

module.exports = router;
