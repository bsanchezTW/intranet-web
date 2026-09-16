const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  TICKET_CATEGORIES,
  LEGACY_TICKET_CATEGORIES,
  normalizeTicketCategory,
  ticketCategoryLabel,
} = require("../src/constants/ticketCategories");
const {
  MAX_ATTACHMENTS,
  normalizeTicketPriority,
  ticketPriorityLabel,
  attachmentKind,
  isAllowedAttachment,
  attachmentFileName,
  validateAttachmentFiles,
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

  it("los adjuntos se nombran con el número de ticket y un correlativo", () => {
    assert.equal(attachmentFileName(4821, 1, "Captura de pantalla.PNG"), "4821_1.png");
    assert.equal(attachmentFileName(4821, 2, "informe.docx"), "4821_2.docx");
    assert.equal(attachmentFileName(4821, 3, "sin-extension"), "4821_3");
    assert.equal(attachmentFileName(4821, 4, "raro.ext-muy-larga!"), "4821_4");
  });

  it("valida los archivos antes de crear el ticket", () => {
    const file = (originalname, mimetype, size = 10) => ({ originalname, mimetype, size });
    assert.deepEqual(validateAttachmentFiles([]), { ok: true });
    assert.equal(validateAttachmentFiles([file("a.png", "image/png")], { maxBytes: 100 }).ok, true);
    assert.equal(validateAttachmentFiles([file("virus.exe", "application/x-msdownload")]).ok, false);
    assert.equal(validateAttachmentFiles([file("grande.png", "image/png", 200)], { maxBytes: 100 }).ok, false);
    const muchos = Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`${i}.png`, "image/png"));
    assert.equal(validateAttachmentFiles(muchos).ok, false);
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
    });
    assert.equal(validateTicketInput({ title: "a", description: "b", category: "??" }).ticket.category, "otro");
  });
});
