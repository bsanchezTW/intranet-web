const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { Readable, PassThrough } = require("node:stream");

const {
  isActiveContentType,
  isInlineSafeContentType,
  contentDispositionFor,
  parseByteRange,
  pipeStoredStream,
} = require("../src/services/storage/storageHttp");

describe("rango HTTP de una foto cacheada", () => {
  it("ignora un pedido sin rango y recorta el final al tamaño real", () => {
    assert.equal(parseByteRange(undefined, 100), null);
    assert.deepEqual(parseByteRange("bytes=0-", 100), { start: 0, end: 99 });
    assert.deepEqual(parseByteRange("bytes=10-19", 100), { start: 10, end: 19 });
    assert.deepEqual(parseByteRange("bytes=-20", 100), { start: 80, end: 99 });
  });

  it("marca como inválido un rango que empieza fuera del archivo", () => {
    assert.deepEqual(parseByteRange("bytes=100-", 100), { unsatisfiable: true });
    assert.deepEqual(parseByteRange("bytes=5-4", 100), { unsatisfiable: true });
    assert.equal(parseByteRange("", 100), null);
  });
});

describe("storage HTTP hardening", () => {
  it("marca HTML, SVG y XML como contenido activo", () => {
    assert.equal(isActiveContentType("text/html; charset=utf-8"), true);
    assert.equal(isActiveContentType("image/svg+xml"), true);
    assert.equal(isActiveContentType("application/xml"), true);
    assert.equal(isActiveContentType("text/javascript"), true);
    assert.equal(isActiveContentType("image/png"), false);
    assert.equal(isActiveContentType("application/pdf"), false);
  });

  it("neutraliza todo tipo XML, aunque no esté en ninguna lista conocida", () => {
    // El navegador abre cualquier *+xml como documento XML y ejecuta un
    // <script> XHTML: con la lista negra anterior estos pasaban inline.
    for (const tipo of [
      "application/mathml+xml",
      "application/rdf+xml",
      "application/vnd.foo+xml; charset=utf-8",
      "text/xsl",
      "application/xslt+xml",
      "multipart/x-mixed-replace",
    ]) {
      assert.equal(isActiveContentType(tipo), true, tipo);
    }
  });

  it("trata un tipo vacío, desconocido o mal escrito como activo", () => {
    assert.equal(isActiveContentType(""), true);
    assert.equal(isActiveContentType(undefined), true);
    assert.equal(isActiveContentType("application/octet-stream"), true);
    assert.equal(isActiveContentType("application/x-unknown"), true);
    assert.equal(isActiveContentType("text/html "), true);
  });

  it("sirve inline sólo imágenes rasterizadas, audio, video, PDF y texto plano", () => {
    for (const tipo of [
      "image/jpeg",
      "IMAGE/PNG",
      "image/webp",
      "video/mp4",
      "video/quicktime",
      "audio/mpeg",
      "application/pdf",
      "text/plain; charset=utf-8",
    ]) {
      assert.equal(isInlineSafeContentType(tipo), true, tipo);
      assert.equal(isActiveContentType(tipo), false, tipo);
    }
  });

  it("genera Content-Disposition seguro y codificado", () => {
    const header = contentDispositionFor({
      relativePath: "tickets_adjuntos/informe Perú #1.html",
    });
    assert.match(header, /^attachment;/);
    assert.match(header, /filename="informe Per_ #1\.html"/);
    assert.match(header, /filename\*=UTF-8''informe%20Per%C3%BA%20%231\.html/);
    assert.doesNotMatch(header, /[\r\n]/);
  });

  it("entrega el archivo si el cliente sigue conectado", async () => {
    const dest = new PassThrough();
    const chunks = [];
    dest.on("data", (chunk) => chunks.push(chunk));
    await pipeStoredStream(Readable.from(["hola"]), dest);
    assert.equal(Buffer.concat(chunks).toString(), "hola");
  });

  it("no tumba el proceso si la respuesta ya está cerrada y el body emite terminated", async () => {
    const dest = new PassThrough();
    dest.destroy();
    const source = new Readable({ read() {} });
    const failures = [];
    const onUncaught = (err) => failures.push(err);
    process.on("uncaughtException", onUncaught);
    try {
      await pipeStoredStream(source, dest);
      const err = new TypeError("terminated");
      err.cause = Object.assign(new Error("NGHTTP2_PROTOCOL_ERROR"), {
        code: "ERR_HTTP2_STREAM_ERROR",
        http2ErrorCode: 1,
      });
      source.emit("error", err);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(failures, []);
    } finally {
      process.removeListener("uncaughtException", onUncaught);
    }
  });

  it("propaga el corte de storage cuando el cliente sigue esperando", async () => {
    const dest = new PassThrough();
    const source = Readable.from(
      (async function* () {
        yield "parcial";
        const err = new TypeError("terminated");
        err.cause = Object.assign(new Error("NGHTTP2_PROTOCOL_ERROR"), {
          code: "ERR_HTTP2_STREAM_ERROR",
        });
        throw err;
      })(),
    );
    await assert.rejects(pipeStoredStream(source, dest), (err) => {
      return err?.message === "terminated" || err?.cause?.code === "ERR_HTTP2_STREAM_ERROR";
    });
  });
});
