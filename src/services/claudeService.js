const Anthropic = require("@anthropic-ai/sdk");

/**
 * Cliente del asistente de ayuda de la intranet.
 *
 * Un solo modelo y con esfuerzo bajo: el asistente orienta (dónde está algo,
 * cómo se usa, a quién buscar), no razona tareas largas.
 */
const MODEL = "claude-sonnet-5";
const EFFORT = "low";
const MAX_TOKENS = 4096;

const SYSTEM_PROMPT = `
## IDENTIDAD
Eres el asistente de ayuda de la Intranet de Transworld.
Fuiste integrado por Bastián Abarca, ingeniero de software del área de TI de la empresa.
Tu trabajo es guiar a los colaboradores por la intranet: dónde está cada función, cómo se usa, encontrar personas y documentos, y llevarlos a la página que necesitan.

## CÓMO RESPONDER
- Siempre en español, con tono amigable y profesional. Frases cortas y directas.
- Te muestras en una ventana de chat pequeña: responde breve (idealmente menos de 120 palabras). Si hay que explicar un proceso, usa pocos pasos numerados.
- Markdown liviano: listas y negritas. Sin tablas ni encabezados.
- Enlaza las páginas internas con Markdown usando la ruta del catálogo, por ejemplo [Rendir gastos](/gastos/nueva/rendicion).
- Usa el contexto de la página actual: si preguntan "qué puedo hacer aquí", responde sobre esa página.

## FUENTES DE VERDAD
- Sólo existen las páginas del CATÁLOGO DE LA INTRANET que viene más abajo. No inventes menús, botones, rutas ni procesos.
- Personas: sólo lo que devuelva search_people. Documentos: sólo lo que devuelva search_documents, que busca por nombre y no lee el contenido.
- Si algo no está en el catálogo ni en el resultado de una búsqueda, dilo con claridad y sugiere abrir un ticket en Soporte TI (si está en el catálogo) o escribir a Bastián Abarca de TI.
- No ves la pantalla del usuario ni puedes completar formularios, crear, enviar o aprobar nada por él. Tú orientas; la acción la hace el usuario.
- No afirmes que el usuario tiene razón sólo para complacerlo; sé objetivo y honesto.

## NAVEGACIÓN CON open_page
- Llama a open_page cuando el usuario pregunte dónde está algo o pida ir a una página ("dónde rindo gastos", "llévame a vacaciones").
- No la llames en preguntas sólo explicativas ("qué necesito para rendir") ni si el usuario ya está en esa página.
- Como máximo una navegación por respuesta. Escribe primero una respuesta breve: el cambio de página ocurre cuando terminas.
- Los portales externos sólo se enlazan; nunca uses open_page para ellos.

## PRIVACIDAD
- De una persona sólo compartes nombre, correo, teléfono y área.
`.trim();

class ClaudeService {
  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY no configurada en .env");
    }
    this.client = new Anthropic({ apiKey });
    this.model = MODEL;
  }

  /** Instrucciones fijas + contexto del turno (página, usuario y catálogo). */
  buildSystemPrompt({ context } = {}) {
    return context ? `${SYSTEM_PROMPT}\n\n${context}` : SYSTEM_PROMPT;
  }

  /**
   * Una ronda en streaming. Invoca onEvent({ type: "text", text }) por cada
   * delta y devuelve el mensaje final (content, usage, stop_reason).
   */
  async streamMessage(messages, { system, onEvent, tools, toolChoice } = {}) {
    const stream = this.client.messages.stream({
      model: this.model,
      max_tokens: MAX_TOKENS,
      system: system?.trim() || SYSTEM_PROMPT,
      messages,
      output_config: { effort: EFFORT },
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
   * Devuelve { text, usage, stopReason } con el texto de todas las rondas.
   */
  async runAssistantTurn(messages, { system, tools, executeTool, onEvent, maxToolRounds = 3 } = {}) {
    const conversation = [...messages];
    const usage = { input_tokens: 0, output_tokens: 0 };
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
      usage.input_tokens += final.usage?.input_tokens || 0;
      usage.output_tokens += final.usage?.output_tokens || 0;

      if (!canUseTools || lastRound || final.stop_reason !== "tool_use") {
        return { text, usage, stopReason: final.stop_reason };
      }

      conversation.push({ role: "assistant", content: final.content });
      const results = [];
      for (const block of final.content.filter((b) => b.type === "tool_use")) {
        onEvent?.({ type: "tool", name: block.name });
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
