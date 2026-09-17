const { describe, it, mock, beforeEach, after, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const names = require("../src/services/noticias/attachmentNames");
const attachmentProcessor = require("../src/services/noticias/attachmentProcessor");
const fileStorage = require("../src/services/fileStorage");

const previousSigningSecret = process.env.MEDIA_SIGNING_SECRET;

describe("nombres de adjuntos de noticias", () => {
  it("usa el numero de la noticia y un correlativo, como tickets", () => {
    assert.equal(names.attachmentFileName(18, 1, "WhatsApp Image.JPEG"), "18_1.jpeg");
    assert.equal(names.attachmentFileName(18, 2, "informe.docx"), "18_2.docx");
    assert.equal(names.attachmentFileName(16, 1, "sin-extension"), "16_1");
    assert.equal(names.coverFileName(14, "portada-noticia.jpg"), "14_portada.jpg");
    assert.equal(names.previewFileName("18_1", 1, 3, "image/jpeg"), "18_1-portada.jpg");
    assert.equal(names.previewFileName("18_1", 2, 3, "image/png"), "18_1-p2.png");
    assert.equal(names.wordImageFileName("18_2", 1, ".png"), "18_2_w1.png");
  });

  it("reconoce nombres ya canonicos y URLs remotas", () => {
    assert.equal(names.canonicalIndex("noticias_adjuntos/18_1.jpeg", 18), 1);
    assert.equal(names.canonicalIndex("18_2.pdf", 18), 2);
    assert.equal(names.canonicalIndex("18_1.jpeg", 16), null);
    assert.equal(names.isCanonicalCoverName("14_portada.jpg", 14), true);
    assert.equal(names.isCanonicalCoverName("portada-noticia-123.jpg", 14), false);
    assert.equal(
      names.isRemoteMediaUrl("https://cdn.example.com/noticias_adjuntos/abc.jpg"),
      true,
    );
    assert.equal(names.isRemoteMediaUrl("/content/noticias_adjuntos/18_1.jpg"), false);
  });
});

describe("plan de adjuntos al guardar", () => {
  it("intercala existentes y archivos nuevos en el orden del editor", () => {
    const files = [{ originalname: "nuevo.pdf" }, { originalname: "foto.jpg" }];
    const slots = attachmentProcessor.parseAttachmentPlan(
      JSON.stringify([
        { public_id: "noticias_adjuntos/18_1.jpeg" },
        { nuevo: true, name: "nuevo.pdf" },
        { nuevo: true, name: "foto.jpg" },
      ]),
      files,
    );

    assert.equal(slots.length, 3);
    assert.equal(slots[0].type, "existing");
    assert.equal(slots[0].publicId, "noticias_adjuntos/18_1.jpeg");
    assert.equal(slots[1].type, "new");
    assert.equal(slots[1].file.originalname, "nuevo.pdf");
    assert.equal(slots[2].file.originalname, "foto.jpg");
  });

  it("rechaza un envio donde faltan o sobran archivos", () => {
    assert.throws(
      () =>
        attachmentProcessor.parseAttachmentPlan(
          [{ nuevo: true, name: "a.pdf" }],
          [],
        ),
      /Faltan archivos/,
    );
    assert.throws(
      () =>
        attachmentProcessor.parseAttachmentPlan(
          [],
          [{ originalname: "a.pdf" }],
        ),
      /no coinciden/,
    );
  });
});

describe("persistNewsMedia — renombra lo que ya esta en el bucket", { concurrency: false }, () => {
  beforeEach(() => {
    process.env.MEDIA_SIGNING_SECRET = "test-secret-news-attachments";
  });

  after(() => {
    if (previousSigningSecret === undefined) {
      delete process.env.MEDIA_SIGNING_SECRET;
    } else {
      process.env.MEDIA_SIGNING_SECRET = previousSigningSecret;
    }
  });

  afterEach(() => {
    mock.restoreAll();
  });

  it("mueve originales locales a noticia_n", async () => {
    const moves = [];
    mock.method(fileStorage, "moveFile", async (from, to) => {
      moves.push([from, to]);
      return {
        secure_url: `/content/${to}`,
        url: `/content/${to}`,
        public_id: to,
      };
    });
    mock.method(fileStorage, "getPublicUrl", (relativePath) => `/content/${relativePath}`);

    const previous = [
      {
        url: "/content/noticias_adjuntos/WhatsApp-Image-1789061096557-7a5ec379.jpeg",
        public_id: "noticias_adjuntos/WhatsApp-Image-1789061096557-7a5ec379.jpeg",
        name: "WhatsApp Image.jpeg",
        kind: "image",
        preview_path: "noticias_adjuntos/WhatsApp-Image-1789061096557-7a5ec379.jpeg",
      },
    ];

    const result = await attachmentProcessor.persistNewsMedia({
      noticiaId: 18,
      previousAttachments: previous,
      previousCover: "/content/noticias_adjuntos/portada-noticia-1789062370285-20612ca8.jpg",
      planRaw: JSON.stringify([
        { public_id: "noticias_adjuntos/WhatsApp-Image-1789061096557-7a5ec379.jpeg" },
      ]),
      files: [],
      coverFile: null,
      keepCoverUrl: "/content/noticias_adjuntos/portada-noticia-1789062370285-20612ca8.jpg",
    });

    assert.deepEqual(moves, [
      [
        "noticias_adjuntos/WhatsApp-Image-1789061096557-7a5ec379.jpeg",
        "noticias_adjuntos/18_1.jpeg",
      ],
      [
        "noticias_adjuntos/portada-noticia-1789062370285-20612ca8.jpg",
        "noticias_adjuntos/18_portada.jpg",
      ],
    ]);
    assert.equal(result.image, "/content/noticias_adjuntos/18_portada.jpg");
    const items = JSON.parse(result.attachments);
    assert.equal(items[0].public_id, "noticias_adjuntos/18_1.jpeg");
    assert.equal(items[0].name, "WhatsApp Image.jpeg");
  });

  it("descarga un archivo remoto y lo guarda con el numero de la noticia", async () => {
    const jpeg = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
    const uploads = [];
    const originalFetch = globalThis.fetch;
    const canvasId = require.resolve("@napi-rs/canvas");
    const previousCanvas = require.cache[canvasId];
    require.cache[canvasId] = {
      id: canvasId,
      filename: canvasId,
      loaded: true,
      exports: { loadImage: async () => ({ width: 100, height: 80 }) },
    };
    globalThis.fetch = async () => ({
      ok: true,
      status: 200,
      headers: { get: () => "image/jpeg" },
      arrayBuffer: async () => jpeg,
    });
    mock.method(fileStorage, "saveFileAs", async (_buffer, folder, fileName) => {
      const relativePath = `${folder}/${fileName}`;
      uploads.push(relativePath);
      return {
        secure_url: `/content/${relativePath}`,
        url: `/content/${relativePath}`,
        public_id: relativePath,
        fileName,
        contentType: "image/jpeg",
      };
    });
    mock.method(fileStorage, "moveFile", async () => {
      throw new Error("La URL remota no se mueve: se descarga y se sube.");
    });

    try {
      const remote = {
        url: "https://res.example.com/image/upload/v1/noticias_adjuntos/ppoltxqszsvcqgowixqd.jpg",
        public_id: "noticias_adjuntos/ppoltxqszsvcqgowixqd",
        nombre: "circular.jpg",
        tipo: "image",
      };

      const result = await attachmentProcessor.persistNewsMedia({
        noticiaId: 11,
        previousAttachments: [remote],
        previousCover:
          "https://res.example.com/image/upload/v1/noticias_adjuntos/hy5omtub7xfofswde0qs.jpg",
        planRaw: JSON.stringify([{ public_id: remote.public_id, url: remote.url }]),
        files: [],
        coverFile: null,
        keepCoverUrl:
          "https://res.example.com/image/upload/v1/noticias_adjuntos/hy5omtub7xfofswde0qs.jpg",
      });

      assert.ok(uploads.includes("noticias_adjuntos/11_1.jpg"));
      assert.ok(uploads.includes("noticias_adjuntos/11_portada.jpg"));
      assert.equal(result.image, "/content/noticias_adjuntos/11_portada.jpg");
      const items = JSON.parse(result.attachments);
      assert.equal(items[0].public_id, "noticias_adjuntos/11_1.jpg");
      assert.equal(items[0].name, "circular.jpg");
      assert.equal(items[0].kind, "image");
    } finally {
      globalThis.fetch = originalFetch;
      if (previousCanvas) require.cache[canvasId] = previousCanvas;
      else delete require.cache[canvasId];
    }
  });
});
