const Anthropic = require("@anthropic-ai/sdk");
const path = require("path");
const officeDocumentParser = require("./officeDocumentParser");
const { isUnlimitedUsage } = require("./claudeDailyLimits");

// Usuarios normales: Haiku 4.5 (el más económico). Los administradores pueden elegir otro modelo.
const DEFAULT_SYSTEM_PROMPT = `
## IDENTIDAD
Eres el asistente de ayuda de la Intranet de Transworld.
Fuiste integrado por Bastián Abarca, ingeniero de software del área de TI de la empresa.
Tu trabajo es guiar a los colaboradores por la intranet: dónde está cada función, cómo se usa, encontrar personas y documentos, y llevarlos a la página que necesitan.

## CÓMO RESPONDER
- Siempre en español, con tono amigable y profesional. Frases cortas y directas.
- Cuando expliques cómo hacer algo, usa pasos numerados. Markdown liviano, sin tablas largas.
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

/**
 * Reglas para devolver archivos. Sólo se agregan cuando el turno trae adjuntos:
 * la UI del asistente de ayuda ya no ofrece adjuntar, pero el backend lo sigue
 * soportando.
 */
const FILE_OUTPUT_PROMPT = `
## ARCHIVOS ADJUNTOS — DEVOLUCIÓN EN EL MISMO FORMATO
Cuando el usuario adjunta uno o más archivos y pide editarlos, completarlos, traducirlos, resumirlos en archivo, exportarlos o devolverlos modificados:

1. **Misma extensión obligatoria**: el archivo de salida debe tener la MISMA extensión que el archivo de origen (.xlsx → .xlsx, .docx → .docx, .pdf → .pdf, .csv → .csv, etc.). Nunca cambies de formato.
2. **Mismo nombre base**: conserva el nombre del archivo original; puedes añadir un sufijo como "-editado" o "-actualizado" antes de la extensión.
3. **Sin código visible**: PROHIBIDO usar bloques de código (\`\`\`python, \`\`\`javascript, \`\`\`sql, \`\`\`html, \`\`\`csv sueltos, etc.). El usuario no debe ver código en el chat.
4. **Solo tarjeta de descarga**: entrega el resultado ÚNICAMENTE con el bloque \`\`\`file (ver abajo). El contenido queda oculto; la interfaz muestra solo el nombre y el botón Descargar.
5. **Texto mínimo**: escribe como máximo 1–2 frases breves antes del bloque file. No pegues, repitas ni resumas el contenido del archivo en el mensaje.

## GENERACIÓN DE ARCHIVOS DESCARGABLES
La interfaz convierte el bloque \`\`\`file en una tarjeta de descarga moderna. El contenido NO se muestra en el chat.

Formato obligatorio:

\`\`\`file
nombre-archivo.ext
[contenido interno del archivo — no visible para el usuario]
\`\`\`

La PRIMERA LÍNEA es el nombre del archivo con extensión. El resto es el contenido estructurado que el sistema empaquetará en el formato real indicado por la extensión:

- .xlsx / .xls / .xlsm → tienes DOS modos:

  A) EDITAR un Excel que el usuario adjuntó (limpiar datos, borrar/agregar columnas o filas,
     corregir celdas, cambiar fórmulas, etc.). Es el modo OBLIGATORIO cuando hay un Excel adjunto:
     devuelve SOLO las operaciones a aplicar sobre el archivo original. El sistema conserva
     intacto todo el resto del formato (estilos, colores, fórmulas, anchos, hojas, etc.).
     {"edit":{"sheet":"Hoja1","ops":[
       {"deleteCol":"C"},
       {"deleteRow":7},
       {"clear":"B2:B50"},
       {"set":"D5","v":1200,"z":"$#,##0"},
       {"set":"E2","f":"=B2*C2"}
     ]}}
     Reglas del modo edición:
       • Usa SIEMPRE las coordenadas del archivo ORIGINAL (A1, B2, columna "C", fila 7…).
         No te preocupes por el desplazamiento al borrar: el sistema lo resuelve.
       • Operaciones disponibles: "deleteCol"(letra o número), "deleteRow"(número),
         "clear"(celda o rango p.ej. "B2:B50"), "set"(celda con "v" valor, "f" fórmula, "z" formato).
       • Incluye únicamente las celdas/columnas/filas que cambian. NO reescribas toda la hoja.
       • Para varias hojas usa {"edits":[{"sheet":"Hoja1","ops":[...]},{"sheet":"Hoja2","ops":[...]}]}.

  B) CREAR un Excel nuevo desde cero (no hay archivo original) → JSON enriquecido completo:
     {"sheets":[{"name":"Hoja1","columnWidths":[18,12],"rows":[
       ["Encabezado A","Encabezado B"],
       ["Texto",{"v":1200,"z":"$#,##0"}],
       ["Total",{"f":"=B2*1.19","v":1428}]
     ]}]}
     Reglas: conserva nombres de hoja y columnWidths; usa números sin comillas; para fórmulas
     usa {"f":"=SUMA(A2:A10)"}; para formato numérico usa "z" (ej. "$#,##0", "0.00%").
- .docx / .doc → Markdown con encabezados (#, ##), listas (-), tablas (| col |) y negritas (**texto**). El sistema genera un Word real (.docx).
- .pdf → Markdown con la misma estructura que Word; el sistema genera un PDF descargable.
- .csv → datos separados por coma (una fila por línea).
- .txt / .md → texto plano o Markdown.
- .json → JSON válido.

REGLAS ABSOLUTAS:
- Nunca digas que no puedes generar o descargar archivos.
- Si el usuario pidió un archivo (con o sin adjunto), usa siempre \`\`\`file y nunca bloques de código normales.
`.trim();

const FORMAT_LABELS = {
  ".pdf": "PDF",
  ".doc": "Word",
  ".docx": "Word",
  ".xls": "Excel",
  ".xlsx": "Excel",
  ".xlsm": "Excel",
  ".csv": "CSV",
  ".txt": "Texto",
  ".md": "Markdown",
  ".json": "JSON",
  ".png": "Imagen PNG",
  ".jpg": "Imagen JPEG",
  ".jpeg": "Imagen JPEG",
  ".webp": "Imagen WebP",
  ".gif": "Imagen GIF",
};

class ClaudeService {
  constructor() {
    const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY no configurada en .env");
    }
    this.client = new Anthropic({ apiKey });

    this.economicModel = "claude-haiku-4-5";
    this.models = [
      { id: "claude-sonnet-5", name: "Claude Sonnet 5", tokens: 1000000 },
      { id: "claude-opus-4-8", name: "Claude Opus 4.8", tokens: 1000000 },
      { id: "claude-fable-5", name: "Claude Fable 5", tokens: 1000000},
    ];
    // Modelo inicial del selector de administradores.
    this.defaultModel = this.models[0].id;
  }

  getAvailableModels() {
    return this.models;
  }

  getDefaultModel() {
    return this.defaultModel;
  }

  getEconomicModel() {
    return this.economicModel;
  }

  getModelName(modelId) {
    return this.models.find((m) => m.id === modelId)?.name || modelId;
  }

  /** System prompt base + contexto del turno + reglas de archivos si hay adjuntos. */
  buildSystemPrompt({ customPrompt, context, attachments = [] } = {}) {
    const parts = [customPrompt?.trim() || DEFAULT_SYSTEM_PROMPT];
    if (context) parts.push(context);
    if (attachments?.length) {
      parts.push(FILE_OUTPUT_PROMPT, this.buildAttachmentOutputRules(attachments));
    }
    return parts.join("\n\n");
  }

  /** Instrucciones concretas por los archivos que el usuario acaba de subir. */
  buildAttachmentOutputRules(attachments) {
    const lines = attachments.map((att) => {
      const ext = extensionOf(att.filename) || "(sin extensión)";
      const label = FORMAT_LABELS[ext] || ext.replace(/^\./, "").toUpperCase() || "archivo";
      return `- **${att.filename}** → formato de salida obligatorio: **${ext}** (${label})`;
    });

    const primary = attachments[0];
    const primaryExt = extensionOf(primary.filename);
    const primaryBase = path.basename(primary.filename, primaryExt) || "documento";

    return `## CONTEXTO DE ESTE MENSAJE — ARCHIVOS ADJUNTOS
El usuario acaba de subir:
${lines.join("\n")}

Si debes devolver un archivo procesado:
- Usa extensión **${primaryExt || "igual al original"}** (ejemplo de nombre: \`${primaryBase}-editado${primaryExt}\`).
- Un solo bloque \`\`\`file por archivo de salida; cero bloques de código visibles.
- Máximo 1–2 frases de texto; luego solo la tarjeta de descarga.`;
  }

  /** Usuarios normales siempre usan el modelo económico; solo administradores pueden elegir otro. */
  resolveModel(requestedModel, isAdmin) {
    if (!isAdmin) return this.economicModel;
    if (requestedModel && this.models.some((m) => m.id === requestedModel)) {
      return requestedModel;
    }
    return this.defaultModel;
  }

  // Haiku 4.5 no soporta adaptive thinking ni el parámetro effort.
  _supportsThinking(model) {
    return !model.includes("haiku");
  }

  // Construye los parámetros opcionales según las capacidades del modelo.
  _modelParams(model) {
    const params = {};
    if (this._supportsThinking(model)) {
      params.thinking = { type: "adaptive", display: "summarized" };
      params.output_config = { effort: "high" };
    }
    return params;
  }

  /**
   * Envía una conversación a Claude en modo streaming.
   * Invoca onEvent({ type: "thinking" | "text", text }) por cada delta.
   * Devuelve el mensaje final (incluye usage y stop_reason).
   */
  async streamMessage(messages, model = this.defaultModel, { system, onEvent, tools, toolChoice } = {}) {
    const stream = this.client.messages.stream({
      model,
      max_tokens: 16000,
      system: system?.trim() || DEFAULT_SYSTEM_PROMPT,
      messages,
      ...(tools?.length ? { tools } : {}),
      ...(toolChoice ? { tool_choice: toolChoice } : {}),
      ...this._modelParams(model),
    });

    for await (const event of stream) {
      if (event.type !== "content_block_delta") continue;
      if (event.delta.type === "text_delta") {
        onEvent?.({ type: "text", text: event.delta.text });
      } else if (event.delta.type === "thinking_delta") {
        onEvent?.({ type: "thinking", text: event.delta.thinking });
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
  async runAssistantTurn(
    messages,
    model = this.defaultModel,
    { system, tools, executeTool, onEvent, maxToolRounds = 3 } = {}
  ) {
    const conversation = [...messages];
    const usage = { input_tokens: 0, output_tokens: 0 };
    const canUseTools = Boolean(tools?.length && executeTool);
    let text = "";

    for (let round = 0; ; round += 1) {
      const lastRound = round >= maxToolRounds;
      // El texto de cada ronda va en su propio párrafo.
      let separated = !text;
      const final = await this.streamMessage(conversation, model, {
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

  /**
   * Construye un bloque de contenido a partir de un archivo subido (buffer + mime).
   * Soporta PDF, imágenes, texto plano, Word (.doc/.docx) y Excel (.xls/.xlsx).
   */
  async buildAttachmentBlock({ buffer, mimeType, filename }) {
    const base64 = buffer.toString("base64");
    const officeKind = officeDocumentParser.getOfficeKind(filename, mimeType);

    if (mimeType === "application/pdf" || extensionOf(filename) === ".pdf") {
      return {
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: base64 },
        title: filename,
      };
    }

    if (mimeType?.startsWith("image/")) {
      return {
        type: "image",
        source: { type: "base64", media_type: mimeType, data: base64 },
      };
    }

    if (officeKind) {
      const text = await officeDocumentParser.extractOfficeText(buffer, filename, mimeType);
      const label = officeKind === "word" ? "documento Word" : "hoja de cálculo Excel";
      const formatHint =
        officeKind === "word"
          ? "El contenido está en Markdown (encabezados, listas, tablas). Si devuelves el archivo editado, usa el mismo formato Markdown dentro del bloque ```file."
          : 'El contenido está en JSON con "sheets" (filas y celdas con sus coordenadas, fórmulas en "f", formatos en "z" y columnWidths). IMPORTANTE: como este Excel ya existe, si el usuario pide editarlo (limpiar datos, borrar una columna/fila, corregir celdas, etc.) NO reescribas toda la hoja: devuelve dentro del bloque ```file SOLO las operaciones de edición {"edit":{"sheet":"...","ops":[...]}} usando las coordenadas originales (ver reglas del modo edición). Así se conserva intacto todo el formato del archivo.';
      return {
        type: "text",
        text: `Contenido estructurado del ${label} "${filename}":\n${formatHint}\n\n${text}`,
      };
    }

    return {
      type: "text",
      text: `Contenido del archivo "${filename}":\n\n${buffer.toString("utf-8")}`,
    };
  }

  /** Los administradores no tienen cuota diaria de mensajes ni archivos. */
  hasUnlimitedDailyUsage(isAdmin) {
    return isUnlimitedUsage(isAdmin);
  }

  /** Valida tipo y tamaño de un adjunto antes de aceptarlo en el chat. */
  async validateAttachment(file, { isAdmin = false } = {}) {
    if (!file?.buffer?.length) {
      return { valid: false, error: "Archivo vacío o no proporcionado" };
    }
    if (!this.validateFileSize(file.size, { isAdmin })) {
      const maxSizeMB = parseInt(process.env.CLAUDE_MAX_FILE_SIZE || "10", 10);
      return { valid: false, error: `Archivo demasiado grande. Máximo ${maxSizeMB}MB` };
    }
    if (!this.isAllowedAttachment(file.originalname, file.mimetype)) {
      return {
        valid: false,
        error:
          "Tipo de archivo no soportado. Usa PDF, Word, Excel, imagen o texto (txt, csv, md, json).",
      };
    }

    const officeKind = officeDocumentParser.getOfficeKind(file.originalname, file.mimetype);
    if (officeKind) {
      try {
        await officeDocumentParser.extractOfficeText(file.buffer, file.originalname, file.mimetype);
      } catch (err) {
        return { valid: false, error: err.message || "No se pudo leer el documento Office" };
      }
    }

    return { valid: true };
  }

  isAllowedAttachment(filename, mimeType = "") {
    const ext = extensionOf(filename);
    const allowedExtensions = new Set([
      ".pdf",
      ".png",
      ".jpg",
      ".jpeg",
      ".webp",
      ".gif",
      ".txt",
      ".csv",
      ".md",
      ".json",
      ...officeDocumentParser.WORD_EXTENSIONS,
      ...officeDocumentParser.EXCEL_EXTENSIONS,
    ]);

    if (allowedExtensions.has(ext)) return true;
    if (mimeType === "application/pdf") return true;
    if (mimeType?.startsWith("image/")) return true;
    if (mimeType?.startsWith("text/")) return true;
    if (officeDocumentParser.getOfficeKind(filename, mimeType)) return true;

    return false;
  }

  /**
   * Extrae información estructurada de un PDF (o imagen) usando salidas
   * estructuradas (output_config.format). Devuelve un objeto validado.
   */
  async extractDocumentData({ buffer, mimeType, filename }, model = this.defaultModel, instructions = "") {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: {
        titulo: { type: "string", description: "Título o nombre del documento" },
        tipo_documento: {
          type: "string",
          description: "Tipo de documento (contrato, factura, informe, carta, etc.)",
        },
        resumen: { type: "string", description: "Resumen ejecutivo en 2-4 frases" },
        puntos_clave: {
          type: "array",
          description: "Puntos más importantes del documento",
          items: { type: "string" },
        },
        datos_importantes: {
          type: "array",
          description: "Pares campo/valor relevantes (números de referencia, partes, etc.)",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              campo: { type: "string" },
              valor: { type: "string" },
            },
            required: ["campo", "valor"],
          },
        },
        fechas_relevantes: {
          type: "array",
          description: "Fechas mencionadas y su significado",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              descripcion: { type: "string" },
              fecha: { type: "string" },
            },
            required: ["descripcion", "fecha"],
          },
        },
        montos: {
          type: "array",
          description: "Importes o cifras económicas mencionadas",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              concepto: { type: "string" },
              valor: { type: "string" },
            },
            required: ["concepto", "valor"],
          },
        },
        acciones_requeridas: {
          type: "array",
          description: "Acciones, plazos o pasos a seguir derivados del documento",
          items: { type: "string" },
        },
      },
      required: [
        "titulo",
        "tipo_documento",
        "resumen",
        "puntos_clave",
        "datos_importantes",
        "fechas_relevantes",
        "montos",
        "acciones_requeridas",
      ],
    };

    const promptText =
      "Analiza el documento adjunto y extrae la información importante de forma estructurada. " +
      "Rellena cada campo del esquema; si un campo no aplica, usa un arreglo vacío o el texto \"No especificado\". " +
      (instructions ? `Indicaciones adicionales del usuario: ${instructions}` : "");

    const response = await this.client.messages.create({
      model,
      max_tokens: 8000,
      system:
        "Eres un analista documental experto. Extraes información de documentos de negocio en español con precisión.",
      messages: [
        {
          role: "user",
          content: [
            await this.buildAttachmentBlock({ buffer, mimeType, filename }),
            { type: "text", text: promptText },
          ],
        },
      ],
      output_config: { format: { type: "json_schema", schema } },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    const raw = textBlock?.text || "{}";

    try {
      return { success: true, data: JSON.parse(raw), usage: response.usage };
    } catch (err) {
      return { success: false, error: "No se pudo interpretar la respuesta estructurada", raw };
    }
  }

  validateFileSize(sizeInBytes, { isAdmin = false } = {}) {
    if (isUnlimitedUsage(isAdmin)) return true;
    const maxSizeMB = parseInt(process.env.CLAUDE_MAX_FILE_SIZE || "10", 10);
    return sizeInBytes <= maxSizeMB * 1024 * 1024;
  }

  provisionalTitle(userText, attachmentName) {
    const text = String(userText || "").trim();
    if (text) return text.slice(0, 60);
    if (attachmentName) return `Análisis: ${attachmentName}`.slice(0, 60);
    return "Nueva conversación";
  }

  sanitizeTitle(title) {
    return String(title || "")
      .replace(/^["'«]+|["'»]+$/g, "")
      .replace(/[.?!]+$/g, "")
      .trim()
      .slice(0, 60);
  }

  /** Convierte el resultado de extracción en texto Markdown para persistir en el historial. */
  formatExtractAsMarkdown(data) {
    const d = data || {};
    const lines = [];
    const pushSection = (title, items) => {
      if (!items?.length) return;
      lines.push(`### ${title}`);
      items.forEach((item) => lines.push(`- ${item}`));
      lines.push("");
    };
    const pushKv = (title, arr, k, v) => {
      if (!arr?.length) return;
      lines.push(`### ${title}`);
      arr.forEach((item) => lines.push(`- **${item[k]}:** ${item[v]}`));
      lines.push("");
    };

    lines.push(`**${d.tipo_documento || "Documento"}:** ${d.titulo || "Sin título"}`);
    lines.push("");
    if (d.resumen) {
      lines.push("### Resumen");
      lines.push(d.resumen);
      lines.push("");
    }
    pushSection("Puntos clave", d.puntos_clave);
    pushKv("Datos importantes", d.datos_importantes, "campo", "valor");
    pushKv("Fechas relevantes", d.fechas_relevantes, "descripcion", "fecha");
    pushKv("Montos", d.montos, "concepto", "valor");
    pushSection("Acciones requeridas", d.acciones_requeridas);
    return lines.join("\n").trim() || "Extracción completada.";
  }

  /** Genera un título corto a partir del primer intercambio de la conversación. */
  async generateConversationTitle({ userText, assistantText, attachmentName }) {
    const parts = [];
    if (attachmentName) parts.push(`Archivo adjunto: ${attachmentName}`);
    if (userText?.trim()) parts.push(`Mensaje del usuario: ${userText.trim()}`);
    if (assistantText?.trim()) {
      parts.push(`Respuesta del asistente: ${assistantText.trim().slice(0, 500)}`);
    }
    const context = parts.join("\n");
    if (!context.trim()) return this.provisionalTitle(userText, attachmentName);

    try {
      const response = await this.client.messages.create({
        model: this.economicModel,
        max_tokens: 40,
        system:
          "Generas títulos breves para conversaciones de chat empresarial. " +
          "Responde solo con el título: sin comillas, sin explicación, máximo 8 palabras, en español.",
        messages: [
          {
            role: "user",
            content: `Asigna un título descriptivo a esta conversación:\n\n${context}`,
          },
        ],
      });
      const raw = response.content.find((b) => b.type === "text")?.text || "";
      return this.sanitizeTitle(raw) || this.provisionalTitle(userText, attachmentName);
    } catch (err) {
      console.error("[ClaudeService] Error generando título:", err.message);
      return this.provisionalTitle(userText, attachmentName);
    }
  }
}

module.exports = new ClaudeService();

function extensionOf(filename) {
  return path.extname(filename || "").toLowerCase();
}
