const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  TICKET_CATEGORIES,
  LEGACY_TICKET_CATEGORIES,
  normalizeTicketCategory,
  ticketCategoryLabel,
} = require("../src/constants/ticketCategories");
const {
  normalizeTicketPriority,
  ticketPriorityLabel,
  attachmentKind,
  isAllowedAttachment,
  normalizeAttachments,
  validateTicketInput,
} = require("../src/services/tickets/ticketRules");

describe("categorías de tickets", () => {
  it("tienen clave, etiqueta y pista únicas, e incluyen los problemas comunes", () => {
    const keys = TICKET_CATEGORIES.map((c) => c.key);
    assert.equal(new Set(keys).size, keys.length);
    for (const key of ["internet", "correo", "impresoras", "salesforce", "sap", "otro"]) {
      assert.ok(keys.includes(key), key);
    }
    for (const category of TICKET_CATEGORIES) {
      assert.ok(category.label && category.hint, category.key);
    }
  });

  it("los valores antiguos se llevan a claves existentes", () => {
    const keys = new Set(TICKET_CATEGORIES.map((c) => c.key));
    for (const [legacy, key] of Object.entries(LEGACY_TICKET_CATEGORIES)) {
      assert.ok(keys.has(key), legacy);
      assert.equal(normalizeTicketCategory(legacy), key);
    }
    assert.equal(normalizeTicketCategory("Hardware"), "equipos");
  });

  it("normaliza claves, etiquetas y rechaza lo desconocido", () => {
    assert.equal(normalizeTicketCategory("SAP"), "sap");
    assert.equal(normalizeTicketCategory("correo"), "correo");
    assert.equal(normalizeTicketCategory("Correo electrónico"), "correo");
    assert.equal(normalizeTicketCategory("cualquier cosa"), null);
    assert.equal(normalizeTicketCategory(""), null);
  });

  it("muestra la etiqueta, y lo desconocido tal cual", () => {
    assert.equal(ticketCategoryLabel("impresoras"), "Impresoras");
    assert.equal(ticketCategoryLabel("Intranet"), "Intranet");
    assert.equal(ticketCategoryLabel("Categoría vieja"), "Categoría vieja");
    assert.equal(ticketCategoryLabel(null), "Sin clasificar");
  });
});

describe("reglas de un ticket", () => {
  it("la prioridad acepta claves y etiquetas, y cae en media", () => {
    assert.equal(normalizeTicketPriority("high"), "high");
    assert.equal(normalizeTicketPriority("Baja"), "low");
    assert.equal(normalizeTicketPriority("urgentísimo"), "medium");
    assert.equal(ticketPriorityLabel("high"), "Alta");
  });

  it("clasifica y filtra adjuntos como el formulario", () => {
    assert.equal(attachmentKind("image/png", "a.png"), "image");
    assert.equal(attachmentKind("video/mp4", "a.mp4"), "video");
    assert.equal(attachmentKind("application/octet-stream", "log.PDF"), "pdf");
    assert.equal(attachmentKind("application/msword", "a.doc"), "doc");
    assert.equal(isAllowedAttachment("image/jpeg", "foto.jpg"), true);
    assert.equal(isAllowedAttachment("application/octet-stream", "informe.docx"), true);
    assert.equal(isAllowedAttachment("application/x-msdownload", "programa.exe"), false);
  });

  it("descarta adjuntos sin URL y corrige tipos desconocidos", () => {
    const list = normalizeAttachments([
      { url: "https://x/a.png", nombre: "a.png", tipo: "image" },
      { nombre: "sin-url.pdf", tipo: "pdf" },
      { url: "https://x/b", tipo: "raro" },
    ]);
    assert.equal(list.length, 2);
    assert.equal(list[1].tipo, "doc");
    assert.deepEqual(normalizeAttachments("no es lista"), []);
  });

  it("exige resumen y descripción, y normaliza el resto", () => {
    assert.equal(validateTicketInput({ description: "x" }).ok, false);
    assert.equal(validateTicketInput({ title: "x" }).ok, false);
    assert.equal(validateTicketInput({ title: "a".repeat(201), description: "x" }).ok, false);

    const result = validateTicketInput({
      title: "  No imprime  ",
      description: "La impresora del segundo piso no responde.",
      category: "Hardware",
      priority: "Alta",
    });
    assert.equal(result.ok, true);
    assert.deepEqual(result.ticket, {
      title: "No imprime",
      description: "La impresora del segundo piso no responde.",
      category: "equipos",
      priority: "high",
      attachments: [],
    });
    assert.equal(validateTicketInput({ title: "a", description: "b", category: "??" }).ticket.category, "otro");
  });
});
