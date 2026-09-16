const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const tickets = require("../src/services/assistant/assistantTickets");
const {
  appendExchange,
  appendToLastAssistantMessage,
  getHistory,
} = require("../src/services/assistant/assistantConversation");

const file = (nombre) => ({ url: `https://bucket.test/${nombre}`, nombre, tipo: "image" });
const ticketInput = {
  title: "No imprime",
  description: "La impresora del segundo piso no responde desde la mañana.",
  category: "impresoras",
  priority: "high",
};

describe("assistantTickets — adjuntos y borrador en la sesión", () => {
  it("el borrador se lleva los adjuntos pendientes", () => {
    const session = {};
    tickets.addPendingAttachment(session, file("captura.png"));
    const saved = tickets.saveTicketDraft(session, ticketInput);

    assert.equal(saved.ok, true);
    assert.equal(saved.draft.attachments.length, 1);
    assert.equal(saved.draft.priority, "high");
    assert.deepEqual(tickets.getPendingAttachments(session), []);
  });

  it(`no acepta más de ${tickets.MAX_PENDING_ATTACHMENTS} adjuntos pendientes`, () => {
    const session = {};
    for (let i = 0; i < tickets.MAX_PENDING_ATTACHMENTS; i += 1) {
      assert.equal(tickets.addPendingAttachment(session, file(`f${i}.png`)).ok, true);
    }
    assert.equal(tickets.addPendingAttachment(session, file("extra.png")).ok, false);
  });

  it("un borrador inválido no se guarda ni toca los adjuntos", () => {
    const session = {};
    tickets.addPendingAttachment(session, file("captura.png"));
    const saved = tickets.saveTicketDraft(session, { ...ticketInput, title: "" });

    assert.equal(saved.ok, false);
    assert.equal(tickets.getPendingAttachments(session).length, 1);
  });

  it("rehacer el borrador conserva los adjuntos del anterior", () => {
    const session = {};
    tickets.addPendingAttachment(session, file("uno.png"));
    tickets.saveTicketDraft(session, ticketInput);
    tickets.addPendingAttachment(session, file("dos.png"));
    const again = tickets.saveTicketDraft(session, { ...ticketInput, priority: "low" });

    assert.deepEqual(again.draft.attachments.map((a) => a.nombre), ["uno.png", "dos.png"]);
  });

  it("el borrador sólo se encuentra con su id y en la sesión que lo armó", () => {
    const mine = {};
    const other = {};
    const { draft } = tickets.saveTicketDraft(mine, ticketInput);

    assert.equal(tickets.getTicketDraft(mine, draft.id), draft);
    assert.equal(tickets.getTicketDraft(mine, "otro-id"), null);
    assert.equal(tickets.getTicketDraft(other, draft.id), null);
  });

  it("descartar devuelve los adjuntos a pendientes", () => {
    const session = {};
    tickets.addPendingAttachment(session, file("captura.png"));
    const { draft } = tickets.saveTicketDraft(session, ticketInput);

    assert.equal(tickets.discardTicketDraft(session, draft.id), true);
    assert.equal(tickets.getTicketDraft(session, draft.id), null);
    assert.equal(tickets.getPendingAttachments(session)[0].nombre, "captura.png");
  });

  it("lo que ve el cliente no incluye la URL del bucket", () => {
    const session = {};
    const { attachment } = tickets.addPendingAttachment(session, file("captura.png"));
    const { draft } = tickets.saveTicketDraft(session, ticketInput);

    assert.equal("url" in tickets.publicAttachment(attachment), false);
    const card = tickets.publicDraft(draft);
    assert.equal(card.categoryLabel, "Impresoras");
    assert.equal(card.priorityLabel, "Alta");
    assert.deepEqual(card.attachments, [{ nombre: "captura.png", tipo: "image" }]);
  });

  it("empezar de nuevo limpia borrador y adjuntos", () => {
    const session = {};
    tickets.addPendingAttachment(session, file("captura.png"));
    const { draft } = tickets.saveTicketDraft(session, ticketInput);
    tickets.addPendingAttachment(session, file("otra.png"));
    tickets.clearTicketState(session);

    assert.equal(tickets.getTicketDraft(session, draft.id), null);
    assert.deepEqual(tickets.getPendingAttachments(session), []);
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
