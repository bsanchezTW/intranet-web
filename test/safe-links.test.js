const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const ejs = require("ejs");

process.env.COUNTRY = process.env.COUNTRY || "CL";

/*
  Enlaces que vienen del navegador y terminan en un href o en un registro:
  adjuntos de respuestas de tickets, enlaces de apps y documentos de Procesos.
*/

const SRC = path.join(__dirname, "..", "src");
const { isSafeLinkUrl, optionalLinkUrl } = require(path.join(SRC, "utils/safeUrl"));
const { sanitizeReplyAttachments } = require(path.join(SRC, "services/tickets/ticketRules"));
const { uploadedDocumentPath } = require(path.join(SRC, "services/documents/processDocumentStorage"));

describe("safeUrl", () => {
  it("acepta http(s) y rutas internas", () => {
    for (const url of ["https://apps.apple.com/x", "http://intranet/x", "/content/apps_icons/a.png", "/soporte?ticket=1"]) {
      assert.equal(isSafeLinkUrl(url), true, url);
    }
  });

  it("rechaza esquemas que ejecutan código y rutas de otro host", () => {
    for (const url of [
      "javascript:alert(1)",
      " JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:x",
      "//evil.com/x",
      "/\\evil.com",
      "https://",
      "java\nscript:alert(1)",
      "",
      null,
    ]) {
      assert.equal(isSafeLinkUrl(url), false, String(url));
    }
  });

  it("optionalLinkUrl: vacío es null; inválido es un 400 con el campo", () => {
    assert.equal(optionalLinkUrl("  "), null);
    assert.equal(optionalLinkUrl(" https://x.cl "), "https://x.cl");
    assert.throws(
      () => optionalLinkUrl("javascript:alert(1)", "El enlace web"),
      (err) => err.statusCode === 400 && /El enlace web debe empezar con http/.test(err.message),
    );
  });
});

describe("adjuntos de una respuesta de ticket", () => {
  const archivo = (url, extra = {}) => ({ url, nombre: "captura.png", tipo: "image", ...extra });

  it("guarda los archivos del ticket con la URL armada en el servidor", () => {
    const limpio = sanitizeReplyAttachments(
      JSON.stringify([archivo("/content/tickets_adjuntos/42_3_1.png")]),
      42,
    );
    assert.deepEqual(limpio, [{ url: "/content/tickets_adjuntos/42_3_1.png", nombre: "captura.png", tipo: "image" }]);
  });

  it("descarta javascript:, data: y URLs que no son de Storage", () => {
    const limpio = sanitizeReplyAttachments(
      [
        archivo("javascript:fetch('/permisos/superadmin')"),
        archivo("data:text/html,<script>alert(1)</script>"),
        archivo("https://evil.com/robo.png"),
      ],
      42,
    );
    assert.deepEqual(limpio, []);
  });

  it("no deja enlazar el archivo de otro ticket ni salir de la carpeta", () => {
    const limpio = sanitizeReplyAttachments(
      [
        archivo("/content/tickets_adjuntos/7_1_1.pdf"),
        archivo("/content/tickets_adjuntos/420_1_1.pdf"),
        archivo("/content/gastos/2026/5/comprobante.pdf"),
        archivo("/content/tickets_adjuntos/42_1_1/../../gastos/x.pdf"),
      ],
      42,
    );
    assert.deepEqual(limpio, []);
  });

  it("aunque la URL traiga otro host, guarda la ruta interna", () => {
    const [adjunto] = sanitizeReplyAttachments(
      [archivo("https://evil.com/content/tickets_adjuntos/42_1_1.png")],
      42,
    );
    assert.equal(adjunto.url, "/content/tickets_adjuntos/42_1_1.png");
  });

  it("normaliza nombre y tipo, quita repetidos y respeta el máximo", () => {
    const muchos = Array.from({ length: 15 }, (_, i) => archivo(`/content/tickets_adjuntos/42_1_${i}.png`));
    assert.equal(sanitizeReplyAttachments(muchos, 42).length, 10);

    const [a, ...resto] = sanitizeReplyAttachments(
      [
        { url: "/content/tickets_adjuntos/42_1_1.docx", nombre: "x".repeat(400), tipo: "<script>" },
        { url: "/content/tickets_adjuntos/42_1_1.docx" },
      ],
      42,
    );
    assert.equal(a.nombre.length, 255);
    assert.equal(a.tipo, "doc");
    assert.deepEqual(resto, [], "el repetido no se guarda dos veces");
  });

  it("JSON roto, no-lista o ticket inválido no guardan nada", () => {
    assert.deepEqual(sanitizeReplyAttachments("{no es json", 42), []);
    assert.deepEqual(sanitizeReplyAttachments('{"url":"/content/tickets_adjuntos/42_1.png"}', 42), []);
    assert.deepEqual(sanitizeReplyAttachments(undefined, 42), []);
    assert.deepEqual(sanitizeReplyAttachments([archivo("/content/tickets_adjuntos/42_1.png")], "42abc"), []);
  });
});

describe("vista del ticket con adjuntos guardados antes del arreglo", () => {
  it("no pinta un href javascript: aunque la fila lo tenga", async () => {
    const malicioso = JSON.stringify([
      { url: "javascript:alert(document.domain)", nombre: "factura.pdf", tipo: "doc" },
      { url: "/content/tickets_adjuntos/9_1_1.pdf", nombre: "bueno.pdf", tipo: "doc" },
    ]);
    const html = await ejs.renderFile(path.join(SRC, "views/sistemas/tickets_detalle.ejs"), {
      countryConfig: require(path.join(SRC, "config/country")).getCountryConfig(),
      ticketCategoryLabel: (c) => c,
      ticket: {
        id: 9,
        title: "Impresora",
        description: "No imprime",
        category: "hardware",
        priority: "medium",
        status: "open",
        requester_name: "Ana",
        requester_email: "ana@transworld.cl",
        attachments: malicioso,
        created_at: new Date(),
      },
      respuestas: [
        { id: 1, mensaje: "mira", remitente: "Ana", fecha: new Date(), attachments: malicioso },
      ],
      user: { id: 5, email: "ana@transworld.cl" },
      canManageTickets: false,
      supportAgents: [],
      backTo: "/soporte",
      isModal: true,
    });
    assert.doesNotMatch(html, /javascript:/i);
    assert.match(html, /href="\/content\/tickets_adjuntos\/9_1_1\.pdf"/);
  });
});

describe("documento de Procesos", () => {
  it("acepta un archivo directo de la carpeta de la sección y el área", () => {
    assert.equal(
      uploadedDocumentPath("procedimientos", "7", "documentos/procedimientos/7/1730000000000-abc.pdf"),
      "documentos/procedimientos/7/1730000000000-abc.pdf",
    );
    assert.equal(
      uploadedDocumentPath("otros", "general", "/content/documentos/otros/general/a%20b.pdf"),
      "documentos/otros/general/a b.pdf",
    );
  });

  it("rechaza el archivo de otra área, otra sección o fuera de documentos", () => {
    for (const ajeno of [
      "documentos/procedimientos/8/secreto.pdf",
      "documentos/protocolos/7/x.pdf",
      "documentos/procedimientos/7/sub/x.pdf",
      "documentos/procedimientos/7/../8/secreto.pdf",
      "gastos/2026/5/comprobante.pdf",
      "documentos/procedimientos/7",
      "",
    ]) {
      assert.equal(uploadedDocumentPath("procedimientos", "7", ajeno), null, ajeno);
    }
  });
});
