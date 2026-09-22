const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const fileStorage = require("../src/services/fileStorage");
const {
  eventSlugFromContentPath,
  isPrivateFlag,
  hasPrivacyField,
  eventVisibleTo,
} = require("../src/utils/eventAccess");

const FAKE_CONFIG = Object.freeze({
  url: "https://example.supabase.co",
  key: "test-key",
  bucket: "intranet-content",
  maxFileSizeBytes: 1024 * 1024,
  tusThresholdBytes: 6 * 1024 * 1024,
  tusChunkSizeBytes: 6 * 1024 * 1024,
  listPageSize: 100,
  deleteBatchSize: 1000,
});

function buckets(handlers) {
  return {
    storageConfig: FAKE_CONFIG,
    createService: ({ config }) => handlers(config.bucket),
  };
}

describe("galería compartida — visibilidad", () => {
  it("un evento público se ve en los dos países", () => {
    const event = { is_private: false, country_code: "CL" };
    assert.equal(eventVisibleTo(event, "CL"), true);
    assert.equal(eventVisibleTo(event, "PE"), true);
  });

  it("un evento privado solo se ve en el país que lo creó", () => {
    const event = { is_private: true, country_code: "PE" };
    assert.equal(eventVisibleTo(event, "PE"), true);
    assert.equal(eventVisibleTo(event, "CL"), false);
  });

  it("lee el interruptor, también si el hidden y el checkbox llegan juntos", () => {
    assert.equal(isPrivateFlag("0"), false);
    assert.equal(isPrivateFlag("1"), true);
    assert.equal(isPrivateFlag(["0", "1"]), true);
    assert.equal(isPrivateFlag(undefined), false);
    assert.equal(hasPrivacyField({ name: "Aniversario" }), false);
    assert.equal(hasPrivacyField({ is_private: "0" }), true);
  });

  it("saca el slug de una ruta de la galería y no de otras carpetas", () => {
    assert.equal(eventSlugFromContentPath("eventos/aniversario/foto.jpg"), "aniversario");
    assert.equal(eventSlugFromContentPath("apps_icons/logo.png"), null);
    assert.equal(eventSlugFromContentPath("eventos/"), null);
  });
});

describe("galería compartida — archivos en ambos buckets", () => {
  it("junta las fotos del evento que están en Chile y en Perú", async () => {
    const listed = [];
    const files = await fileStorage.listFiles(
      "eventos/aniversario",
      {},
      buckets((bucket) => ({
        async listFilesInFolder(folder) {
          listed.push(`${bucket}:${folder}`);
          if (bucket === "intranet-content") {
            return [
              {
                relativePath: "eventos/aniversario/chile.jpg",
                name: "chile.jpg",
                created_at: "2026-01-02T00:00:00.000Z",
              },
            ];
          }
          return [
            {
              relativePath: "eventos/aniversario/peru.jpg",
              name: "peru.jpg",
              created_at: "2026-03-01T00:00:00.000Z",
            },
          ];
        },
      })),
    );

    assert.deepEqual(listed.sort(), [
      "intranet-content-pe:eventos/aniversario",
      "intranet-content:eventos/aniversario",
    ]);
    assert.deepEqual(
      files.map((file) => file.name),
      ["peru.jpg", "chile.jpg"],
    );
  });

  it("sirve una foto de evento desde el bucket del otro país", async () => {
    const tried = [];
    const result = await fileStorage.streamStoredObject(
      "eventos/aniversario/peru.jpg",
      {},
      buckets((bucket) => ({
        async downloadStream(relativePath) {
          tried.push(`${bucket}:${relativePath}`);
          if (bucket === "intranet-content") {
            const err = new Error("Object not found");
            err.statusCode = 400;
            throw err;
          }
          return { stream: "desde-peru", relativePath };
        },
      })),
    );

    assert.deepEqual(tried, [
      "intranet-content:eventos/aniversario/peru.jpg",
      "intranet-content-pe:eventos/aniversario/peru.jpg",
    ]);
    assert.equal(result.stream, "desde-peru");
  });

  it("borra el archivo en el bucket donde está e ignora el otro", async () => {
    const removed = [];
    const ok = await fileStorage.deleteFile(
      "eventos/aniversario/foto.jpg",
      buckets((bucket) => ({
        async deleteFile(relativePath) {
          removed.push(`${bucket}:${relativePath}`);
          if (bucket === "intranet-content") {
            const err = new Error("Object not found");
            err.statusCode = 404;
            throw err;
          }
          return true;
        },
      })),
    );

    assert.equal(ok, true);
    assert.equal(removed.length, 2);
  });

  it("borra la carpeta del evento en los dos buckets", async () => {
    const removed = [];
    const ok = await fileStorage.deleteFolder(
      "eventos/aniversario",
      buckets((bucket) => ({
        async deleteFolder(folder) {
          removed.push(`${bucket}:${folder}`);
          return bucket === "intranet-content-pe";
        },
      })),
    );

    assert.equal(ok, true);
    assert.deepEqual(removed.sort(), [
      "intranet-content-pe:eventos/aniversario",
      "intranet-content:eventos/aniversario",
    ]);
  });
});
