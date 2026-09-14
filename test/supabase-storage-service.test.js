const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const {
  createSupabaseStorageService,
  StorageNotFoundError,
  StorageValidationError,
} = require("../src/services/supabaseStorageService");

function createHarness(overrides = {}, configOverrides = {}, serviceOptions = {}) {
  const calls = { from: [], upload: [], download: [], info: [], list: [], remove: [] };
  const bucket = {
    async upload(...args) {
      calls.upload.push(args);
      return { data: { id: "object-1", path: args[0], fullPath: `intranet-content/${args[0]}` }, error: null };
    },
    async download(...args) {
      calls.download.push(args);
      return { data: new Blob(["archivo"], { type: "text/plain" }), error: null };
    },
    async info(...args) {
      calls.info.push(args);
      return {
        data: {
          id: "object-1",
          size: 7,
          contentType: "text/plain",
          createdAt: "2026-08-10T12:00:00Z",
          lastModified: "2026-08-11T12:00:00Z",
          etag: "etag-1",
        },
        error: null,
      };
    },
    async list(...args) {
      calls.list.push(args);
      return { data: [], error: null };
    },
    async remove(...args) {
      calls.remove.push(args);
      return {
        data: args[0].map((name) => ({ id: name, name })),
        error: null,
      };
    },
    ...overrides,
  };
  const client = {
    storage: {
      from(name) {
        calls.from.push(name);
        return bucket;
      },
    },
  };
  const config = {
    url: "https://proyectochile.supabase.co",
    key: "sb_secret_test",
    bucket: "intranet-content",
    maxFileSizeBytes: 250,
    tusThresholdBytes: 100,
    tusChunkSizeBytes: 6,
    listPageSize: 2,
    deleteBatchSize: 2,
    ...configOverrides,
  };
  const service = createSupabaseStorageService({
    client,
    config,
    ...serviceOptions,
  });
  return { service, calls, bucket };
}

describe("supabaseStorageService", () => {
  it("mueve un objeto normalizando ambas rutas", async () => {
    const moves = [];
    const { service } = createHarness({
      async move(...args) {
        moves.push(args);
        return { data: { message: "Successfully moved" }, error: null };
      },
    });
    const result = await service.moveFile(
      "/content/gastos/2026/5/boleta-1789-ab12.pdf",
      "gastos/2026/5/765876_1.pdf",
    );
    assert.deepEqual(moves, [["gastos/2026/5/boleta-1789-ab12.pdf", "gastos/2026/5/765876_1.pdf"]]);
    assert.equal(result.relativePath, "gastos/2026/5/765876_1.pdf");
  });

  it("propaga el error cuando el bucket no puede mover", async () => {
    const { service } = createHarness({
      async move() {
        return { data: null, error: { message: "The resource already exists", statusCode: "409" } };
      },
    });
    await assert.rejects(service.moveFile("gastos/2026/5/a.pdf", "gastos/2026/5/765876_1.pdf"));
  });

  it("sube buffers pequeños con MIME inferido y upsert por defecto", async () => {
    const { service, calls } = createHarness();
    const result = await service.uploadFile(
      Buffer.from([0xff, 0xd8, 0xff, 0x00]),
      "/content/noticias/foto.jpg",
    );

    assert.equal(calls.from[0], "intranet-content");
    assert.equal(calls.upload.length, 1);
    assert.equal(calls.upload[0][0], "noticias/foto.jpg");
    assert.deepEqual(calls.upload[0][2], {
      contentType: "image/jpeg",
      upsert: true,
      cacheControl: "3600",
    });
    assert.equal(result.relativePath, "noticias/foto.jpg");
    assert.equal(result.storageId, "object-1");
    assert.equal(result.size, 4);
  });

  it("convierte no-cache al formato de segundos exigido por Storage", async () => {
    const { service, calls } = createHarness();
    await service.uploadFile(Buffer.from("foto"), "user/1.jpg", {
      contentType: "image/jpeg",
      cacheControl: "no-cache",
    });
    assert.equal(calls.upload[0][2].cacheControl, "0");
  });

  it("rechaza localmente archivos que superan 250 MB configurados", async () => {
    const { service, calls } = createHarness({}, { maxFileSizeBytes: 3 });
    await assert.rejects(
      service.uploadFile(Buffer.alloc(4), "videos/grande.mp4"),
      (error) =>
        error instanceof StorageValidationError &&
        error.code === "STORAGE_FILE_TOO_LARGE" &&
        error.statusCode === 413,
    );
    assert.equal(calls.upload.length, 0);
  });

  it("usa TUS y fragmentos para archivos mayores al umbral", async () => {
    const requests = [];
    const progress = [];
    const fakeFetch = async (url, options) => {
      requests.push({ url, options });
      if (options.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { Location: "/storage/v1/upload/resumable/upload-1" },
        });
      }
      if (options.method === "PATCH") {
        const offset = Number(options.headers["Upload-Offset"]);
        return new Response(null, {
          status: 204,
          headers: { "Upload-Offset": String(offset + options.body.length) },
        });
      }
      throw new Error(`Método inesperado: ${options.method}`);
    };
    const { service, calls } = createHarness(
      {},
      { maxFileSizeBytes: 20, tusThresholdBytes: 4, tusChunkSizeBytes: 4 },
      { fetchImpl: fakeFetch },
    );

    const result = await service.uploadFile(Buffer.alloc(10, 1), "videos/demo.mp4", {
      onProgress: (sent, total) => progress.push([sent, total]),
    });

    assert.equal(calls.upload.length, 0);
    assert.equal(requests.filter((request) => request.options.method === "PATCH").length, 3);
    assert.match(requests[0].options.headers["Upload-Metadata"], /bucketName/);
    assert.equal(requests[0].options.headers.Authorization, undefined);
    assert.deepEqual(progress, [[4, 10], [8, 10], [10, 10]]);
    assert.equal(result.resumable, true);
  });

  it("reintenta el HEAD de reconciliación TUS cuando falla transitoriamente", async () => {
    let patchCalls = 0;
    let headCalls = 0;
    const fakeFetch = async (_url, options) => {
      if (options.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { Location: "/storage/v1/upload/resumable/upload-2" },
        });
      }
      if (options.method === "PATCH") {
        patchCalls += 1;
        if (patchCalls === 1) throw new TypeError("conexión interrumpida");
        return new Response(null, {
          status: 204,
          headers: { "Upload-Offset": String(options.body.length) },
        });
      }
      if (options.method === "HEAD") {
        headCalls += 1;
        if (headCalls === 1) return new Response(null, { status: 503 });
        return new Response(null, {
          status: 200,
          headers: { "Upload-Offset": "0" },
        });
      }
      throw new Error(`Método inesperado: ${options.method}`);
    };
    const { service } = createHarness(
      {},
      { maxFileSizeBytes: 20, tusThresholdBytes: 4, tusChunkSizeBytes: 6 },
      { fetchImpl: fakeFetch, sleep: async () => {} },
    );

    const result = await service.uploadFile(Buffer.alloc(6, 1), "videos/demo.mp4", {
      maxRetries: 2,
      retryDelays: [0],
    });

    assert.equal(result.resumable, true);
    assert.equal(headCalls, 2);
    assert.equal(patchCalls, 2);
  });

  it("sube un archivo grande desde disco leyendo solo un chunk por vez", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "storage-test-"));
    const tempFile = path.join(tempDir, "video.upload");
    await fs.writeFile(tempFile, Buffer.alloc(10, 7));
    const chunkSizes = [];
    const fakeFetch = async (_url, options) => {
      if (options.method === "POST") {
        return new Response(null, {
          status: 201,
          headers: { Location: "/storage/v1/upload/resumable/upload-file" },
        });
      }
      if (options.method === "PATCH") {
        const offset = Number(options.headers["Upload-Offset"]);
        chunkSizes.push(options.body.length);
        return new Response(null, {
          status: 204,
          headers: { "Upload-Offset": String(offset + options.body.length) },
        });
      }
      throw new Error(`Método inesperado: ${options.method}`);
    };
    const { service } = createHarness(
      {},
      { maxFileSizeBytes: 20, tusThresholdBytes: 4, tusChunkSizeBytes: 4 },
      { fetchImpl: fakeFetch },
    );

    try {
      const result = await service.uploadFileFromPath(
        tempFile,
        "videos/demo.mp4",
        { contentType: "video/mp4" },
      );
      assert.equal(result.size, 10);
      assert.equal(result.resumable, true);
      assert.deepEqual(chunkSizes, [4, 4, 2]);
    } finally {
      await fs.rm(tempDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 20,
      });
    }
  });

  it("descarga Buffer y conserva el Content-Type", async () => {
    const { service } = createHarness();
    const result = await service.downloadFile("docs/readme.txt");
    assert.equal(result.buffer.toString(), "archivo");
    assert.equal(result.contentType, "text/plain");
    assert.equal(result.size, 7);
  });

  it("convierte errores 404 del SDK en StorageNotFoundError", async () => {
    const { service } = createHarness({
      async download() {
        return {
          data: null,
          error: { message: "Object not found", statusCode: 404 },
        };
      },
    });
    await assert.rejects(
      service.downloadFile("docs/missing.pdf"),
      (error) =>
        error instanceof StorageNotFoundError && error.statusCode === 404,
    );
  });

  it("usa el status HTTP cuando statusCode es simbólico", async () => {
    const { service } = createHarness({
      async download() {
        return {
          data: null,
          error: {
            message: "Object not found",
            statusCode: "NoSuchKey",
            status: 404,
          },
        };
      },
    });
    await assert.rejects(
      service.downloadFile("docs/missing.pdf"),
      (error) =>
        error instanceof StorageNotFoundError && error.statusCode === 404,
    );
  });

  it("mapea stat sin descargar bytes", async () => {
    const { service, calls } = createHarness();
    const stat = await service.statFile("docs/readme.txt");
    assert.equal(stat.size, 7);
    assert.equal(stat.contentType, "text/plain");
    assert.equal(stat.etag, "etag-1");
    assert.equal(stat.lastModified.toISOString(), "2026-08-11T12:00:00.000Z");
    assert.equal(calls.download.length, 0);
  });

  it("pagina listados y recorre subcarpetas", async () => {
    const pages = {
      docs: [
        { name: "sub", id: null, metadata: null },
        {
          name: "a.pdf",
          id: "a",
          created_at: "2026-08-10T00:00:00Z",
          metadata: { size: 10, mimetype: "application/pdf" },
        },
        {
          name: "b.pdf",
          id: "b",
          created_at: "2026-08-11T00:00:00Z",
          metadata: { size: 20, mimetype: "application/pdf" },
        },
      ],
      "docs/sub": [
        {
          name: "c.txt",
          id: "c",
          created_at: "2026-08-09T00:00:00Z",
          metadata: { size: 3, mimetype: "text/plain" },
        },
      ],
    };
    const { service, calls } = createHarness({
      async list(folder, options) {
        calls.list.push([folder, options]);
        return {
          data: (pages[folder] || []).slice(options.offset, options.offset + options.limit),
          error: null,
        };
      },
    });

    const direct = await service.listFilesInFolder("docs");
    assert.deepEqual(direct.map((file) => file.name), ["b.pdf", "a.pdf"]);
    const recursive = await service.listFilesRecursive("docs");
    assert.deepEqual(
      recursive.map((file) => file.relativePath).sort(),
      ["docs/a.pdf", "docs/b.pdf", "docs/sub/c.txt"],
    );
    assert.ok(calls.list.some(([, options]) => options.offset === 2));
  });

  it("detiene la paginación directa al satisfacer limit", async () => {
    const files = Array.from({ length: 8 }, (_, index) => ({
      name: `${index}.txt`,
      id: String(index),
      metadata: { size: 1 },
    }));
    const { service, calls } = createHarness(
      {
        async list(folder, options) {
          calls.list.push([folder, options]);
          return {
            data: files.slice(options.offset, options.offset + options.limit),
            error: null,
          };
        },
      },
      { listPageSize: 2 },
    );

    const listed = await service.listFilesInFolder("docs", { limit: 1 });
    assert.equal(listed.length, 1);
    assert.equal(calls.list.length, 1);
  });

  it("elimina carpetas en lotes acotados", async () => {
    const files = Array.from({ length: 5 }, (_, index) => ({
      name: `${index}.txt`,
      id: String(index),
      metadata: { size: 1 },
    }));
    const { service, calls } = createHarness(
      {
        async list(folder, options) {
          calls.list.push([folder, options]);
          return {
            data: files.slice(options.offset, options.offset + options.limit),
            error: null,
          };
        },
      },
      { listPageSize: 10, deleteBatchSize: 2 },
    );

    assert.equal(await service.deleteFolder("temporal"), true);
    assert.deepEqual(calls.remove.map(([paths]) => paths.length), [2, 2, 1]);
  });

  it("entrega un Node Readable y propaga Range", async () => {
    let receivedHeaders;
    const fakeFetch = async (_url, options) => {
      receivedHeaders = options.headers;
      return new Response("2345", {
        status: 206,
        headers: {
          "content-type": "video/mp4",
          "content-length": "4",
          "content-range": "bytes 2-5/10",
          etag: "stream-etag",
        },
      });
    };
    const { service } = createHarness({}, {}, { fetchImpl: fakeFetch });
    const result = await service.downloadStream("videos/demo.mp4", {
      range: { start: 2, end: 5 },
    });
    const chunks = [];
    for await (const chunk of result.stream) chunks.push(chunk);

    assert.equal(Buffer.concat(chunks).toString(), "2345");
    assert.equal(receivedHeaders.Range, "bytes=2-5");
    assert.equal(result.statusCode, 206);
    assert.equal(result.contentRange, "bytes 2-5/10");
  });
});
