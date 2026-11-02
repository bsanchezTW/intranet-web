const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { pageSkeletonFor } = require("../src/utils/pageSkeleton");

describe("pageSkeletonFor", () => {
  it("usa el esqueleto de inicio sólo en la portada", () => {
    assert.equal(pageSkeletonFor("/"), "inicio");
  });

  it("reconoce los listados sin importar mayúsculas ni barra final", () => {
    assert.equal(pageSkeletonFor("/RRHH/personal"), "tabla");
    assert.equal(pageSkeletonFor("/rrhh/personal/"), "tabla");
    assert.equal(pageSkeletonFor("/procesos/protocolos/12"), "tabla");
  });

  it("reconoce las páginas de tarjetas", () => {
    assert.equal(pageSkeletonFor("/noticias"), "tarjetas");
    assert.equal(pageSkeletonFor("/marketing/eventos"), "tarjetas");
    assert.equal(pageSkeletonFor("/procesos/protocolos"), "tarjetas");
  });

  it("no confunde un detalle con su listado", () => {
    assert.equal(pageSkeletonFor("/noticias/una-noticia"), "contenido");
    assert.equal(pageSkeletonFor("/marketing/eventos/aniversario"), "contenido");
    assert.equal(pageSkeletonFor("/gastos/42"), "contenido");
    assert.equal(pageSkeletonFor("/cursos/reproductor/7"), "contenido");
  });

  it("cae en contenido si la ruta no se conoce", () => {
    assert.equal(pageSkeletonFor("/perfil"), "contenido");
  });
});
