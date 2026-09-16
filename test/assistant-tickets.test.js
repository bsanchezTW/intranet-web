const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const tickets = require("../src/services/assistant/assistantTickets");
const {
  appendExchange,
  appendToLastAssistantMessage,
  getHistory,
} = require("../src/services/assistant/assistantConversation");

const ticketInput = {
  title: "No imprime",
  description: "La impresora del segundo piso no responde desde la mañana.",
  category: "impresoras",
  priority: "high",
};

describe("assistantTickets — borrador en la sesión", () => {
  it("guarda un borrador válido", () => {
    const session = {};
    const saved = tickets.saveTicketDraft(session, ticketInput);

    assert.equal(saved.ok, true);
    assert.equal(saved.draft.priority, "high");
    assert.equal(tickets.getTicketDraft(session, saved.draft.id), saved.draft);
  });

  it("un borrador inválido no se guarda", () => {
    const session = {};
    assert.equal(tickets.saveTicketDraft(session, { ...ticketInput, title: "" }).ok, false);
    assert.equal(session.assistantTicketDraft, undefined);
  });

  it("rehacer el borrador reemplaza al anterior", () => {
    const session = {};
    const first = tickets.saveTicketDraft(session, ticketInput).draft;
    const second = tickets.saveTicketDraft(session, { ...ticketInput, priority: "low" }).draft;

    assert.equal(tickets.getTicketDraft(session, first.id), null);
    assert.equal(tickets.getTicketDraft(session, second.id).priority, "low");
  });

  it("el borrador sólo se encuentra con su id y en la sesión que lo armó", () => {
    const mine = {};
    const other = {};
    const { draft } = tickets.saveTicketDraft(mine, ticketInput);

    assert.equal(tickets.getTicketDraft(mine, "otro-id"), null);
    assert.equal(tickets.getTicketDraft(other, draft.id), null);
    tickets.clearTicketDraft(mine);
    assert.equal(tickets.getTicketDraft(mine, draft.id), null);
  });

  it("la tarjeta trae etiquetas legibles", () => {
    const { draft } = tickets.saveTicketDraft({}, ticketInput);
    const card = tickets.publicDraft(draft);
    assert.equal(card.categoryLabel, "Impresoras");
    assert.equal(card.priorityLabel, "Alta");
  });
});

describe("assistantTickets — adjuntos declarados y sesión del navegador", () => {
  it("de los adjuntos sólo pasan nombre y tipo, acotados", () => {
    const list = tickets.sanitizeChatAttachments([
      { nombre: " captura.png ", tipo: "image", url: "no debería pasar" },
      { nombre: "", tipo: "pdf" },
      { nombre: "log.txt", tipo: "exe" },
      ...Array.from({ length: 10 }, (_, i) => ({ nombre: `f${i}.png`, tipo: "image" })),
    ]);
    assert.equal(list.length, tickets.MAX_CHAT_ATTACHMENTS);
    assert.deepEqual(list[0], { nombre: "captura.png", tipo: "image" });
    assert.equal(list[1].tipo, "doc");
    assert.deepEqual(tickets.sanitizeChatAttachments("nada"), []);
  });

  it("la sesión del navegador es estable dentro de una sesión y distinta entre sesiones", () => {
    const session = {};
    const key = tickets.assistantSessionId(session);
    assert.equal(tickets.assistantSessionId(session), key);
    assert.notEqual(tickets.assistantSessionId({}), key);
  });
});

describe("assistantConversation — nota del ticket creado", () => {
  it("se agrega a la última respuesta sin romper la alternancia", () => {
    const session = {};
    appendExchange(session, "créalo por mí", "Revisa el borrador.");
    appendToLastAssistantMessage(session, "Ticket #12 creado.");

    const history = getHistory(session);
    assert.equal(history.length, 2);
    assert.equal(history[1].content, "Revisa el borrador.\n\nTicket #12 creado.");
  });

  it("sin una respuesta previa no agrega nada", () => {
    const session = {};
    appendToLastAssistantMessage(session, "Ticket #12 creado.");
    assert.deepEqual(getHistory(session), []);
  });
});
