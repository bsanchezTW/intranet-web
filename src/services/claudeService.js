const Anthropic = require("@anthropic-ai/sdk");

/**
 * Cliente del asistente de ayuda de la intranet.
 *
 * Un solo modelo, Haiku 4.5: las tareas son cortas (orientar, buscar, armar un
 * ticket o un correo) y cada ronda del ciclo de tools reenvía todo el contexto,
 * así que el costo por token pesa más que la capacidad extra de un modelo
 * mayor. Haiku no admite razonamiento extendido ni `effort`.
 */
const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 2048;
const CACHE = Object.freeze({ type: "ephemeral" });

const SYSTEM_PROMPT = `
## IDENTIDAD
Eres el asistente de ayuda de la Intranet de Transworld.
Fuiste integrado por Bastián Abarca, ingeniero de software del área de TI de la empresa.
Tu trabajo es guiar a los colaboradores por la intranet: dónde está cada función, cómo se usa, encontrar personas y documentos, y llevarlos a la página que necesitan.

## CÓMO RESPONDER
- Siempre en español, con tono amigable y profesional. Frases cortas y directas.
- Te muestras en una ventana de chat pequeña: responde breve (idealmente menos de 120 palabras), salvo cuando te pidan redactar un texto. Si hay que explicar un proceso, usa pocos pasos numerados.
- Markdown liviano: listas y negritas. Sin tablas ni encabezados.
- Enlaza las páginas internas con Markdown usando la ruta del catálogo, por ejemplo [Noticias](/noticias).
- Usa el contexto de la página actual: si preguntan "qué puedo hacer aquí", responde sobre esa página.

## FUENTES DE VERDAD
- Sólo existen las páginas del CATÁLOGO DE LA INTRANET que viene más abajo. No inventes menús, botones, rutas ni procesos.
- El catálogo es un índice. Antes de explicar cómo se usa una página, pide sus pasos y notas con get_page_help.
- Personas: sólo lo que devuelva search_people. Documentos: sólo lo que devuelva search_documents, que busca por nombre y no lee el contenido. Eventos de la galería: search_events.
- Si algo no está en el catálogo ni en el resultado de una búsqueda, dilo con claridad y sugiere abrir un ticket en Soporte (si está en el catálogo) o escribir a Bastián Abarca de TI.
- No ves la pantalla del usuario ni completas formularios, envías o apruebas nada por él. La única excepción es el borrador de ticket de Soporte, que el usuario confirma con un botón.
- No afirmes que el usuario tiene razón sólo para complacerlo; sé objetivo y honesto.

## NAVEGACIÓN CON open_page
- Llama a open_page cuando el usuario pregunte dónde está algo o pida ir a una página ("llévame a la galería").
- No la llames en preguntas sólo explicativas ni si el usuario ya está en esa página.
- Como máximo una navegación por respuesta. Escribe primero una respuesta breve: el cambio de página ocurre cuando terminas.
- Los portales externos sólo se enlazan; nunca uses open_page para ellos.

## CORREOS Y TEXTOS
- Si te piden redactar un correo formal, un mensaje o un aviso, escríbelo completo y listo para copiar: asunto (en correos), saludo, cuerpo claro y despedida, en español formal.
- No inventes datos: usa marcadores como [nombre del destinatario] o [fecha] para lo que no sepas.
- Tú no envías correos; el usuario copia el texto con el botón «Copiar».

## SOPORTE Y TICKETS
- Si el usuario cuenta un problema técnico (internet, correo, impresoras, computador, Salesforce, SAP, cuentas, la intranet…), da una sugerencia breve sólo si es obvia y responde: "Puedo dirigirte a crear un ticket o crearlo por ti". En ese mismo turno llama a offer_support_ticket.
- Si pide que lo crees ("créalo por mí", "hazme el ticket"), llama a draft_support_ticket. Si falta algo esencial para entender el problema (qué falla o desde cuándo), pregúntalo una sola vez antes.
- Nunca digas que el ticket está creado: el usuario lo crea con «Crear ticket» en la tarjeta. Tras armar el borrador, pídele que lo revise y pregúntale si quiere agregar fotos de su problema en la casilla de la tarjeta.
- Para corregir el borrador, vuelve a llamar a draft_support_ticket con los datos corregidos.
- Los archivos que el usuario adjunta (con el clip o en la casilla de la tarjeta) se suben solos cuando crea el ticket.
- Para "¿cómo va mi ticket?" usa my_tickets.

## PRIVACIDAD
- De una persona sólo compartes nombre, correo, teléfono y área.
`.trim();

/**
 * Copia de la conversación con una marca de caché en su último bloque. Las
 * rondas siguientes del mismo turno (tras cada tool) reutilizan todo lo
 * anterior en vez de pagarlo de nuevo como entrada.
 */
function withConversationCache(messages) {
  if (!messages.length) return messages;
  const last = messages[messages.length - 1];
  const content =
    typeof last.content === "string"
      ? [{ type: "text", text: last.content }]
      : last.content.map((block) => ({ ...block }));
  content[content.length - 1] = { ...content[content.length - 1], cache_control: CACHE };
  return [...messages.slice(0, -1), { ...last, content }];
}

class ClaudeService {
  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY no configurada en .env");
    }
    this.client = new Anthropic({ apiKey });
    this.model = MODEL;
  }

  /**
   * System en bloques, de lo más estable a lo que cambia en cada turno. La
   * marca de caché va al final del catálogo: tools (que preceden al system),
   * instrucciones y catálogo del usuario se reutilizan entre rondas y turnos.
   * La página actual queda fuera, en el último bloque.
   */
  buildSystemPrompt({ catalog, context } = {}) {
    const blocks = [{ type: "text", text: SYSTEM_PROMPT }];
    if (catalog) blocks.push({ type: "text", text: catalog });
    blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CACHE };
    if (context) blocks.push({ type: "text", text: context });
    return blocks;
  }

  /**
   * Una ronda en streaming. Invoca onEvent({ type: "text", text }) por cada
   * delta y devuelve el mensaje final (content, usage, stop_reason).
   */
  async streamMessage(messages, { system, onEvent, tools, toolChoice } = {}) {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: system || this.buildSystemPrompt(),
      messages: withConversationCache(messages),
      ...(tools?.length ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
    });

    for await (const event of stream) {
      if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        onEvent?.({ type: "text", text: event.delta.text });
      }
    }

    return stream.finalMessage();
  }

  /**
   * Un turno del asistente con tools: streamea, ejecuta en el servidor los
   * tool_use que pida el modelo y vuelve a streamear con los resultados.
   * En la última ronda permitida se fuerza tool_choice "none" para que cierre
   * con texto (el historial ya trae bloques tool_use, así que tools no se omite).
   *
   * onEvent recibe además { type: "tool", name } antes de ejecutar cada tool.
   * Devuelve { text, usage, rounds, stopReason } sumando todas las rondas.
   */
  async runAssistantTurn(messages, { system, tools, executeTool, onEvent, maxToolRounds = 3 } = {}) {
    const conversation = [...messages];
    const usage = {
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    };
    const canUseTools = Boolean(tools?.length && executeTool);
    let text = "";

    for (let round = 0; ; round += 1) {
      const lastRound = round >= maxToolRounds;
      // El texto de cada ronda va en su propio párrafo.
      let separated = !text;
      const final = await this.streamMessage(conversation, {
        system,
        tools: canUseTools ? tools : undefined,
        toolChoice: canUseTools && lastRound ? { type: "none" } : undefined,
        onEvent: (ev) => {
          if (ev.type === "text") {
            if (!separated) {
              separated = true;
              text += "\n\n";
              onEvent?.({ type: "text", text: "\n\n" });
            }
            text += ev.text;
          }
          onEvent?.(ev);
        },
      });
      for (const key of Object.keys(usage)) usage[key] += final.usage?.[key] || 0;

      if (!canUseTools || lastRound || final.stop_reason !== "tool_use") {
        return { text, usage, rounds: round + 1, stopReason: final.stop_reason };
      }

      conversation.push({ role: "assistant", content: final.content });
      const results = [];
      for (const block of final.content.filter((b) => b.type === "tool_use")) {
        onEvent?.({ type: "tool", name: block.name, input: block.input });
        const result = await executeTool(block.name, block.input);
        results.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: result.content,
          ...(result.isError ? { is_error: true } : {}),
        });
      }
      conversation.push({ role: "user", content: results });
    }
  }
}

module.exports = new ClaudeService();
module.exports.withConversationCache = withConversationCache;
