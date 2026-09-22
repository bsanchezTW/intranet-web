const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  SUPPORT_AREA_NAMES,
  normalizeAreaName,
  isSupportAreaName,
} = require("../src/constants/supportArea");
const { safeTicketRedirect } = require("../src/utils/ticketRedirect");

describe("área de soporte", () => {
  it("reconoce el área de Informática escrita de distintas formas", () => {
    // `work_areas.area_name` se escribe a mano: conviven acentos y mayúsculas.
    assert.equal(isSupportAreaName("Informática"), true);
    assert.equal(isSupportAreaName("Informatica"), true);
    assert.equal(isSupportAreaName("INFORMÁTICA"), true);
    assert.equal(isSupportAreaName("  informatica  "), true);
    assert.equal(isSupportAreaName("TI"), true);
    assert.equal(isSupportAreaName("ti"), true);
  });

  it("deja fuera al resto de las áreas", () => {
    assert.equal(isSupportAreaName("Marketing"), false);
    assert.equal(isSupportAreaName("Gerencia"), false);
    assert.equal(isSupportAreaName("Informática y Sistemas"), false);
  });

  it("no confunde vacío ni nulo con el área de soporte", () => {
    assert.equal(isSupportAreaName(""), false);
    assert.equal(isSupportAreaName("   "), false);
    assert.equal(isSupportAreaName(null), false);
    assert.equal(isSupportAreaName(undefined), false);
    assert.equal(isSupportAreaName(0), false);
  });

  it("normaliza a la forma que compara la lista", () => {
    assert.equal(normalizeAreaName("Informática"), "informatica");
    assert.ok(SUPPORT_AREA_NAMES.includes(normalizeAreaName("Informática")));
  });
});

describe("redirección tras gestionar un ticket", () => {
  const { ticketModalUrl } = require("../src/utils/ticketRedirect");
  const MODAL = "/soporte?ticket=8188";

  it("la dirección de un ticket abre el modal de la lista", () => {
    assert.equal(ticketModalUrl(8188), MODAL);
  });

  it("respeta el listado y las rutas operativas de la mesa de ayuda", () => {
    assert.equal(safeTicketRedirect("/soporte", 8188), "/soporte");
    assert.equal(safeTicketRedirect("/soporte?ok=1", 8188), "/soporte?ok=1");
    assert.equal(safeTicketRedirect("/soporte/tickets", 8188), "/soporte/tickets");
    assert.equal(safeTicketRedirect("/soporte/tickets?ok=1", 8188), "/soporte/tickets?ok=1");
    assert.equal(
      safeTicketRedirect("/soporte/tickets/8188/confirmar", 8188),
      "/soporte/tickets/8188/confirmar",
    );
    assert.equal(safeTicketRedirect("/sistemas", 8188), "/sistemas");
    assert.equal(safeTicketRedirect(MODAL, 8188), MODAL);
  });

  it("cae al ticket en el modal cuando el destino no es de la mesa de ayuda", () => {
    assert.equal(safeTicketRedirect("/RRHH", 8188), MODAL);
    assert.equal(safeTicketRedirect("", 8188), MODAL);
    assert.equal(safeTicketRedirect(undefined, 8188), MODAL);
    assert.equal(safeTicketRedirect("/soporte/otra", 8188), MODAL);
    // Prefijo parecido pero otra ruta: /soporte/ticketsfalsos no vale.
    assert.equal(safeTicketRedirect("/soporte/ticketsfalsos", 8188), MODAL);
  });

  it("no permite salir del sitio (open redirect)", () => {
    assert.equal(safeTicketRedirect("//evil.com", 8188), MODAL);
    assert.equal(safeTicketRedirect("/\\evil.com", 8188), MODAL);
    assert.equal(safeTicketRedirect("https://evil.com/soporte/tickets", 8188), MODAL);
    assert.equal(safeTicketRedirect("/soporte/tickets\r\nSet-Cookie: x=1", 8188), MODAL);
  });
});
