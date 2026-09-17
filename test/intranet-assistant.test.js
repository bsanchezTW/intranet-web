const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  guideForUser,
  findEntryForPath,
  resolvePage,
  isSamePage,
  formatGuideForPrompt,
} = require("../src/constants/intranetGuide");
const {
  buildToolDefinitions,
  createToolExecutor,
  sanitizePage,
  buildContextPrompt,
  buildCatalogPrompt,
} = require("../src/services/assistant/assistantTools");
const {
  searchTerms,
  likePattern,
  toPublicPerson,
  documentLabel,
  toPublicEvent,
} = require("../src/services/assistant/directorySearch");

const CL_FEATURES = { supportTickets: true, expenseCenter: true, expenseRequests: true, vacations: true, chileHrPortals: true, lunchMenu: true };
const PE_FEATURES = { supportTickets: false, expenseCenter: true, expenseRequests: true, vacations: true, chileHrPortals: false, lunchMenu: false };
const ids = (entries) => entries.map((entry) => entry.id);

describe("intranetGuide — catálogo filtrado", () => {
  it("oculta lo que la instancia no tiene y lo que el rol no ve", () => {
    const user = guideForUser({ features: PE_FEATURES, isAdmin: false, workAreaId: 7 });
    assert.equal(ids(user).includes("soporte"), false);
    assert.equal(ids(user).includes("rex"), false);
    assert.equal(ids(user).includes("vacaciones-gestion"), false);
    assert.equal(ids(user).includes("gastos-gestion"), false);
    assert.equal(ids(user).includes("gastos-rendicion"), true);
  });

  it("sin rendiciones no ofrece gastos, pero sí los centros de costo", () => {
    const entries = ids(guideForUser({ features: { ...CL_FEATURES, expenseRequests: false }, isAdmin: true, canManageRrhh: true }));
    assert.equal(entries.some((id) => id.startsWith("gastos-")), false);
    assert.ok(entries.includes("centros-costo"));
  });

  it("sin Vacaciones ofrece Rex+ y los feriados siguen para quien gestiona RRHH", () => {
    const chile = { ...CL_FEATURES, vacations: false };
    const rrhh = ids(guideForUser({ features: chile, isAdmin: true, canManageRrhh: true }));
    assert.equal(rrhh.some((id) => id.includes("vacaciones")), false);
    assert.ok(rrhh.includes("feriados"));
    assert.ok(rrhh.includes("rex"));
    const otroAdmin = ids(guideForUser({ features: chile, isAdmin: true }));
    assert.equal(otroAdmin.includes("feriados"), false);
    assert.equal(otroAdmin.includes("areas"), false);
  });

  it("la gestión de gastos es para revisores y administradores", () => {
    assert.ok(ids(guideForUser({ features: CL_FEATURES, isExpenseReviewer: true })).includes("gastos-gestion"));
    assert.ok(ids(guideForUser({ features: CL_FEATURES, isAdmin: true, canManageRrhh: true })).includes("vacaciones-gestion"));
  });

  it("procedimientos apunta a la carpeta del área para un usuario normal", () => {
    const user = guideForUser({ features: CL_FEATURES, isAdmin: false, workAreaId: 7 });
    const admin = guideForUser({ features: CL_FEATURES, isAdmin: true, workAreaId: 7 });
    assert.equal(resolvePage("procedimientos", user).href, "/procesos/procedimientos/7");
    assert.equal(resolvePage("procedimientos", admin).href, "/procesos/procedimientos");
  });

  it("reconoce la página actual por la ruta más específica", () => {
    const admin = guideForUser({ features: CL_FEATURES, isAdmin: true, canManageRrhh: true });
    assert.equal(findEntryForPath("/RRHH/vacaciones/gestion/12", admin).id, "vacaciones-gestion");
    assert.equal(findEntryForPath("/RRHH/vacaciones", admin).id, "vacaciones");
    assert.equal(findEntryForPath("/gastos/nueva/rendicion", admin).id, "gastos-rendicion");
    assert.equal(findEntryForPath("/gastos/42", admin).id, "gastos-mis-solicitudes");
    assert.equal(findEntryForPath("/no-existe", admin), null);
  });

  it("open_page no resuelve portales externos, ids desconocidos ni páginas ocultas", () => {
    const user = guideForUser({ features: CL_FEATURES, isAdmin: false });
    assert.equal(resolvePage("rex", user), null);
    assert.equal(resolvePage("/gastos", user), null);
    assert.equal(resolvePage("feriados", user), null);
    assert.equal(resolvePage("mis-vacaciones", user).href, "/RRHH/vacaciones/mis-vacaciones");
  });

  it("compara rutas sin query ni barra final", () => {
    assert.ok(isSamePage("/gastos", "/gastos/"));
    assert.ok(isSamePage("/RRHH/personal", "/RRHH/personal?q=ana"));
    assert.equal(isSamePage("/gastos", "/gastos/gestion"), false);
  });

  it("el prompt sólo lista lo visible", () => {
    const text = formatGuideForPrompt(guideForUser({ features: PE_FEATURES, isAdmin: false }));
    assert.match(text, /gastos-rendicion/);
    assert.doesNotMatch(text, /Soporte TI/);
    assert.doesNotMatch(text, /Rex\+/);
  });
});

describe("assistantTools — ejecución en el servidor", () => {
  const entries = guideForUser({ features: CL_FEATURES, isAdmin: false });

  it("open_page ofrece sólo ids internos del catálogo del usuario", () => {
    const openPage = buildToolDefinitions(entries).find((tool) => tool.name === "open_page");
    const allowed = openPage.input_schema.properties.page_id.enum;
    assert.ok(allowed.includes("gastos-rendicion"));
    assert.equal(allowed.includes("salesforce"), false);
    assert.equal(allowed.includes("feriados"), false);
  });

  it("open_page programa la navegación y no navega a la página actual", async () => {
    const elsewhere = createToolExecutor({ entries, currentPath: "/" });
    const ok = await elsewhere.execute("open_page", { page_id: "gastos-rendicion" });
    assert.equal(ok.isError, undefined);
    assert.deepEqual(elsewhere.getNavigation(), { href: "/gastos/nueva/rendicion", label: "Rendir gastos" });

    const here = createToolExecutor({ entries, currentPath: "/gastos/nueva/rendicion/" });
    await here.execute("open_page", { page_id: "gastos-rendicion" });
    assert.equal(here.getNavigation(), null);
  });

  it("open_page rechaza lo que no está permitido", async () => {
    const executor = createToolExecutor({ entries, currentPath: "/" });
    const result = await executor.execute("open_page", { page_id: "feriados" });
    assert.equal(result.isError, true);
    assert.equal(executor.getNavigation(), null);
  });

  it("get_page_help entrega pasos y notas sólo de páginas visibles", async () => {
    const executor = createToolExecutor({ entries, currentPath: "/" });
    const help = JSON.parse((await executor.execute("get_page_help", { page_id: "perfil" })).content);
    assert.equal(help.ruta, "/perfil");
    assert.ok(help.pasos.length > 0);
    assert.equal((await executor.execute("get_page_help", { page_id: "feriados" })).isError, true);
  });

  it("el catálogo del prompt es un índice sin pasos", () => {
    const text = buildCatalogPrompt(entries);
    assert.match(text, /`perfil` Mi perfil — \/perfil/);
    assert.doesNotMatch(text, /Cómo se usa/);
  });

  it("search_events usa el servicio inyectado", async () => {
    const executor = createToolExecutor({
      entries,
      currentPath: "/",
      searchEvents: async (query) => [{ nombre: query, enlace: "/marketing/eventos/x" }],
    });
    const result = JSON.parse((await executor.execute("search_events", { query: "aniversario" })).content);
    assert.equal(result.resultados[0].nombre, "aniversario");
    assert.ok(buildToolDefinitions(entries).some((tool) => tool.name === "search_events"));
  });

  it("la autoayuda de Soporte se lista con sus descargas y sólo donde hay Soporte", async () => {
    const apps = [
      { name: "Reparación de Impresora", description: "Repara la cola de impresión.", url_pc: "/content/apps/impresora.exe", url_apk: "" },
      { name: "", description: "sin nombre, se descarta" },
    ];
    const executor = createToolExecutor({
      entries,
      currentPath: "/",
      tickets: { attachmentCount: 0 },
      selfHelp: async () => apps,
    });
    const result = JSON.parse((await executor.execute("list_self_help_tools")).content);
    assert.equal(result.total, 1);
    assert.deepEqual(result.herramientas[0].descargas, { windows: "/content/apps/impresora.exe" });
    assert.equal(result.herramientas[0].enlace, "/sistemas/tickets");

    const sinSoporte = createToolExecutor({ entries, currentPath: "/", selfHelp: async () => apps });
    assert.equal((await sinSoporte.execute("list_self_help_tools")).isError, true);
    const names = (options) => buildToolDefinitions(entries, options).map((tool) => tool.name);
    assert.equal(names().includes("list_self_help_tools"), false);
    assert.ok(names({ supportTickets: true }).includes("list_self_help_tools"));
  });

  it("los tools de tickets sólo existen donde hay Soporte", () => {
    const names = (options) => buildToolDefinitions(entries, options).map((tool) => tool.name);
    assert.equal(names().includes("draft_support_ticket"), false);
    assert.ok(names({ supportTickets: true }).includes("draft_support_ticket"));
    const draft = buildToolDefinitions(entries, { supportTickets: true }).find((tool) => tool.name === "draft_support_ticket");
    assert.ok(draft.input_schema.properties.category.enum.includes("impresoras"));
  });

  it("offer y draft dejan tarjetas para el cliente; sin Soporte fallan", async () => {
    const executor = createToolExecutor({
      entries,
      currentPath: "/",
      tickets: {
        saveDraft: (input) =>
          input.title
            ? { ok: true, draft: { id: "d1", title: input.title, attachments: [] } }
            : { ok: false, error: "Falta el resumen" },
        listMine: async () => [{ id: 7 }],
      },
    });
    await executor.execute("offer_support_ticket", { summary: "No imprime", category: "Impresoras" });
    assert.deepEqual(executor.getActions().ticketOffer, { summary: "No imprime", category: "impresoras" });
    assert.equal((await executor.execute("draft_support_ticket", { description: "x" })).isError, true);
    const ok = await executor.execute("draft_support_ticket", { title: "No imprime", description: "x", category: "impresoras", priority: "medium" });
    assert.match(ok.content, /AÚN NO está creado/);
    assert.equal(executor.getActions().ticketDraft.id, "d1");
    assert.equal(executor.getActions().ticketOffer, null);
    assert.equal(JSON.parse((await executor.execute("my_tickets", {})).content).total, 1);

    const sinSoporte = createToolExecutor({ entries, currentPath: "/" });
    assert.equal((await sinSoporte.execute("draft_support_ticket", { title: "x" })).isError, true);
  });

  it("las búsquedas usan el servicio inyectado y devuelven un enlace al directorio", async () => {
    const executor = createToolExecutor({
      entries,
      currentPath: "/",
      searchPeople: async (query) => [{ nombre: `Ana ${query}` }],
      searchDocuments: async () => {
        throw new Error("BD caída");
      },
    });
    const people = JSON.parse((await executor.execute("search_people", { query: "Pérez" })).content);
    assert.equal(people.total, 1);
    assert.equal(people.enlace_directorio, "/RRHH/personal?q=P%C3%A9rez");

    const docs = await executor.execute("search_documents", { query: "reglamento" });
    assert.equal(docs.isError, true);
    assert.equal((await executor.execute("search_people", { query: "  " })).isError, true);
  });

  it("sanitizePage sólo acepta rutas internas", () => {
    assert.deepEqual(sanitizePage({ path: "/gastos?x=1", title: "Gastos" }), { path: "/gastos", title: "Gastos" });
    assert.equal(sanitizePage({ path: "https://evil.test/" }).path, "/");
    assert.equal(sanitizePage({ path: "//evil.test" }).path, "/");
    assert.equal(sanitizePage(null).path, "/");
  });

  it("el contexto nombra la página actual del catálogo", () => {
    const prompt = buildContextPrompt({
      entries,
      page: { path: "/RRHH/vacaciones", title: "Vacaciones | Intranet" },
      user: { nombre: "Ana Pérez", area: "TI" },
      isAdmin: false,
      isExpenseReviewer: false,
      features: CL_FEATURES,
    });
    assert.match(prompt, /Vacaciones \(`vacaciones`\)/);
    assert.match(prompt, /área: TI/);
  });
});

describe("directorySearch — lo que viaja al modelo", () => {
  it("una persona sólo expone nombre, contacto de empresa y área", () => {
    const person = toPublicPerson({
      first_name: "Ana",
      last_name: "Pérez",
      email: "ana@transworld.cl",
      work_phone: null,
      phone: "56912345678",
      personal_email: "ana.perez@gmail.com",
      area_name: "TI",
      national_id: "12345678-5",
      birth_date: "1990-01-01",
      role: "Administrador",
    });
    assert.deepEqual(Object.keys(person).sort(), ["area", "correo_empresa", "nombre", "telefono_empresa"]);
    assert.equal(person.nombre, "Ana Pérez");
    assert.equal(person.correo_empresa, "ana@transworld.cl");
    assert.equal(person.telefono_empresa, null);
    assert.doesNotMatch(JSON.stringify(person), /gmail|912345678/);
  });

  it("un evento se entrega con su enlace a la galería", () => {
    assert.deepEqual(toPublicEvent({ name: "Fiestas Patrias", slug: "fiestas patrias", fecha: "2026-09-18", image: "x" }), {
      nombre: "Fiestas Patrias",
      fecha: "2026-09-18",
      enlace: "/marketing/eventos/fiestas%20patrias",
    });
  });

  it("los términos ignoran palabras de una letra y escapan comodines", () => {
    assert.deepEqual(searchTerms("  a Ana  de   Pérez "), ["Ana", "de", "Pérez"]);
    assert.equal(likePattern("50%_x"), "%50\\%\\_x%");
  });

  it("la ubicación de un documento sigue el menú de Procesos", () => {
    assert.equal(documentLabel({ type: "reglamento" }), "Reglamento interno");
    assert.equal(documentLabel({ type: "otros" }), "Otros documentos");
    assert.equal(documentLabel({ doc_kind: "protocolo", area_name: "Logística" }), "Protocolos · Logística");
  });
});

describe("claudeService.runAssistantTurn — ciclo de tools", () => {
  process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "test-key";
  const claudeService = require("../src/services/claudeService");

  function fakeStream(message, deltas) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const text of deltas) {
          yield { type: "content_block_delta", delta: { type: "text_delta", text } };
        }
      },
      finalMessage: async () => message,
    };
  }

  function withFakeClient(streams) {
    const requests = [];
    claudeService.client = {
      messages: {
        stream: (params) => {
          requests.push(JSON.parse(JSON.stringify(params)));
          return streams.shift();
        },
      },
    };
    return requests;
  }

  const toolUseRound = () =>
    fakeStream(
      {
        stop_reason: "tool_use",
        usage: { input_tokens: 10, output_tokens: 5 },
        content: [
          { type: "text", text: "Te llevo." },
          { type: "tool_use", id: "tu_1", name: "open_page", input: { page_id: "vacaciones" } },
        ],
      },
      ["Te llevo."],
    );

  it("ejecuta el tool, devuelve el resultado y junta el texto de las rondas", async () => {
    const requests = withFakeClient([
      toolUseRound(),
      fakeStream({ stop_reason: "end_turn", usage: { input_tokens: 20, output_tokens: 3 }, content: [] }, ["Listo."]),
    ]);
    const events = [];
    const calls = [];
    const result = await claudeService.runAssistantTurn([{ role: "user", content: "vacaciones" }], {
      system: "s",
      tools: [{ name: "open_page", input_schema: { type: "object" } }],
      executeTool: async (name, input) => {
        calls.push([name, input]);
        return { content: "ok" };
      },
      onEvent: (ev) => events.push(ev),
    });

    assert.equal(result.text, "Te llevo.\n\nListo.");
    assert.deepEqual(result.usage, {
      input_tokens: 30,
      output_tokens: 8,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    assert.deepEqual(calls, [["open_page", { page_id: "vacaciones" }]]);
    assert.ok(events.some((ev) => ev.type === "tool" && ev.name === "open_page"));
    const toolResult = requests[1].messages.at(-1);
    assert.equal(toolResult.role, "user");
    assert.deepEqual(toolResult.content, [
      { type: "tool_result", tool_use_id: "tu_1", content: "ok", cache_control: { type: "ephemeral" } },
    ]);
    assert.equal(result.rounds, 2);
    assert.equal(requests[1].tool_choice, undefined);
    // Un solo modelo: Haiku, sin effort ni razonamiento extendido.
    assert.equal(requests[0].model, "claude-haiku-4-5");
    assert.equal(requests[0].output_config, undefined);
    assert.equal(requests[0].thinking, undefined);
  });

  it("en la última ronda obliga a responder con texto", async () => {
    const requests = withFakeClient([
      toolUseRound(),
      fakeStream({ stop_reason: "end_turn", usage: {}, content: [] }, ["Fin."]),
    ]);
    await claudeService.runAssistantTurn([{ role: "user", content: "x" }], {
      tools: [{ name: "open_page", input_schema: { type: "object" } }],
      executeTool: async () => ({ content: "ok" }),
      maxToolRounds: 1,
    });
    assert.deepEqual(requests[1].tool_choice, { type: "none" });
    assert.equal(requests.length, 2);
  });

  it("cachea instrucciones y catálogo, pero no la página actual", () => {
    const blocks = claudeService.buildSystemPrompt({ catalog: "CATÁLOGO", context: "PÁGINA" });
    assert.equal(blocks.length, 3);
    assert.equal(blocks[1].text, "CATÁLOGO");
    assert.deepEqual(blocks[1].cache_control, { type: "ephemeral" });
    assert.equal(blocks[0].cache_control, undefined);
    assert.equal(blocks[2].cache_control, undefined);
  });

  it("deriva los datos personales a RRHH e Informática", () => {
    const [instrucciones] = claudeService.buildSystemPrompt();
    assert.match(instrucciones.text, /correo de empresa, teléfono de empresa/);
    assert.match(instrucciones.text, /sólo RRHH e Informática pueden ver los datos personales/);
  });

  it("las instrucciones piden revisar la autoayuda antes de ofrecer un ticket", () => {
    const [instrucciones] = claudeService.buildSystemPrompt();
    assert.match(instrucciones.text, /Asistente de Transworld/);
    assert.match(instrucciones.text, /list_self_help_tools antes de ofrecer un ticket/);
    assert.match(instrucciones.text, /Reparación de Impresora/);
  });
});

describe("assistantConversation — una conversación por sesión", () => {
  const {
    MAX_HISTORY_MESSAGES,
    getHistory,
    appendExchange,
    clearConversation,
  } = require("../src/services/assistant/assistantConversation");

  it("guarda pregunta y respuesta en la sesión y se borra al pedirlo", () => {
    const session = {};
    assert.deepEqual(getHistory(session), []);
    appendExchange(session, "hola", "¡Hola!");
    assert.deepEqual(getHistory(session), [
      { role: "user", content: "hola" },
      { role: "assistant", content: "¡Hola!" },
    ]);
    clearConversation(session);
    assert.deepEqual(getHistory(session), []);
  });

  it("conserva sólo los últimos mensajes y siempre parte con el usuario", () => {
    const session = {};
    for (let i = 0; i < MAX_HISTORY_MESSAGES; i += 1) appendExchange(session, `p${i}`, `r${i}`);
    const history = getHistory(session);
    assert.equal(history.length, MAX_HISTORY_MESSAGES);
    assert.equal(history[0].role, "user");
    assert.equal(history.at(-1).content, `r${MAX_HISTORY_MESSAGES - 1}`);
  });
});
