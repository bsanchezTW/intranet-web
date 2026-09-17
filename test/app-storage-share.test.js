const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const fileStorage = require("../src/services/fileStorage");

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

describe("fileStorage — catálogo de apps en ambos países", () => {
  it("sube el mismo objeto a los dos buckets", async () => {
    const uploads = [];
    const result = await fileStorage.saveFileInAllCountryBuckets(
      Buffer.from("icon"),
      "apps_icons",
      "logo.png",
      {},
      {
        storageConfig: FAKE_CONFIG,
        createService: ({ config }) => ({
          async uploadFile(_buffer, relativePath) {
            uploads.push(`${config.bucket}:${relativePath}`);
            return { path: relativePath, storageId: relativePath };
          },
          async deleteFile() {
            return true;
          },
        }),
      },
    );

    assert.equal(uploads.length, 2);
    const [chilePath, peruPath] = uploads.map((entry) => entry.split(":")[1]);
    assert.equal(uploads[0].startsWith("intranet-content:"), true);
    assert.equal(uploads[1].startsWith("intranet-content-pe:"), true);
    assert.equal(chilePath, peruPath);
    assert.match(chilePath, /^apps_icons\/logo-\d+-[a-f0-9]+\.png$/);
    assert.equal(result.secure_url, `/content/${chilePath}`);
  });

  it("revierte el primer bucket si el segundo falla", async () => {
    const deleted = [];
    await assert.rejects(
      () =>
        fileStorage.saveFileInAllCountryBuckets(
          Buffer.from("icon"),
          "apps_icons",
          "logo.png",
          {},
          {
            storageConfig: FAKE_CONFIG,
            createService: ({ config }) => ({
              async uploadFile(_buffer, relativePath) {
                if (config.bucket === "intranet-content-pe") {
                  throw new Error("bucket pe caído");
                }
                return { path: relativePath };
              },
              async deleteFile(relativePath) {
                deleted.push(`${config.bucket}:${relativePath}`);
                return true;
              },
            }),
          },
        ),
      /bucket pe caído/,
    );
    assert.equal(deleted.length, 1);
    assert.equal(deleted[0].startsWith("intranet-content:"), true);
  });

  it("borra la misma ruta en los dos buckets", async () => {
    const removed = [];
    const result = await fileStorage.deleteFilesInAllCountryBuckets(
      ["/content/apps_icons/logo.png", "/content/apps_icons/logo.png"],
      {
        storageConfig: FAKE_CONFIG,
        createService: ({ config }) => ({
          async deleteFile(relativePath) {
            removed.push(`${config.bucket}:${relativePath}`);
            return true;
          },
        }),
      },
    );

    assert.deepEqual(result.paths, ["apps_icons/logo.png"]);
    assert.equal(result.deleted, 2);
    assert.deepEqual(removed, [
      "intranet-content:apps_icons/logo.png",
      "intranet-content-pe:apps_icons/logo.png",
    ]);
  });

  it("sirve un icono de app desde el bucket del otro país si falta en el propio", async () => {
    const tried = [];
    const result = await fileStorage.streamStoredObject(
      "apps_icons/icono-app-1786376740989-106c1a21.jpg",
      {},
      {
        storageConfig: { ...FAKE_CONFIG, bucket: "intranet-content-pe" },
        createService: ({ config }) => ({
          async downloadStream(relativePath) {
            tried.push(`${config.bucket}:${relativePath}`);
            if (config.bucket === "intranet-content-pe") {
              const err = new Error("Object not found");
              err.statusCode = 400;
              throw err;
            }
            return { stream: "from-chile", relativePath };
          },
        }),
      },
    );

    assert.deepEqual(tried, [
      "intranet-content-pe:apps_icons/icono-app-1786376740989-106c1a21.jpg",
      "intranet-content:apps_icons/icono-app-1786376740989-106c1a21.jpg",
    ]);
    assert.equal(result.stream, "from-chile");
  });
});
