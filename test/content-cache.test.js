const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { Readable } = require("node:stream");

const {
  createContentCache,
  readStreamToBuffer,
} = require("../src/services/storage/contentCache");

async function tempCache(maxBytes) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "content-cache-"));
  return {
    directory,
    cache: createContentCache({ directory, maxBytes }),
  };
}

describe("caché local de fotos de evento", () => {
  it("guarda el archivo y lo devuelve sin volver a pedirlo", async () => {
    const { directory, cache } = await tempCache(1024 * 1024);
    let calls = 0;
    const first = await cache.load("eventos/slug/foto.jpg", async () => {
      calls += 1;
      return { buffer: Buffer.from("jpeg"), contentType: "image/jpeg", etag: "abc" };
    });
    const second = await cache.load("eventos/slug/foto.jpg", async () => {
      calls += 1;
      return { buffer: Buffer.from("otro"), contentType: "image/jpeg" };
    });

    assert.equal(calls, 1);
    assert.equal(first.size, 4);
    assert.equal(second.filePath, first.filePath);
    assert.equal(second.etag, "abc");
    assert.equal(await fs.readFile(first.filePath, "utf8"), "jpeg");
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("comparte una sola descarga si dos pedidos llegan juntos", async () => {
    const { directory, cache } = await tempCache(1024 * 1024);
    let calls = 0;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const producer = async () => {
      calls += 1;
      await gate;
      return { buffer: Buffer.from("foto"), contentType: "image/jpeg" };
    };
    const pending = Promise.all([
      cache.load("eventos/slug/junta.jpg", producer),
      cache.load("eventos/slug/junta.jpg", producer),
    ]);
    release();
    const [left, right] = await pending;
    assert.equal(calls, 1);
    assert.equal(left.filePath, right.filePath);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("olvida una foto y todo un evento", async () => {
    const { directory, cache } = await tempCache(1024 * 1024);
    await cache.store("eventos/uno/a.jpg", {
      buffer: Buffer.from("aaa"),
      contentType: "image/jpeg",
    });
    await cache.store("eventos/uno/b.jpg", {
      buffer: Buffer.from("bbb"),
      contentType: "image/jpeg",
    });
    await cache.store("eventos/dos/c.jpg", {
      buffer: Buffer.from("ccc"),
      contentType: "image/jpeg",
    });

    await cache.forget("eventos/uno/a.jpg");
    assert.equal(await cache.peek("eventos/uno/a.jpg"), null);
    assert.ok(await cache.peek("eventos/uno/b.jpg"));

    await cache.forgetPrefix("eventos/uno");
    assert.equal(await cache.peek("eventos/uno/b.jpg"), null);
    assert.ok(await cache.peek("eventos/dos/c.jpg"));
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("suelta lo más viejo cuando pasa el tope", async () => {
    const { directory, cache } = await tempCache(30);
    const first = await cache.store("eventos/slug/vieja.jpg", {
      buffer: Buffer.alloc(20, 1),
      contentType: "image/jpeg",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await cache.store("eventos/slug/nueva.jpg", {
      buffer: Buffer.alloc(20, 2),
      contentType: "image/jpeg",
    });

    assert.equal(await cache.peek("eventos/slug/vieja.jpg"), null);
    assert.equal((await cache.peek("eventos/slug/nueva.jpg")).size, 20);
    assert.ok(first);
    assert.ok(second);
    await fs.rm(directory, { recursive: true, force: true });
  });

  it("junta un stream en un buffer", async () => {
    const buffer = await readStreamToBuffer(Readable.from([Buffer.from("ab"), Buffer.from("cd")]));
    assert.equal(buffer.toString(), "abcd");
  });
});
