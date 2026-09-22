const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

process.env.COUNTRY = process.env.COUNTRY || "CL";

const {
  wrapTransactionalHtml,
  absoluteUrl,
  textToHtml,
  secretBox,
  renderEmailLayout,
} = require("../src/services/emailLayout");
const { ticketMailHtml } = require("../src/services/tickets/ticketService");
const { MAIL_SENDERS } = require("../src/constants/mailSenders");

describe("plantilla transaccional de correo", () => {
  it("envuelve el cuerpo con cabecera de área, titular y CTA", () => {
    const html = wrapTransactionalHtml({
      html: "<p>Hola</p>",
      senderName: MAIL_SENDERS.support,
      heading: "Nuevo ticket",
      cta: { href: "/soporte?ticket=12", label: "Ver ticket" },
      preheader: "Hay un ticket nuevo",
    });
    assert.match(html, /Soporte/);
    assert.match(html, /Nuevo ticket/);
    assert.match(html, /Ver ticket/);
    assert.match(html, /soporte\?ticket=12/);
    assert.match(html, /No respondas a este correo/);
    assert.doesNotMatch(html, /<!DOCTYPE html>/i);
  });

  it("si solo hay texto, arma HTML y no deja el mensaje plano", () => {
    const html = wrapTransactionalHtml({
      text: "Hola\nContraseña: abc",
      senderName: MAIL_SENDERS.intranet,
      heading: "Recuperación de contraseña",
    });
    assert.match(html, /Contraseña: abc/);
    assert.match(html, /<br>/);
    assert.match(html, />Intranet</);
  });

  it("noticias puede saltarse el marco para usar su propia plantilla", () => {
    const raw = "<div id='newsletter'>noticia</div>";
    assert.equal(
      wrapTransactionalHtml({ html: raw, skipLayout: true }),
      raw,
    );
  });

  it("resuelve rutas internas contra APP_BASE_URL", () => {
    assert.equal(
      absoluteUrl("/login"),
      `${String(process.env.APP_BASE_URL || "http://localhost:3000").replace(/\/+$/, "")}/login`,
    );
    assert.equal(absoluteUrl("https://intranet.example/x"), "https://intranet.example/x");
  });

  it("escapa el texto plano al pasarlo a HTML", () => {
    assert.match(textToHtml("<script>"), /&lt;script&gt;/);
  });

  it("la clave temporal va en un recuadro gris y escapada", () => {
    const html = secretBox("a<b>", { label: "Contraseña temporal" });
    assert.match(html, /background-color:#eef2f7/);
    assert.match(html, /Contraseña temporal/);
    assert.match(html, /a&lt;b&gt;/);
  });

  it("el mensaje de un ticket no puede inyectar HTML ni enlaces", () => {
    const html = ticketMailHtml(
      'Hola <a href="https://evil.example">clic</a>',
      JSON.stringify([{ tipo: "image", nombre: "<img>", url: "javascript:alert(1)" }]),
    );
    assert.ok(!html.includes('<a href="https://evil'));
    assert.ok(html.includes("&lt;a href=&quot;https://evil"));
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /&lt;img&gt;/);
  });

  it("noticias usa el mismo marco con portada, fecha y subtítulo", () => {
    const html = renderEmailLayout({
      area: MAIL_SENDERS.news,
      heading: "Aniversario",
      eyebrow: "16 de septiembre de 2026",
      subheading: "Celebramos 20 años",
      cover: { src: "data:image/jpeg;base64,AAAA", href: "/noticias/1" },
      bodyHtml: "<p>cuerpo</p>",
      cta: { href: "/noticias/1", label: "Leer en la Intranet →" },
    });
    assert.match(html, />Noticias</);
    assert.ok(html.includes("data:image/jpeg;base64,AAAA"));
    assert.match(html, /16 de septiembre de 2026/);
    assert.match(html, /Celebramos 20 años/);
    assert.match(html, /No respondas a este correo/);
  });
});
