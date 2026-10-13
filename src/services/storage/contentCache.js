// Caché en disco de las fotos de evento que ya se bajaron de Storage.
//
// El navegador de cada persona pide /content y el servidor, sin esto, vuelve
// a Supabase. Esas repeticiones salen de la CDN y cuentan como Cached Egress.
// El nombre del archivo no cambia, así que el objeto se puede reutilizar.

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { normalizeRelativePath } = require("./storagePath");

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;

function createContentCache(options = {}) {
  const directory =
    options.directory || path.join(os.tmpdir(), "intranet-event-content-cache");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const inflight = new Map();

  function pathsFor(relativePath) {
    const key = crypto
      .createHash("sha256")
      .update(normalizeRelativePath(relativePath))
      .digest("hex");
    return {
      data: path.join(directory, `${key}.bin`),
      meta: path.join(directory, `${key}.json`),
    };
  }

  async function peek(relativePath) {
    const paths = pathsFor(relativePath);
    try {
      const meta = JSON.parse(await fs.readFile(paths.meta, "utf8"));
      const stat = await fs.stat(paths.data);
      if (!stat.isFile() || stat.size !== meta.size) return null;
      const now = new Date();
      await fs.utimes(paths.data, now, now).catch(() => {});
      return {
        filePath: paths.data,
        contentType: meta.contentType || "application/octet-stream",
        size: stat.size,
        etag: meta.etag || null,
        lastModified: meta.lastModified || stat.mtime.toUTCString(),
      };
    } catch {
      return null;
    }
  }

  async function evict() {
    let names;
    try {
      names = await fs.readdir(directory);
    } catch {
      return;
    }
    const files = [];
    let total = 0;
    for (const name of names) {
      if (!name.endsWith(".bin")) continue;
      const dataPath = path.join(directory, name);
      try {
        const stat = await fs.stat(dataPath);
        if (!stat.isFile()) continue;
        files.push({
          dataPath,
          metaPath: dataPath.replace(/\.bin$/, ".json"),
          mtimeMs: stat.mtimeMs,
          size: stat.size,
        });
        total += stat.size;
      } catch {
        // Otro proceso pudo borrarlo entre el listado y el stat.
      }
    }
    files.sort((left, right) => left.mtimeMs - right.mtimeMs);
    for (const file of files) {
      if (total <= maxBytes) break;
      await fs.unlink(file.dataPath).catch(() => {});
      await fs.unlink(file.metaPath).catch(() => {});
      total -= file.size;
    }
  }

  async function store(relativePath, payload) {
    if (!payload?.buffer?.length) return null;
    await fs.mkdir(directory, { recursive: true });
    const paths = pathsFor(relativePath);
    const tmp = `${paths.data}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    const meta = {
      relativePath: normalizeRelativePath(relativePath),
      contentType: payload.contentType || "application/octet-stream",
      size: payload.buffer.length,
      etag: payload.etag || null,
      lastModified: payload.lastModified || new Date().toUTCString(),
      storedAt: Date.now(),
    };
    await fs.writeFile(tmp, payload.buffer);
    await fs.unlink(paths.data).catch(() => {});
    await fs.rename(tmp, paths.data);
    await fs.writeFile(paths.meta, JSON.stringify(meta));
    await evict();
    try {
      await fs.stat(paths.data);
    } catch {
      return null;
    }
    return {
      filePath: paths.data,
      contentType: meta.contentType,
      size: meta.size,
      etag: meta.etag,
      lastModified: meta.lastModified,
    };
  }

  async function forget(relativePath) {
    if (!relativePath) return;
    const paths = pathsFor(relativePath);
    await fs.unlink(paths.data).catch(() => {});
    await fs.unlink(paths.meta).catch(() => {});
  }

  function matchesPrefix(relativePath, prefix) {
    const clean = normalizeRelativePath(prefix).replace(/\/+$/, "");
    if (!clean) return false;
    return relativePath === clean || relativePath.startsWith(`${clean}/`);
  }

  async function forgetPrefix(prefix) {
    let names;
    try {
      names = await fs.readdir(directory);
    } catch {
      return;
    }
    await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map(async (name) => {
          const metaPath = path.join(directory, name);
          try {
            const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
            if (matchesPrefix(meta.relativePath, prefix)) {
              await forget(meta.relativePath);
            }
          } catch {
            // Meta a medias: no impide borrar el resto.
          }
        }),
    );
  }

  async function load(relativePath, producer) {
    const key = normalizeRelativePath(relativePath);
    const pending = inflight.get(key);
    if (pending) return pending;

    const job = (async () => {
      const hit = await peek(relativePath);
      if (hit) return hit;
      const produced = await producer();
      if (!produced?.buffer?.length) return null;
      return store(relativePath, produced);
    })().finally(() => {
      inflight.delete(key);
    });
    inflight.set(key, job);
    return job;
  }

  return { peek, store, forget, forgetPrefix, load, directory };
}

async function readStreamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const defaultCache = createContentCache();

module.exports = {
  createContentCache,
  readStreamToBuffer,
  peek: (relativePath) => defaultCache.peek(relativePath),
  forget: (relativePath) => defaultCache.forget(relativePath),
  forgetPrefix: (prefix) => defaultCache.forgetPrefix(prefix),
  load: (relativePath, producer) => defaultCache.load(relativePath, producer),
};
